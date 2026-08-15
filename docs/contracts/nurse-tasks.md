# Contract: Nurse Task Board & Medication Administration

**Phase 3.** The kanban task board, and the barcode/QR medication-administration
check.

Two headlines:

1. **There is no scheduler.** Tasks have a flat `due_at`. "Vitals every 4 hours" is
   not built. §2.
2. **Medication administration validates the patient server-side, and the three
   failure modes are three different codes.** `PATIENT_MISMATCH` is not the same as
   `PATIENT_CODE_UNRECOGNISED` is not the same as `SCAN_REQUIRED`. §6.

Verified against the hosted project. See §10.

---

## 1. Table: `tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | Pinned by RLS |
| `visit_id` | `uuid` | Composite FK `(visit_id, tenant_id)` → `visits` |
| `task_type` | `text` | `vitals_due` \| `medication_due` \| `sample_collection_due` \| `custom` |
| `title` | `text` null | Card label. **Required when `task_type = 'custom'`** |
| `status` | `text` | `pending` \| `done` \| `cancelled`. **Not client-writable** |
| `due_at` | `timestamptz` | Defaults to `now()`. Client-writable (rescheduling) |
| `assigned_to` | `uuid` null | **NULL = unclaimed, and that is normal.** Client-writable |
| `completed_by` / `completed_at` | | **Not client-writable** — stamped by `complete_task()` |
| `cancellation_reason` | `text` null | Set by `cancel_task()` |
| `is_auto` | `boolean` | Did a trigger create it? **Not client-writable** |
| `source_type` / `source_id` | | `admission` → visit id, `lab_order` → order id. **Not client-writable** |
| `notes` | `text` null | Client-writable |
| `created_by` | `uuid` null | Client-writable |
| `created_at` / `updated_at` | `timestamptz` | |

### `title` is required for `custom` only

A custom task with no label is not an incomplete row, it is a meaningless one — the
same reasoning Phase 2 applied to `prescription_items.drug_name`. The label *is* the
task. Every other `task_type` is self-describing, so derive a label from the type in
the UI.

Sending a `custom` task with no title fails with `23514`.

### `assigned_to` NULL is the normal state

An unclaimed, role-based task ("someone take bed 4's vitals") is the common case on a
shared ward board. Nurses claim by setting `assigned_to` — that is a plain update and
one of the few lifecycle fields you may write directly.

Claiming is deliberately **not** restricted to the creator, and any clinical staff
member may reschedule or annotate any task in their clinic. A ward board is shared
work; "only the nurse who made the card may touch it" breaks the moment a shift
changes.

### Client access

| Operation | Who | Notes |
|---|---|---|
| `select` | admin, doctor, nurse | **Not billing** — a card naming a lab test is clinical context the front desk has no use for |
| `insert` | admin, doctor, nurse | A doctor asking a nurse to do something is ordinary |
| `update` | admin, doctor, nurse | Only `title`, `due_at`, `assigned_to`, `notes` |
| `delete` | **nobody** | `42501`. Cancel instead, so the board keeps a record |

Writing `status`, `is_auto`, `completed_by`, `completed_at`, `source_type` or
`source_id` returns `42501`. Each matters: a forged `is_auto` would let a hand-made
card masquerade as system-generated, and a forged `source_id` could squat the
idempotency slot of a real auto task, **suppressing a genuine "vitals due" card from
ever appearing**.

---

## 2. ⚠️ No recurrence engine — a deliberate gap

"Vitals every 4 hours for an admitted patient" is a real requirement and it is **not
built**. A scheduler needs a recurrence rule per task, a generator that materialises
occurrences, a catch-up policy for downtime, and a story for what happens to future
occurrences on discharge. That is disproportionate to a phase whose job is to make
the board real.

What exists instead: a flat `due_at`, and exactly **two** one-shot triggers.

| Trigger | Creates | Idempotency |
|---|---|---|
| Admission (`visits.admitted_at` null → set) | one `vitals_due` task, `title` = "Baseline vitals on admission", `due_at` = admission time | `source_type='admission'`, `source_id` = visit id |
| Lab order insert | one `sample_collection_due` task, `title` = "Collect sample — {test}" + " (URGENT/STAT)" when not routine | `source_type='lab_order'`, `source_id` = order id |

Both are idempotent via a partial unique index on
`(tenant_id, source_type, source_id, task_type)`. A re-fired trigger cannot duplicate
a card — a duplicated card on a triage board costs a nurse real time.

**Everything else is created by hand.** If recurring observations matter for the
pilot, that is a Phase 4+ conversation, not something to fake in the client by
minting tasks on a timer.

`due_at` is `now()` for every lab priority. That is not an oversight: with no
scheduler, inventing "routine means due in 4 hours" would be the system asserting a
turnaround policy no clinic has told it. Priority goes on the **card label** for a
human to triage, which is what `Design.md` §8 says the board is for.

---

## 3. The board query

`Design.md` §8: card/kanban, not a data table; quick visual triage of what is due.

```ts
const { data } = await supabase
  .from('tasks')
  .select('*')
  .eq('status', 'pending')
  .order('due_at', { ascending: true });
```

Backed by an index on `(tenant_id, status, due_at)`, so grouping by status is cheap.
Two more indexes exist: `(visit_id, status, due_at)` for the per-patient card list,
and a partial one on `(tenant_id, assigned_to, status, due_at)` for "my tasks".

Overdue is `due_at < now()` — computed at read time, never stored, same reasoning as
wait time in `opd-queue.md` §2.

---

## 4. `complete_task()` / `cancel_task()`

The only sanctioned writers of `tasks.status`. Envelope-returning.

```ts
await supabase.rpc('complete_task', { p_task_id: id, p_notes: 'Dressing changed' });
await supabase.rpc('cancel_task',   { p_task_id: id, p_reason: 'Not required' });
```

`completed_by` and `completed_at` are stamped server-side from `auth.uid()` and
`now()`. Do not send them.

Legal moves: `pending → done | cancelled`. Both terminal.

| Response | Meaning |
|---|---|
| `{ ok: true, status: 'done', task_type }` | Completed |
| `{ ok: true, status: 'cancelled', changed: true }` | Cancelled |
| `{ ok: true, status: 'cancelled', changed: false }` | Already cancelled — **success, idempotent** |
| `{ ok: false, code: 'TASK_ALREADY_DONE' }` | Re-completing, or cancelling a done task |
| `{ ok: false, code: 'TASK_CANCELLED' }` | Completing a cancelled task |
| `{ ok: false, code: 'TASK_NOT_FOUND' }` | Unknown id **or another clinic's** — same answer either way, so it cannot be used to probe |
| `{ ok: false, code: 'NOT_CLINICAL_STAFF' }` | Billing or patient role |

---

## 5. Auto-completion you should know about

**Recording vitals closes the oldest pending `vitals_due` task for that visit**,
attributed to the recording nurse, with `completed_at` = the observation time.

Recording the observation *is* doing the task, and `Design.md` §8 asks for select/tap
over typing — making the nurse tick a second card works against that, and a board
full of stale cards that were in fact done is worse than no board.

Scope is narrow, on purpose: INSERT only (a correction is not a new observation), one
task (not all of them), and whatever the card's origin (a hand-added `vitals_due`
card is satisfied by the same act).

**So do not assume a task you are showing is still pending after a vitals save** —
re-read, or rely on the Realtime event.

Similarly, `sample_collected` and recording a lab result both close the pending
`sample_collection_due` card for that order. See `lab-orders.md`.

Medication administration does **not** auto-close a `medication_due` task —
administrations are logged against a prescription *item*, and tasks are not linked to
items. Noted as a gap in §9.

---

## 6. Table: `medication_administrations`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | |
| `prescription_item_id` | `uuid` | Composite FK → `prescription_items` |
| `visit_id` | `uuid` | Derived server-side from the item, not accepted from you |
| `administered_by` | `uuid` | Always the caller |
| `administered_at` | `timestamptz` | |
| `status` | `text` | `given` \| `refused` \| `held` |
| `notes` | `text` null | |
| `scan_basis` | `text` | `patient_id` \| `patient_number` — how the code resolved |
| `created_at` | `timestamptz` | |

`refused` and `held` are not failures to record — they are clinically important
events. A patient declining a dose, or a nurse withholding one pending review, must
both be documented, and "no row" cannot express the difference between those and a
dose nobody got round to.

### Client access

| Operation | Who |
|---|---|
| `select` | admin, doctor, nurse (**not billing**) |
| `insert` / `update` / `delete` | **nobody — `42501`** |

**There is no client INSERT, and that is the whole point.** The right-patient check
must not be bypassable by a direct PostgREST call. Everything goes through the RPC.

The log is append-only. A mistaken entry cannot currently be corrected or voided —
a `voided` status plus an amendment reason belongs with the Phase 4 audit log. Flagged
in §9.

`scan_basis` records *that* the check happened and in what form. The raw scanned
payload is never stored.

---

## 7. `record_medication_administration()`

```ts
const { data } = await supabase.rpc('record_medication_administration', {
  p_prescription_item_id: itemId,
  p_scanned_patient_code: scannedString,   // REQUIRED
  p_status: 'given',                       // given | refused | held
  p_notes: null,
  p_allow_repeat: false,
});
```

The scanner, camera permission and decoding are entirely yours — a scan is just a
string by the time it reaches the database. What the server owns is the part that
makes the scan *mean* something.

### Accepted code formats

Either, so you can encode whichever suits the band printer:

- the patient `uuid` (`patients.id`)
- the human UHID (`patients.patient_number`), with or without prefix/punctuation —
  `12`, `UHID-12`, `P/12` all resolve

Both are resolved **within your tenant only**, so a band from another clinic cannot
resolve at all.

### The three failures are three codes

| Code | Meaning | UI treatment |
|---|---|---|
| `PATIENT_MISMATCH` | The code resolved to a real patient, and it is **not** this prescription's patient | **Interrupt hard.** Modal, not a toast. Returns `requires_acknowledgement: true` |
| `PATIENT_CODE_UNRECOGNISED` | The code resolved to nobody — smudged band, band from elsewhere, mis-decode | "Re-scan or verify manually." **Not** a pass |
| `SCAN_REQUIRED` | No code supplied at all | Block the action; prompt to scan |

All three return `patient_verified: false`. Do not collapse them into one "could not
save" message — a wrong-patient event is the error class barcode administration
exists to catch, and an unreadable scan is emphatically not the same as a verified
one (`rules.md` §3.4).

**`PATIENT_MISMATCH` deliberately names neither patient.** No name, no id, no UHID of
either. The nurse is at the wrong bedside; the remedy is to stop, not to be handed a
second patient's identity.

### Duplicate doses: detected, reported, overridable

A unique constraint would be *wrong*, not strict. `prescription_items.frequency` is
free text (`'TDS'`), so one item legitimately means several doses a day.

So a prior `given` administration of the same item returns:

```jsonc
{
  "ok": false,
  "code": "ALREADY_ADMINISTERED",
  "patient_verified": true,          // the safety check still PASSED
  "previous_administration": { "id": "…", "administered_at": "…", "administered_by": "…" },
  "can_override": true
}
```

Re-submit with `p_allow_repeat: true` for a genuine subsequent dose. Show the
previous time so the nurse can judge. Note `patient_verified: true` here — that is
how you tell this apart from a mismatch and word the prompt correctly.

### Other codes

| Code | Meaning |
|---|---|
| `PRESCRIPTION_ITEM_NOT_FOUND` | Unknown item, or another clinic's |
| `PRESCRIPTION_NOT_ISSUED` | Still a draft — the drug was never authorised |
| `PRESCRIPTION_CANCELLED` | Explicit instruction not to administer |
| `VALIDATION_ERROR` | `p_status` not one of `given`/`refused`/`held` |
| `NOT_CLINICAL_STAFF` | Billing or patient role |
| `NOT_AUTHENTICATED` | No session |

### Success

```jsonc
{
  "ok": true,
  "administration_id": "…",
  "prescription_item_id": "…",
  "visit_id": "…",
  "status": "given",
  "patient_verified": true,     // SHOW THIS
  "scan_basis": "patient_number",
  "drug_name": "Dolo 650",
  "dose": "650 mg"
}
```

**Surface `patient_verified: true` rather than assuming it.** A silent success looks
identical to a check that was never performed.

---

## 8. Realtime

`tasks` is in the `supabase_realtime` publication.

```ts
supabase
  .channel('board')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onTaskChange)
  .subscribe();
```

RLS applies per subscriber, so billing receives nothing. Auto-created and
auto-completed tasks arrive through this channel too — which is how a card appears on
the board seconds after a doctor orders a lab test, with nobody telling the nurse.

---

## 9. Deliberately not in Phase 3

| Not available | Why |
|---|---|
| **Recurrence / scheduling** | Flat `due_at` only. See §2. The single largest gap here |
| **Structured dosing schedules** | `prescription_items.frequency` is free text (`'TDS'`). Inferring 08:00/14:00/20:00 from it would be the system inventing clinical timing nobody entered. Administrations are logged against an *item*, not a scheduled occurrence |
| Drug-barcode scanning | Needs per-clinic pharmacy stock with barcodes on packs — Tier 3 inventory, does not exist. Right-drug remains the nurse's read of the label |
| Linking `medication_due` tasks to a prescription item | No `prescription_item_id` on `tasks`, so administering does not auto-close a medication task |
| Voiding a mistaken administration | Append-only log. Needs the Phase 4 audit log |
| Task templates / order sets | Not modelled |
| Assigning to a *role* rather than a person | `assigned_to` is a single profile. Unclaimed (`NULL`) is the role-based case |

---

## 10. Verification status

| Suite | Command | Result |
|---|---|---|
| Local flow | `npm run test:phase3` | **252/252** |
| Local isolation + role scoping | `npm run test:isolation3` | **169/169** |
| Remote (real sessions + PostgREST) | `npm run test:phase3:remote` | **203/203** |
| Hosted catalogue | `npm run verify:catalog` | **64/64** |

Covered here specifically: a custom task with no title refused; `status`, `is_auto`,
`completed_by` and `source_id` all refused with `42501`; no delete grant; a nurse can
claim an unclaimed task; `complete_task` stamps completer and time; re-completing
returns `TASK_ALREADY_DONE`; cancelling is idempotent; admission creates exactly **one**
baseline vitals task flagged `is_auto`; **recording vitals auto-completes it**,
attributed to the recording nurse; billing sees zero tasks and zero administrations;
no client INSERT on `medication_administrations`; `SCAN_REQUIRED`,
`PATIENT_CODE_UNRECOGNISED` and `PATIENT_MISMATCH` all distinct with
`patient_verified: false`; mismatch leaks neither patient's identity; a draft
prescription refused; correct UHID **and** correct uuid both accepted with
`patient_verified: true`; a repeat dose returns `ALREADY_ADMINISTERED` with
`can_override` and the previous administration attached; the override records the
second dose; a refusal is recordable; the log rejects UPDATE and DELETE. All of the
administration codes are asserted both locally and over real PostgREST.
