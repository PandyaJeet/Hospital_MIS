# Contract: Admin Dashboard & Billing Reconciliation

**Phase 4.** PRD §6.5 ("patient volume, revenue, occupancy, staff utilization, scoped
to their `tenant_id`") and PRD §6.3 ("end-of-day reconciliation view").

Three things up front:

1. **These are views, not RPCs.** Filter them like tables. §1.
2. **A clinic "day" is the UTC calendar date, so it runs 05:30 IST → 05:30 IST.** §2.
3. **"Staff utilization" is not utilization.** It reports activity counts plus real
   consulting minutes, and the contract says so because the dashboard should too. §6.

---

## 1. Why views, and how to use them

Every metric here is a scoped aggregate, so every one is a view. No RPC exists,
deliberately: PostgREST filters a view like a table, so date ranges need no server-side
parameter —

```ts
const { data } = await supabase
  .from('admin_patient_volume_daily')
  .select('*')
  .gte('activity_date', from)
  .lte('activity_date', to)
  .order('activity_date');
```

— and you keep sorting, pagination and generated types. An RPC would have bought
nothing and cost all three.

**All seven are `security_invoker` and admin-gated inside the view body.** A view
cannot carry an RLS policy, so each contains `where public.is_tenant_admin()`. Tenant
scoping comes from the underlying table policies. Consequence for you:

> **A non-admin gets ZERO ROWS, not an error.** Do not render "no data yet" for a
> doctor — check the role first and don't show the page.

The catalogue suite asserts `security_invoker` on all seven, because losing it would
silently report every clinic's revenue to whoever asked.

---

## 2. ⚠️ The day boundary

Daily metrics bucket by the **UTC calendar date**, because that is what
`visits.visit_date` already means (Phase 2 set it with `current_date`, and the session
timezone is UTC).

**So a clinic day runs 05:30 IST to 05:30 IST.**

This is inherited on purpose, not chosen. Bucketing patients and revenue by
`Asia/Kolkata` while visits bucket by `visit_date` would make the dashboard's panels
disagree with each other *and* with the queue screen staff use all day — worse than the
05:30 boundary itself. One definition of "day", even an imperfect one, beats two.

Fixing it properly needs a per-tenant timezone and a change to what
`check_in_patient()` writes, which changes queue numbering. Phase 5 item, flagged in
`Memory.md` §6. **Label the dashboard's date axis as a clinic day, not "today", if you
can.**

---

## 3. `admin_patient_volume_daily`

One row per (tenant, day) that had either a registration or a visit. The date spine is a
union of both sources, so a day with only registrations still appears — without it the
chart would skip days instead of showing zero.

| Column | Meaning |
|---|---|
| `activity_date` | The clinic day (see §2) |
| `new_patients` | Registrations that day |
| `visits_total` / `visits_new` / `visits_follow_up` | Encounters, split by type |
| `visits_completed` / `visits_cancelled` / `visits_still_open` | By status |
| `unique_patients_seen` | Distinct patients (a patient seen twice counts once) |
| `ipd_admissions` | Visits admitted that day |

New-vs-follow-up is in the same row on purpose: the ratio is the interesting number, and
splitting it across two endpoints would make that the frontend's arithmetic.

---

## 4. `admin_revenue_daily`

One row per (tenant, issue date). **Counts only invoices with `status in ('issued',
'paid')` and a non-NULL `issued_at`** — drafts are not revenue and cancelled invoices
are not either.

Bucketed by **issue date**, not creation date: a draft that sat for two days belongs to
the day it was issued.

| Column | Meaning |
|---|---|
| `revenue_date` | Issue date |
| `invoices_issued` | Count |
| `gst_invoices` / `bills_of_supply` | Split by `is_gst_invoice` |
| `subtotal` / `tax_total` | Exposed separately — see below |
| `gross_revenue` | Sum of `grand_total` |
| `amount_collected` | Sum of `amount_paid` |
| `outstanding` | `gross_revenue - amount_collected` |
| `invoices_paid` / `invoices_unpaid` | By status |

`gross_revenue` sums `grand_total`, which is a **generated** column
(`subtotal + tax_total`), so the printed total can never disagree with its parts.

`subtotal`/`tax_total` are separate so this doubles as GST-reporting groundwork without
being built as a GST report. For a rate-wise breakdown you still need
`invoice_tax_lines` (see `billing.md`).

`outstanding` is a real number: partial payment is representable, so do not assume it is
always zero.

---

## 5. `admin_occupancy_current`

A **snapshot**, not a series. Exactly one row per tenant, always — built from `tenants`
outward, so a clinic with no beds gets a row of zeros rather than no row. The UI can then
say "no beds configured" instead of having to tell an empty result from a failed query.

| Column | Meaning |
|---|---|
| `total_beds`, `occupied`, `available`, `cleaning`, `maintenance` | Bed counts by status |
| `occupancy_pct` | **NULL when `total_beds = 0`** — see below |
| `current_inpatients` | `care_setting='ipd' and discharged_at is null` |
| `admitted_without_bed` | Admitted but no bed assigned |
| `admissions_today` / `discharges_today` | Movement today |

**`occupancy_pct` is NULL, not 0, when there are no beds.** "0% occupied" and "no ward
exists" are different statements, and a gauge showing 0% for a clinic with no ward is a
lie. Render the NULL as "—".

**`current_inpatients` can exceed `occupied`,** legitimately: Phase 3 allows an admitted
patient with no bed yet (on a trolley in casualty). `admitted_without_bed` is that gap,
and it is a real operational signal rather than an inconsistency to reconcile away.

**Not tier-gated**, following the `beds` SELECT precedent — a Tier 1 clinic naturally
reports zeros, and gating would make a downgraded tenant's dashboard error rather than
show an empty ward.

---

## 6. ⚠️ `admin_staff_activity_daily` — activity, not utilization

**This is not utilization, and the dashboard should not label it as such.**
Utilization is time-worked over time-available, and this system has no roster, no
shifts, no clock-in and no contracted hours. The denominator does not exist and cannot
be inferred. Building one would mean inventing a time-tracking module nobody asked for.

What is here:

| Column | Meaning |
|---|---|
| `staff_id`, `staff_name`, `staff_role`, `staff_is_active` | Who |
| `activity_date` | Clinic day |
| `consultations_completed` | `visits` done, by `doctor_id` |
| `notes_authored` | `clinical_notes` by `author_id` |
| `prescriptions_issued` | `prescriptions` issued, by `doctor_id` |
| `vitals_recorded` | `vitals` by `recorded_by` |
| `tasks_completed` | `tasks` done, by `completed_by` |
| `lab_orders_placed` | `lab_orders` by `ordered_by` |
| `medications_administered` | `medication_administrations` by `administered_by` |
| `recorded_actions_total` | Sum of the above |
| **`consulting_minutes`** | **Real elapsed time** from `consultation_started_at` → `consultation_ended_at` |
| `avg_consultation_minutes` | Mean of the above |
| `consultations_untimed` | Consultations missing one or both stamps |

`consulting_minutes` is the closest thing to genuine utilization available and is the
number worth showing. It is NULL-safe: a visit missing a stamp contributes nothing rather
than counting as zero minutes, which would drag the average down and make a data-capture
gap look like fast consulting. `consultations_untimed` tells you how much you are not
seeing — show it next to the average.

**A real utilization metric would additionally need:** a shift roster per staff member, a
definition of clinical vs administrative time, and a policy on how idle time between
patients counts. None of that is in scope.

**Privacy:** counts and minutes only. No patient identity, no diagnosis, no clinical
content — an admin learns that a doctor completed 24 consultations, not who they were.
Asserted in the test suite by checking no column name matches patient/diagnosis/complaint.

---

## 7. `admin_dashboard_summary`

One row per tenant, for the headline cards, so the top of the page is one query rather
than four. Everything here is derivable from the views above.

`visits_today`, `visits_completed_today`, `visits_open_now`, `new_patients_today`,
`revenue_today`, `collected_today`, `visits_30d`, `new_patients_30d`, `revenue_30d`,
`outstanding_30d`, `active_staff`, `inactive_staff`, `total_patients`, plus
`tenant_name`, `tier`, `gst_registered`, `as_of_date`.

The 30-day window is a stated choice, not a magic number: it is the shortest window that
smooths weekly clinic rhythm (a Sunday with no OPD should not make a card read as a
collapse) and long enough to mean something for a clinic live for weeks.

---

## 8. `billing_reconciliation` — one row per finding

PRD §6.3. **Read-only: it reports, it does not correct.** The question staff ask at the
end of a shift is "is anything off, and what" — one list, sorted by how much it matters.

| Column | Meaning |
|---|---|
| `finding_type` | `pending_charge` \| `invoice_sum_mismatch` \| `payment_status_mismatch` |
| `severity` | `high` \| `warning` \| `info` — **part of the contract** |
| `table_name`, `row_id` | What to open |
| `visit_id`, `patient_id`, `invoice_id`, `invoice_number` | Context |
| `detail` | Plain-language explanation of *this* finding |
| `amount_at_stake` | The money involved |
| `expected_amount` | What it should have been (sum-mismatch and payment cases) |
| `age_hours`, `occurred_at` | How long it has been wrong |

### Severity

| | Meaning | Examples |
|---|---|---|
| `high` | Money is definitely wrong | Stored total disagrees with the lines; overpayment; marked paid while short; payment against a draft or cancelled invoice |
| `warning` | Money is probably being lost | A charge uninvoiced for over 24h; fully collected but still marked unpaid |
| `info` | Normal operation | A charge raised today, not yet invoiced — just an open encounter |

**Default the UI to `warning` and above.** Nothing is hidden — `info` is there so the
list is complete — but showing today's open charges alongside a broken invoice makes the
broken invoice invisible.

### The three checks

1. **`pending_charge`** — `billing_line_items.invoice_id is null`. The revenue leakage
   PRD §3 is about: work done, chargeable, never billed.
2. **`invoice_sum_mismatch`** — stored `subtotal`/`tax_total` disagrees with the sum of
   attached lines, with a 0.01 tolerance (line amounts are individually rounded to
   paise, so exact equality would produce false findings; a real discrepancy is never one
   paise). This *should* be impossible while `create_invoice_for_visit()` is the only
   writer — which is exactly why it is checked. A service-role backfill, a dashboard
   edit, or a bug in a later revision would all land here. `grand_total` is generated so
   it cannot drift and is not checked.
3. **`payment_status_mismatch`** — four distinct contradictions, kept separate because
   they need different remedies. `detail` names which one.

### `billing_reconciliation_summary`

The badge: `finding_count`, `total_amount_at_stake`, `oldest_age_hours`,
`oldest_occurred_at` per `(finding_type, severity)`. One row instead of fetching every
finding to count them — this is what the dashboard tile should read.

---

## 9. Error codes

None. Every surface here is a plain `select` on a view, so failures are PostgREST
errors:

| Code | When |
|---|---|
| `42501` | `anon` reading any of these views |
| *(zero rows)* | A non-admin — **not** an error, see §1 |

---

## 10. TypeScript for the mock layer

```ts
export interface PatientVolumeDay {
  tenant_id: string; activity_date: string;
  new_patients: number; visits_total: number;
  visits_new: number; visits_follow_up: number;
  visits_completed: number; visits_cancelled: number; visits_still_open: number;
  unique_patients_seen: number; ipd_admissions: number;
}

export interface RevenueDay {
  tenant_id: string; revenue_date: string;
  invoices_issued: number; gst_invoices: number; bills_of_supply: number;
  subtotal: number; tax_total: number; gross_revenue: number;
  amount_collected: number; outstanding: number;
  invoices_paid: number; invoices_unpaid: number;
}

export interface OccupancySnapshot {
  tenant_id: string; tier: number;
  total_beds: number; occupied: number; available: number;
  cleaning: number; maintenance: number;
  occupancy_pct: number | null;        // NULL when total_beds = 0
  current_inpatients: number;
  admitted_without_bed: number;        // can make current_inpatients > occupied
  admissions_today: number; discharges_today: number;
}

export interface StaffActivityDay {
  tenant_id: string; staff_id: string;
  staff_name: string | null; staff_role: string; staff_is_active: boolean;
  activity_date: string;
  consultations_completed: number; notes_authored: number;
  prescriptions_issued: number; vitals_recorded: number;
  tasks_completed: number; lab_orders_placed: number;
  medications_administered: number; recorded_actions_total: number;
  consulting_minutes: number | null;        // real elapsed time
  avg_consultation_minutes: number | null;
  consultations_untimed: number;            // show alongside the average
}

export interface DashboardSummary {
  tenant_id: string; tenant_name: string; tier: number; gst_registered: boolean;
  as_of_date: string;
  visits_today: number; visits_completed_today: number; visits_open_now: number;
  new_patients_today: number; revenue_today: number; collected_today: number;
  visits_30d: number; new_patients_30d: number;
  revenue_30d: number; outstanding_30d: number;
  active_staff: number; inactive_staff: number; total_patients: number;
}

export type ReconciliationFindingType =
  | 'pending_charge' | 'invoice_sum_mismatch' | 'payment_status_mismatch';
export type ReconciliationSeverity = 'high' | 'warning' | 'info';

export interface ReconciliationFinding {
  tenant_id: string;
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  row_id: string; table_name: string;
  visit_id: string | null; patient_id: string | null;
  invoice_id: string | null; invoice_number: number | null;
  detail: string;
  amount_at_stake: number | null;
  expected_amount: number | null;
  age_hours: number | null;
  occurred_at: string;
}

export interface ReconciliationSummaryRow {
  tenant_id: string;
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  finding_count: number;
  total_amount_at_stake: number | null;
  oldest_age_hours: number | null;
  oldest_occurred_at: string | null;
}
```

---

## 11. Deliberately not in Phase 4

| Not available | Why |
|---|---|
| **Auto-correcting discrepancies** | Reporting only. Adjusting money without a human deciding what correct means is not a reporting layer's job |
| **Per-tenant timezone** | See §2. Phase 5 |
| **Real staff utilization** | No roster/shift data exists. See §6 |
| **Rate-wise GST report** | `admin_revenue_daily` splits subtotal/tax but not by rate. Join `invoice_tax_lines` |
| **Materialised views / caching** | All computed live. Fine at pilot scale; revisit if the dashboard slows |
| **Multi-branch rollup** | `phases.md` says "Multi-Branch" but one tenant is one clinic — `profiles.tenant_id` is single-valued (Architecture.md §9). A group view across clinics needs a tenant-hierarchy model that does not exist. Flagged in `Memory.md` §6 |
| **Payment mode / cash-drawer breakdown** | `invoices.payment_mode` exists but is not aggregated |
| **Export to CSV/PDF** | No reporting endpoint |

---

## 12. Verification status

| Suite | Command | Result |
|---|---|---|
| Local Phase 4 | `npm run test:phase4` | **211/211** |
| Hosted catalogue | `npm run verify:catalog` | **93/93** |

Covered here specifically: an admin sees patient volume, revenue, occupancy, staff
activity and the summary, with today's registration and completed visit counted, gross
revenue equal to subtotal + tax, and the consultation and note attributed to the doctor;
**a Tier 1 clinic still gets exactly one occupancy row, with `total_beds = 0` and
`occupancy_pct` NULL rather than 0**; the staff view asserted to contain no
patient-identity column; **doctor, nurse and billing each see zero rows in all seven
views**; a second clinic's admin sees only their own tenant. Reconciliation: an
uninvoiced charge flagged `info` while fresh and naming the charge; **a corrupted stored
total flagged `high` and clearing once corrected**; all four payment contradictions
flagged with the right severity and a specific `detail`, each on its own invoice because
Phase 2 forbids the illegal transitions; **and a correctly paid invoice raising no
finding at all**, so the view is not simply flagging everything.
