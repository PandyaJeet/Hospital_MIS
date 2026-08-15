# Backup & Restore — Hospital MIS

**Phase:** 5 (Hardening, Testing & Pilot Launch Prep)
**Project:** `udjvbvtxrgrvpnmfvnbk` — Supabase hosted, region `ap-south-1` (Mumbai)
**Status of this document:** procedures written and reviewed. **The restore procedure has NOT been executed.** See §6 — that is the headline finding, not a footnote.

---

## 0. Read this first

This document exists because Phase 5's job is to find out what is actually true, not to
describe what ought to be. Three things were established by direct inspection of the
hosted project, and one important thing could not be established at all:

| | Finding | How it was determined |
|---|---|---|
| ✅ | WAL archiving to object storage is **live and healthy** | `pg_settings` + `pg_stat_archiver` on the hosted project |
| ✅ | Database is small (14 MB) — restore time is not a concern yet | `pg_database_size()` |
| ❌ | **Plan tier / PITR add-on state is UNKNOWN** | requires a Management API token this repo does not have |
| ❌ | **No logical backup can be taken from this workstation** | `pg_dump` absent, Docker down |

The two ❌ rows are the risks. They are written up plainly in §6 rather than softened.

---

## 1. What is verifiably true about this project

Read on 2026-08-12 via `npm run db:query`:

| Setting | Value | What it means here |
|---|---|---|
| `server_version` | `17.6` | Postgres 17 |
| `archive_mode` | `on` | WAL segments are being shipped off-instance |
| `archive_command` | `/usr/bin/admin-mgr wal-push …` | Supabase's WAL-G pipeline |
| `archive_timeout` | `2min` | a segment is forced out every 2 minutes even when idle |
| `archived_count` | `99` | it has actually run, repeatedly |
| `failed_count` | `0` | **nothing has failed** — the pipeline is healthy, not merely configured |
| `last_archived_time` | `2026-08-12 16:59:39+00` | current, not stale |
| `wal_level` | `logical` | required by Realtime; also sufficient for WAL shipping |
| `pg_replication_slots` | none | no read replica, no logical subscriber |
| `pg_database_size` | 14 MB | seed + fixture data only; no real patient data yet |
| `max_connections` / `shared_buffers` | `60` / `224MB` | a small compute instance |

**What this evidence does and does not prove.** It proves WAL segments are leaving the
instance continuously and successfully — that is the *mechanism* point-in-time recovery
is built on, and a 2-minute `archive_timeout` is a granularity that only makes sense if
someone intends to recover to a point in time. It does **not** prove the PITR add-on is
enabled on the billing account, because Supabase runs the same WAL pipeline to take the
daily physical base backups that paid plans get regardless. Retention and the
restore-to-timestamp control both live on the platform side, invisible from SQL.

So: the machinery is running. Whether the platform will *let you use it* is a plan
question, and that question is answered in the dashboard, not here.

---

## 2. Why the plan tier could not be determined from this repo

`supabase projects list` and every Management API route need a personal access token
(`sbp_…`). The repo documents the variable — `.env.example` line 73 lists
`SUPABASE_ACCESS_TOKEN=sbp_xxxx…` — but `.env` does not set it, and
`npx supabase projects list` returns:

```
Access token not provided. Supply an access token by running `supabase login`
or setting the SUPABASE_ACCESS_TOKEN environment variable.
```

This is the same missing credential that has blocked `supabase functions deploy` since
Phase 2 (the PDF functions and `notify-critical-lab-value` are written, typed and
committed, but have never run). It is a known, pre-existing gap, and it is now also
blocking a backup-posture check.

### Action required by a human — before any real patient data is entered

Open **Dashboard → Project Settings → Database → Backups** for
`udjvbvtxrgrvpnmfvnbk` and record which of these is true:

- [ ] **Free plan** — no backups at all. This is the case that must not survive to pilot.
- [ ] **Pro / Team / Enterprise, daily backups only** — worst-case data loss is up to 24 hours.
- [ ] **PITR add-on enabled** — recovery to a specific timestamp; note the retention window.

Then fill in §5's RPO/RTO table, which is deliberately left blank rather than guessed.

### What the plans actually provide

Per [Supabase's backup documentation](https://supabase.com/docs/guides/platform/backups):
Pro projects can reach the previous 7 days of daily backups, Team 14 days, and
Enterprise up to 30; more frequent recovery than that is what PITR is for. Third-party
write-ups of the same tiers state the Free plan gets nothing —
[SimpleBackups' summary](https://simplebackups.com/blog/what-supabase-native-backup-doesnt-cover)
puts it as Pro 7 / Team 14 / Enterprise 30 / Free none, and notes that without PITR the
recovery granularity is a full day, so a snapshot taken at 02:00 already contains
whatever went wrong earlier that morning.
[PITR is billed hourly](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery)
and any part-hour counts as a full hour; when it was introduced it also
[required the Small compute add-on](https://supabase.com/blog/postgres-point-in-time-recovery).
*(Content rephrased for compliance with licensing restrictions.)*

Given this project reports `max_connections = 60` / `shared_buffers = 224MB`, the compute
prerequisite for PITR is worth checking at the same time as the plan.

---

## 3. Restoring from a Supabase-managed backup

Neither path is scriptable from this repo — both are dashboard operations, by Supabase's
design, because both are destructive.

### 3a. Daily backup (any paid plan)

1. Dashboard → Project Settings → Database → **Backups**.
2. Pick a date. **Note what it costs you:** everything written after that snapshot is
   gone. For a clinic that means every consultation, prescription and invoice raised
   since — work patients were physically present for.
3. Restore. The project is unavailable while it runs.
4. Run the post-restore verification in §7. Do not skip it: a restore that half-worked
   looks identical to one that worked until somebody queries the wrong thing.

### 3b. Point-in-time recovery (if the add-on is enabled)

1. Dashboard → Project Settings → Database → Backups → **Point in Time**.
2. Choose a timestamp. Aim for *immediately before* the damaging event, not a round
   number — the point of PITR is that you do not have to lose the rest of the day.
3. Restore, then run §7.

**Establishing the timestamp is a database question, and this schema can answer it.**
`audit_log` records role changes, deactivations, invite lifecycle and tenant settings
changes with `created_at` and an actor, and `20260811080700` made `audit_log.tenant_id`
`ON DELETE RESTRICT` specifically so that history outlives what it describes. Before
restoring, query it to find when the bad change landed:

```sql
select created_at, action, table_name, row_id, actor_id, actor_is_system, changes
from public.audit_log
where tenant_id = '<tenant>'
  and created_at > now() - interval '48 hours'
order by created_at desc;
```

Restore to just before that `created_at`. Note the limit honestly: `audit_log` covers
access and configuration events, **not** clinical writes. A wrongly deleted prescription
leaves no audit row, so for clinical damage the timestamp has to come from
`created_at`/`updated_at` on the affected rows instead.

---

## 4. Taking a backup this repo controls — currently BLOCKED

Everything in §3 lives inside the same Supabase account as the data. An account-level
event (billing lapse, suspension, an accidental project delete) removes the database and
its backups together. For patient records that is a single point of failure regardless of
plan, so an independent copy is not optional.

**It cannot currently be produced from this workstation.** Verified, not assumed:

| Tool | State |
|---|---|
| `pg_dump` | not installed |
| `psql` | not installed |
| Docker | down (WSL integration broken — the same failure that blocks `npm run db:types`) |
| `supabase db dump --db-url …` | fails: `failed to inspect docker image` |

`supabase db dump` shells out to `pg_dump` inside a container, so it inherits the Docker
outage. There is presently **no working path to a logical backup**, which is a stronger
statement than "we have not made one yet".

### Closing this gap

Either fixes it; the first is smaller.

**Option A — install Postgres 17 client tools** (matching the server's 17.6; an older
`pg_dump` refuses a newer server). Then, using the pooler host already in
`supabase/scripts/db.ts` because the direct `db.<ref>.supabase.co` host is IPv6-only and
unreachable from WSL:

```bash
# Session mode (5432). Password from .env — never inline it on a command line.
PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_dump \
  --host=aws-0-ap-south-1.pooler.supabase.com --port=5432 \
  --username="postgres.$SUPABASE_PROJECT_REF" --dbname=postgres \
  --schema=public --no-owner --no-privileges --format=custom \
  --file="hmis-$(date +%Y%m%d-%H%M).dump"
```

**Option B — repair Docker Desktop's WSL integration**, then `supabase db dump`. This
also unblocks `npm run db:types`, which has left `supabase/types/database.types.ts` stale
since Phase 4.

Whichever is chosen, three properties matter more than the command:

- **Off-platform.** A dump sitting in Supabase Storage shares the failure domain it is
  meant to survive.
- **Encrypted at rest.** The dump is a plaintext copy of every patient record in the
  system. It is the highest-value artefact this project can produce and must not land in
  a synced cloud folder unencrypted.
- **Scheduled and monitored.** A backup job nobody watches fails silently, which is
  indistinguishable from having no backup until the day it matters.

---

## 5. RPO / RTO — deliberately unfilled

| Scenario | RPO (data loss) | RTO (downtime) | Mechanism |
|---|---|---|---|
| Accidental `DELETE`/`UPDATE`, one tenant | *unknown* | *unknown* | PITR if enabled, else daily |
| Bad migration | *unknown* | *unknown* | PITR to just before `db push`, or forward-fix migration |
| Whole-project loss | *unknown* | *unknown* | daily backup — **or nothing on Free** |
| Supabase account loss | **total** | **unbounded** | nothing exists today (§4) |

The first three rows stay blank until §2's checkbox is answered. Filling them in with
plausible numbers would be worse than leaving them empty: an RPO nobody verified is a
promise the system has not made.

The last row is not unknown. It is **total loss**, today, and that is a determination, not
a gap.

---

## 6. Risks — stated plainly

**R1. The backup posture is unverified, so no recovery guarantee exists.**
Not "probably fine": unknown. If the project is on Free, there are no backups and any
data loss is permanent. This must be resolved before a clinic enters one real patient.
*Severity: blocker for pilot launch.*

**R2. No copy of the data exists outside Supabase.** §4. Whatever the plan provides
shares a failure domain with the thing it protects. *Severity: high.*

**R3. The restore procedure has never been executed.** Everything in §3 is read from
documentation and the dashboard's affordances. An untested restore is a hypothesis, and
the recurring lesson of this project — logged three times in `Memory.md` §6 for
idempotent teardown — is that a path nobody has walked is a path that does not work.
A restore rehearsal on a throwaway project is the only thing that converts this
document into a capability. *Severity: high.*

**R4. There is no working way to take a logical backup from this workstation.** §4.
*Severity: high, and the cheapest of these to fix.*

**R5. Without PITR, worst-case loss is a full clinic day.** Daily snapshots mean up to
24 hours of consultations, prescriptions and invoices. Unlike a SaaS app, this data
cannot be regenerated: the patients were physically present and have gone home.
*Severity: high if PITR is off; not applicable if on.*

**R6. `npm run db:seed:reset` is a destructive script holding the service-role key.**
It scopes deletion to seed tenants by fixture identity and it is correct as written —
but it bypasses RLS by design, and a pilot project with real tenants alongside seed ones
is a materially different risk than a dev project. Recommend it refuse to run when the
target project contains any non-seed tenant. *Severity: medium. Not fixed in Phase 5 —
outside "attack what exists, fix what the attack reveals", and it is a behaviour change,
not a hardening of existing behaviour.*

**R7. Retention obligations are not established.** Indian clinical-record retention
expectations, and the DPDP Act 2023 obligations that attach to a Data Fiduciary handling
health data, will constrain both how long backups must be kept and how they must be
protected. This needs a qualified opinion — it is explicitly **not** determined here, and
nothing in this document should be read as legal advice.

---

## 7. Post-restore verification

Run in this order. The point is to distinguish "the restore completed" from "the system
is correct", which are different claims.

```bash
npm run db:migrations   # local and remote must be in lockstep; a restore can rewind schema_migrations
npm run verify:catalog  # 168 checks: RLS on every table, security_invoker on every view, no anon SELECT
npm run audit:codes     # 67/67 error codes still documented
npm run test:local      # 8 suites; full RLS + flow + pentest coverage against PGlite
```

`verify:catalog` matters most here, and specifically its catalogue-driven group 17. A
restore that rewound to a point before an `alter table … enable row level security` would
leave a table readable across tenants while every policy still listed correctly. Group 17
enumerates `public` from the catalogue rather than a hand-written list, so it cannot miss
a table for that reason.

Then confirm tenant isolation survived, since RLS is the guarantee a restore is most
likely to quietly damage:

```bash
npm run db:seed          # only on a project where losing seed data is acceptable
npm run test:remote      # rls + opd + phase3 + concurrency, against the real project
```

And the invariants a restore could rewind past:

```sql
-- 0. Both Phase 5 concurrency fixes must still be in the deployed function bodies.
--    A restore rewinds functions too, and losing either of these raises no error.
--    verify:catalog groups 16 and 18 cover this; run them rather than eyeballing it.
select proname,
       position('pg_advisory_xact_lock' in prosrc) < position('INVOICE_ALREADY_EXISTS' in prosrc)
         as lock_before_check
  from pg_proc where proname = 'create_invoice_for_visit';                        -- expect true
select proname, position('for no key update' in prosrc) > 0 as locks_visit
  from pg_proc
 where proname in ('refresh_visit_vitals_freshness', 'autocomplete_vitals_due_task');  -- expect true, true

-- 1. The Phase 5 duplicate-invoice index must still exist.
select count(*) from pg_indexes
 where schemaname = 'public' and indexname = 'invoices_one_live_per_visit_idx';   -- expect 1

-- 2. Gapless per-tenant invoice numbering, with no live duplicates per visit.
select tenant_id, count(*) as invoices, max(invoice_number) as highest
  from public.invoices group by tenant_id;      -- count should equal highest, per tenant

-- 3. No visit carries two live invoices.
select visit_id, count(*) from public.invoices
 where status <> 'cancelled' group by visit_id having count(*) > 1;               -- expect 0 rows
```

Check 2 is the one worth understanding. An invoice number is a statutory document number.
A restore to a point in time can re-issue numbers that were already printed and handed to
patients, so after any restore the highest number per tenant must be reconciled against
what was actually issued. This is a bookkeeping obligation, not a database one, and the
database cannot detect it.

---

## 8. What Phase 5 changed here

Nothing in the schema. This document is the deliverable, plus the finding that two of its
four sections describe capabilities that do not currently exist. Recorded in `Memory.md`
§6 as open risks rather than closed items, because that is what they are.
