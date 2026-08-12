# Contract: Vitals & Doctor's Rounds

**Phase 3.** Nurse-recorded observations, and the doctor's rounds surface built on
them.

Two things in here will change how you build the UI, so they are up front rather
than buried:

1. **Every measurement column is nullable and that is deliberate.** Do not add
   client-side required-field validation. §1 explains why.
2. **`rounds_overview` gives you the latest known value *per measurement*, not the
   latest row.** A `NULL` there means "never recorded this encounter" and nothing
   else. §4.

Verified against the hosted project. See §8.

---

## 1. Table: `vitals`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | Pinned by RLS; never send another clinic's |
| `visit_id` | `uuid` | Composite FK `(visit_id, tenant_id)` → `visits` |
| `recorded_by` | `uuid` | **Must equal the caller.** Composite FK to `profiles` |
| `recorded_at` | `timestamptz` | Defaults to `now()`, **but writable** — see below |
| `temperature_c` | `numeric(4,1)` **null** | °C |
| `pulse_bpm` | `smallint` **null** | bpm |
| `bp_systolic` | `smallint` **null** | mmHg |
| `bp_diastolic` | `smallint` **null** | mmHg |
| `respiratory_rate` | `smallint` **null** | breaths/min |
| `spo2_percent` | `smallint` **null** | % |
| `blood_glucose` | `numeric(6,1)` **null** | **mg/dL** |
| `notes` | `text` **null** | Free-text observation |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

### Why every measurement is nullable

`rules.md` §1.7 is written about doctor-facing notes, so its letter does not name
this table. The requirement underneath it — never block a save over an incomplete
field — applies here at least as hard.

A nurse mid-round routinely has some observations and not others: pulse and
temperature taken, BP still pending because the only cuff is two beds down, or no
SpO2 because the patient will not keep the probe on. If any measurement column were
`NOT NULL`, that nurse could not save what they *do* have, and the realistic
outcomes are both bad — the reading goes on paper and never gets entered, or a
placeholder number is typed to satisfy the form. **An invented vital is worse than a
missing one**, because a doctor reads it as fact off a trend graph.

So a row containing nothing but a temperature is valid and expected. So is a
completely empty row (it records that someone attended at a time). Both are
asserted in the test suites, locally and over real PostgREST.

**`recorded_at` is client-writable on purpose.** A nurse catching up on paper notes
must be able to record the real observation time, not the data-entry time. Send it
when you know it; omit it for a live entry.

### Units are fixed, not stored

°C, bpm, mmHg, breaths/min, %, and **mg/dL** for glucose (the Indian convention;
mmol/L is not used). There is no per-row unit column, deliberately — two nurses
recording in different units would make a trend graph silently wrong. Label your
inputs with these units.

### What *is* rejected

Nullability is about *incomplete* data. *Impossible* data is a typo and is refused
with a `23514` check violation, so handle that error:

| Column | Accepted range |
|---|---|
| `temperature_c` | 20–45 |
| `pulse_bpm` | 0–400 (0 is real: asystole during a resuscitation) |
| `bp_systolic` | 20–400 |
| `bp_diastolic` | 10–300 |
| `respiratory_rate` | 0–120 |
| `spo2_percent` | 0–100 |
| `blood_glucose` | 0–2000 |

The bounds are generous enough that no real measurement can be rejected; they exist
to catch a slipped decimal point (385 for 38.5) before it lands on a chart.

**Not constrained: `bp_diastolic <= bp_systolic`.** Physiologically impossible to
invert, but one-sided BP entry is legitimate and a cross-field check interacts
confusingly with it. **Please warn on an inverted pair in the UI** — the database
will not refuse the save.

### Client access

| Operation | Who | Notes |
|---|---|---|
| `select` | admin, doctor, nurse | **Not billing** — see below |
| `insert` | admin, doctor, nurse | `recorded_by` must be the caller (else `42501`) |
| `update` | the recorder only | Measurements and `notes` only |
| `delete` | **nobody** | `42501`. It is a medical record |

**Billing is excluded from `vitals`,** the same line Phase 2 drew on
`clinical_notes`: an invoice never needs a blood pressure. This decision is what
forces the shape of `rounds_overview` in §4 — vitals *values* cannot be cached onto
`visits`, because billing can read `visits` and Postgres has no column-level RLS.

**Corrections are limited.** The recorder may fix a measurement they mistyped.
`visit_id` and `recorded_by` are **not** in the update grant, so a row entered
against the wrong encounter cannot be moved — flag it to Jeet; amendment tooling is
a Phase 4 audit-log item.

---

## 2. `visits.last_vitals_at` — freshness, server-derived

Phase 3 adds one column to `visits`:

```
last_vitals_at  timestamptz null   -- max(vitals.recorded_at) for this visit
```

Maintained by a trigger. **Not client-writable** (`42501` if you try) — a forgeable
freshness signal is worse than none, because a doctor sorts an overdue list by it.

It does two jobs:

1. **Cheap "fresh vs overdue" sorting and filtering** over the inpatient list, with
   no per-patient subquery.
2. **It is what makes a Realtime subscription fire.** Logical replication only emits
   a change for the row that changed. A new `vitals` row does not touch `visits`, so
   a `visits` subscriber would never hear about it. The trigger writing
   `last_vitals_at` is precisely what turns a nurse's entry into a push on the
   doctor's open screen — `phases.md`'s "no separate fetch step".

It is recomputed from the table, not copied from the new row, so back-entering an
older observation does **not** move freshness backwards. Both directions are tested.

`last_vitals_at` holds **no clinical content** — it is a bare timestamp — which is
why every staff role including billing may read it.

Sort the rounds list with:

```ts
.order('last_vitals_at', { ascending: true, nullsFirst: true })
```

`nullsFirst` matters: a patient with no vitals at all is the *most* overdue on the
ward, not the least.

---

## 3. Vitals trend (the graph)

`Design.md` §8 wants trend graphs, not tables. Query the series directly:

```ts
const { data } = await supabase
  .from('vitals')
  .select('recorded_at, temperature_c, pulse_bpm, bp_systolic, bp_diastolic, respiratory_rate, spo2_percent, blood_glucose')
  .eq('visit_id', visitId)
  .order('recorded_at', { ascending: false })
  .limit(50);
```

Backed by an index on `(visit_id, recorded_at desc)`, so this is cheap and pageable.

For a trend **across admissions**, join through `visits` on `patient_id` — vitals are
scoped to an encounter, not denormalised onto the patient, so the two can never
drift.

Expect gaps. Every series will have nulls scattered through it; that is the design,
not missing data. Plot per-measurement and skip nulls rather than treating a null as
zero.

---

## 4. View: `rounds_overview`

One row per visit, carrying what a rounds list and a patient header need.
`security_invoker`, so every underlying RLS policy applies to *you*.

Not pre-filtered to inpatients — filtering inside the view would bake a product
decision into the schema. You filter:

```ts
const { data } = await supabase
  .from('rounds_overview')
  .select('*')
  .eq('care_setting', 'ipd')
  .is('discharged_at', null)
  .order('last_vitals_at', { ascending: true, nullsFirst: true });
```

### Columns

| Group | Columns |
|---|---|
| Encounter | `visit_id`, `tenant_id`, `patient_id`, `care_setting`, `visit_status`, `visit_type`, `visit_date`, `queue_number`, `doctor_id`, `checked_in_at`, `admitted_at`, `discharged_at` |
| Bed | `bed_id`, `ward_name`, `bed_number` |
| Patient | `patient_number`, `patient_name`, `age_years`, `dob`, `gender`, `allergies` |
| Freshness | `last_vitals_at`, `vitals_age_seconds`, `vitals_recorded_at`, `vitals_recorded_by`, `vitals_row_count` |
| Measurements | `temperature_c`, `pulse_bpm`, `bp_systolic`, `bp_diastolic`, `respiratory_rate`, `spo2_percent`, `blood_glucose`, `vitals_notes` |
| Timing detail | `vitals_component_times` (`jsonb`) |
| Work outstanding | `pending_tasks`, `overdue_tasks`, `unacknowledged_alerts` |

### ⚠️ The measurement columns are "latest known value per measurement"

Each measurement is the most recent **non-null** value for that measurement *within
the encounter*, resolved independently of the others. This is how a paper flowsheet's
"most recent" column behaves.

**So `NULL` means exactly one thing: never recorded during this encounter.** That is
what makes the card safe to read at a glance.

This was not the original behaviour. The view first returned the single newest
`vitals` row, which contradicted the nullable-measurement design above: a
temperature recorded at 10:00 vanished from the card the moment a BP-only row was
saved at 10:05. Fixed in migration `20260811071200`; found by the remote suite, which
inserted observations in the realistic partial order.

**The trade-off, which you have to render honestly:** values can come from different
moments. A temperature from 06:00 can sit beside a pulse from 11:00. So the view also
gives you:

```jsonc
vitals_component_times: {
  "temperature_c": "2026-08-11T06:00:00Z",
  "bp_systolic":   "2026-08-11T11:00:00Z"
  // absent keys = absent values. `pulse_bpm` was never recorded.
}
```

Use it to show each figure's age, or to grey out anything older than the ward's
expected observation interval. `last_vitals_at` remains "when the most recent
observation of any kind happened" and is still the right thing to sort by.

`vitals_row_count` lets you distinguish "no observations at all" (0) from "some
recorded, this field was not among them".

### What billing sees through this view

`rounds_overview` is readable by billing — it needs the encounter and the bed for an
inpatient bill — but **every measurement comes back `NULL`**, because the `vitals`
policy excludes them and `security_invoker` honours it. Nothing special was written
to achieve that; it falls out of RLS.

Two consequences:

- Do not use `temperature_c === null` to mean "not recorded" **in a billing
  context** — it means "not visible to you". Only clinical roles see measurements.
- `pending_tasks`, `overdue_tasks` and `unacknowledged_alerts` are aggregates, so a
  role that cannot read those tables sees **`0`, not `null`**. `0` there can mean
  "not visible to you". Only show those counts to admin/doctor/nurse.

---

## 5. Realtime

`vitals` and `visits` are both in the `supabase_realtime` publication as of Phase 3.

```ts
supabase
  .channel('rounds')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, onVisitChange)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'vitals' }, onNewVitals)
  .subscribe();
```

Realtime respects RLS, so a subscription only ever delivers rows you could already
have selected — a billing session receives no `vitals` events at all.

Note that a `visits` change event fires when vitals are recorded (that is
`last_vitals_at` doing its job), so re-read the row you receive rather than assuming
the queue status moved.

**Replica identity is the default (primary key)**, so `old_record` is not populated
on updates. If you need it to animate a transition, ask Jeet — it is one line per
table, but it costs WAL volume on a table that is now written on every vitals entry,
so it should be a deliberate change.

---

## 6. Error codes

Vitals is plain CRUD, so these are PostgREST/Postgres codes, not envelopes.

| Code | When | What to show |
|---|---|---|
| `23514` | A measurement is outside its sane range | "That value looks wrong — please check." Name the field |
| `23503` | `visit_id` is not a visit in your clinic | Shouldn't happen from a correct UI; treat as a bug |
| `42501` | `recorded_by` isn't you; or you wrote a withheld column; or your role can't read this | Not user-actionable — log it |

There are no vitals RPCs. Everything here is `from('vitals')` and
`from('rounds_overview')`.

---

## 7. TypeScript for the mock layer

```ts
/** A single observation set. EVERY measurement is optional — this is the contract. */
export interface Vitals {
  id: string;
  tenant_id: string;
  visit_id: string;
  recorded_by: string;
  recorded_at: string;                 // ISO
  temperature_c: number | null;        // °C
  pulse_bpm: number | null;
  bp_systolic: number | null;          // mmHg
  bp_diastolic: number | null;         // mmHg
  respiratory_rate: number | null;
  spo2_percent: number | null;
  blood_glucose: number | null;        // mg/dL
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** What you may send. Only the three structural fields are required. */
export type VitalsInsert =
  Pick<Vitals, 'tenant_id' | 'visit_id' | 'recorded_by'> &
  Partial<Pick<Vitals,
    | 'recorded_at' | 'temperature_c' | 'pulse_bpm' | 'bp_systolic' | 'bp_diastolic'
    | 'respiratory_rate' | 'spo2_percent' | 'blood_glucose' | 'notes'>>;

/** Per-measurement timestamps. Absent key = value was never recorded. */
export type VitalsComponentTimes = Partial<Record<
  | 'temperature_c' | 'pulse_bpm' | 'bp_systolic' | 'bp_diastolic'
  | 'respiratory_rate' | 'spo2_percent' | 'blood_glucose',
  string
>>;

export interface RoundsRow {
  visit_id: string;
  tenant_id: string;
  patient_id: string;
  care_setting: 'opd' | 'ipd';
  visit_status: 'queued' | 'in_consultation' | 'done' | 'cancelled';
  visit_type: string | null;
  visit_date: string;
  queue_number: number;
  doctor_id: string | null;
  checked_in_at: string;
  admitted_at: string | null;
  discharged_at: string | null;

  bed_id: string | null;
  ward_name: string | null;
  bed_number: string | null;

  patient_number: number;
  patient_name: string;
  age_years: number | null;
  dob: string | null;
  gender: 'male' | 'female' | 'other' | 'unknown' | null;
  allergies: string | null;

  last_vitals_at: string | null;
  vitals_age_seconds: number | null;
  vitals_recorded_at: string | null;
  vitals_recorded_by: string | null;
  vitals_row_count: number;

  // Latest KNOWN value per measurement. null = never recorded this encounter
  // (clinical roles), or not visible to you (billing).
  temperature_c: number | null;
  pulse_bpm: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  respiratory_rate: number | null;
  spo2_percent: number | null;
  blood_glucose: number | null;
  vitals_notes: string | null;

  vitals_component_times: VitalsComponentTimes;

  // Aggregates: 0 can mean "not visible to you".
  pending_tasks: number;
  overdue_tasks: number;
  unacknowledged_alerts: number;
}
```

---

## 8. Deliberately not in Phase 3

| Not available | Why |
|---|---|
| Correcting a vitals row's `visit_id` | Not in the update grant. An entry against the wrong encounter needs Phase 4 amendment tooling |
| Deleting a vitals row | No delete grant at all. Medical record |
| Amendment history | An edit overwrites in place; no before/after trail until the Phase 4 audit log |
| Per-patient (cross-visit) vitals table | Vitals are encounter-scoped. Cross-admission trends join through `visits` |
| Paediatric-adjusted sane ranges | The bounds are adult-oriented but wide enough not to reject a child's values |
| `old_record` on Realtime updates | Replica identity is default. Ask if you need it |

---

## 9. Verification status

| Suite | Command | Result |
|---|---|---|
| Local flow | `npm run test:phase3` | **252/252** |
| Local isolation + role scoping | `npm run test:isolation3` | **169/169** |
| Remote (real sessions + PostgREST) | `npm run test:phase3:remote` | **203/203** |
| Hosted catalogue | `npm run verify:catalog` | **64/64** |

Covered here specifically: a completely empty vitals row saves, and so do
temperature-only, pulse-only and systolic-only rows — asserted both locally and over
real PostgREST; a catalogue assertion that **zero** measurement columns are
`NOT NULL` (and that the four structural ones are, so it is not passing vacuously);
385 °C, 150% SpO2 and pulse 900 rejected while BP 60/30 with SpO2 82 saves; the
freshness trigger stamps `last_vitals_at`, does not move it backwards on a
back-dated entry, moves it forward on a newer one, and is not client-writable;
**a temperature from an earlier row still shows on the rounds card** alongside a BP
from the newest row, with per-field timestamps that differ; a never-recorded
measurement stays `NULL`; billing sees the rounds row and the patient but `NULL` for
every measurement, through the view, on the hosted project.
