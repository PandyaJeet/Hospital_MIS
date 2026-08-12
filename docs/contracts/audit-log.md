# Contract: Audit Log

**Phase 4.** "Who changed what, for compliance" (`phases.md`).

The one thing to understand before using it: **`changes` records field NAMES always,
and field VALUES only for an allow-list of non-personal columns.** Clinical content,
patient details, invite emails and tokens are never stored here. §3 explains why, and
it is a design decision rather than an omission.

---

## 1. Table: `audit_log`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | Always taken from the audited row server-side |
| `actor_id` | `uuid` null | NULL for a system/trigger/service-role change |
| `actor_role` | `text` null | The actor's role **at the time**, snapshotted |
| `actor_is_system` | `boolean not null` | Positive signal so you never interpret a NULL |
| `action` | `text` | Dotted vocabulary — see §2. Treat as an API |
| `table_name` | `text` | |
| `row_id` | `uuid` null | The row that changed |
| `changes` | `jsonb not null` | Per-field diff — see §3 |
| `created_at` | `timestamptz` | |

`actor_role` is snapshotted because roles change: an audit line saying "a doctor did
this" must not silently become "an admin did this" when that person is later promoted.

`actor_id` is deliberately **not** a foreign key. An audit row must outlive the profile
it refers to; cross-tenant integrity comes from `tenant_id` being derived server-side
rather than from a constraint.

### Client access

| Operation | Who |
|---|---|
| `select` | **admin only**, within their own tenant |
| `insert` / `update` / `delete` | **nobody — `42501`** |

There is no write path at all. Rows arrive only from `SECURITY DEFINER` triggers. A log
a user can write is not a log — the same discipline as `tasks.is_auto` and
`lab_results.is_critical`.

Admin-only reads because this is oversight data about staff. A doctor being able to see
who changed whose role is a different and unrequested thing; PRD §6.5 puts user
provisioning with the admin.

---

## 2. Actions covered in this phase

| `action` | Fires on |
|---|---|
| `user.role_changed` | `profiles.role` changed |
| `user.deactivated` / `user.reactivated` | `profiles.is_active` changed |
| `user.joined_tenant` | `profiles.tenant_id` went NULL → set |
| `user.tenant_changed` | `profiles.tenant_id` changed between clinics |
| `invite.created` | Invite minted |
| `invite.accepted` | Invite redeemed |
| `invite.reissued` | A lapsed invite got a rotated token (the old link died) |
| `invite.revoked` | Invite deleted before use |
| `tenant.created` | Clinic founded |
| `tenant.settings_changed` | Name, tier, GST registration, GSTIN, state code or default fee changed |

**Not audited this phase:** every clinical and billing write — notes, prescriptions,
vitals, medication administrations, lab results, invoices. Scoped down deliberately;
see §6.

Note that **an ordinary profile edit produces no row at all.** A `full_name` change is
not a compliance fact, and logging it would bury the events that are.

### `tier` changes usually log as system events

`tenants.tier` is not client-writable, so it is set by the platform owner via the
dashboard or a service-role script — which means `actor_is_system: true` and
`actor_id: null`. That is correct, and it is exactly the distinction
`actor_is_system` exists to make.

---

## 3. ⚠️ What `changes` contains — the PII boundary

Two shapes, and only two:

```jsonc
// Allow-listed field: value recorded
{ "role": { "from": "doctor", "to": "nurse" } }

// Everything else: field name recorded, content dropped
{ "full_name": { "changed": true, "redacted": true } }
```

`redacted: true` is explicit so a reader can never mistake an absent value for an
empty one.

### The allow-list

Values are recorded only for these, and every one is a fact about clinic
configuration or a person's access rights — never about a patient, never free text
authored by a clinician:

| Table | Fields whose values are recorded |
|---|---|
| `profiles` | `role`, `is_active`, `tenant_id`, `deactivated_at` |
| `tenants` | `name`, `tier`, `gst_registered`, `gstin`, `gst_state_code`, `default_consultation_fee` |
| `invites` | `role`, `expires_at`, `accepted_at`, `accepted_by` |

**Excluded on purpose, and worth knowing why:**

- `invites.email` — personal data. It is already on the `invites` row for anyone
  authorised to look; a second copy in a permanent table buys nothing.
- `invites.token` — a live capability. Copying it into a longer-lived, differently
  guarded table would extend its blast radius.
- Everything on every clinical table. Any table not in the list above allow-lists
  **nothing**, so **the default is redaction** — a column added to an audited table is
  redacted automatically rather than leaking until someone remembers to exclude it.

### Why content is excluded even though an admin can read `clinical_notes`

The obvious objection: an admin can already read notes, so what does keeping note text
out of an admin-readable table protect? Three things, and the first decides it:

1. **An audit log is permanent; a record is not.** Notes get corrected, patients get
   merged, data gets erased. DPDP alignment (PRD §7) includes correction and erasure. A
   `changes` blob holding the prior text of every clinical edit is an un-erasable shadow
   copy of exactly the data those obligations cover — in a table nobody thinks of when
   honouring a deletion request. Logging *that* a note changed satisfies the compliance
   requirement without creating the liability.
2. **It is a second, less-guarded copy.** The clinical tables carry differentiated
   policies (billing cannot read `clinical_notes`, `vitals`, `lab_results`). Any future
   widening of audit access — a support view, an export, a metrics job — would carry PHI
   with it. Keeping content out means that class of mistake cannot happen.
3. **Unbounded growth of the most sensitive content**, serving no clinical purpose.

`rules.md` §1.3 bans logging PII/PHI to "console, error trackers, or analytics". An
audit table is none of those literally, so this applies the rule's intent.

### `_audit_note`

A reserved key. If the trigger could not identify the actor, `changes` carries
`{"_audit_note": "actor resolution failed (SQLSTATE …)"}` and the row is still written
with `actor_is_system: true`. Nothing is lost and nothing is silently swallowed — the
event is recorded, and the reason is recoverable. An audit trigger that could abort the
transaction it observes would make the log a liability, so it never raises.

---

## 4. Queries

```ts
// The audit trail
const { data } = await supabase
  .from('audit_log')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(100);

// Everything that happened to one user
.eq('table_name', 'profiles').eq('row_id', userId)

// One kind of event
.eq('action', 'user.role_changed')

// What did this person do (a leaver review)
.eq('actor_id', userId)
```

All four are indexed. There is no RPC — plain reads under RLS.

---

## 5. TypeScript for the mock layer

```ts
export type AuditAction =
  | 'user.role_changed' | 'user.deactivated' | 'user.reactivated'
  | 'user.joined_tenant' | 'user.tenant_changed'
  | 'invite.created' | 'invite.accepted' | 'invite.reissued' | 'invite.revoked'
  | 'tenant.created' | 'tenant.settings_changed';

/** A recorded value change. Present only for allow-listed fields. */
export interface AuditFieldChange { from: unknown; to: unknown }
/** A change whose content was deliberately not recorded. */
export interface AuditFieldRedacted { changed: true; redacted: true }

export type AuditChanges =
  Record<string, AuditFieldChange | AuditFieldRedacted> & { _audit_note?: string };

export interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_role: 'pending' | 'admin' | 'doctor' | 'nurse' | 'billing' | 'patient' | null;
  actor_is_system: boolean;
  action: AuditAction;
  table_name: string;
  row_id: string | null;
  changes: AuditChanges;
  created_at: string;
}

/** Narrowing helper — a redacted entry has no value to render. */
export function isRedacted(c: AuditFieldChange | AuditFieldRedacted): c is AuditFieldRedacted {
  return (c as AuditFieldRedacted).redacted === true;
}
```

Render a redacted entry as "*(field) was changed*" with no value. Do not print
`undefined`.

---

## 6. Deliberately not in Phase 4

| Not available | Why |
|---|---|
| **Auditing clinical/billing writes** | A much larger job: it needs a retention story (a per-write log on `vitals` grows faster than `vitals`), the redaction boundary judged for ~15 more tables, and several of those are already append-only so a change log would mostly restate them |
| **Retention / archival** | The table grows without bound. No pruning, no partitioning. Needs a policy decision before pilot — flagged in `Memory.md` §6 |
| **Read auditing** | Only writes are logged. "Who *viewed* this record" is a genuine DPDP-adjacent question and is not answered |
| **Tamper evidence** | Append-only by privilege, not cryptographically. A service-role actor could alter history |
| **Export** | No CSV/report endpoint |
| **A reason/justification field** | See `user-management.md` §6 |

---

## 7. Verification status

| Suite | Command | Result |
|---|---|---|
| Local Phase 4 | `npm run test:phase4` | **211/211** |
| Hosted catalogue | `npm run verify:catalog` | **93/93** |

Covered here specifically: deactivation and reactivation both logged with the correct
action, actor and snapshotted role, and `is_active` recorded from/to; a role change
logged with from/to; **the invitee email and the invite token are asserted absent from
the audit row** while the granted role is present; an ordinary `full_name` edit
produces no row at all; `audit_diff()` unit-tested directly to confirm it records
`role` and `is_active` but redacts `full_name`, and that an un-allow-listed table
redacts **everything** while still naming the changed field; invite accepted and
`user.joined_tenant` logged; a GST registration change logged with from/to; INSERT,
UPDATE and DELETE all refused with `42501`; doctor, nurse and billing each see zero
rows; an owner-context write recorded with `actor_id: null` and
`actor_is_system: true`; and a negative control confirming a non-admin's zero-row
result depends on RLS.
