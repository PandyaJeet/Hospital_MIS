# Phases.md
## Development Phases & Work Split — Prince & Jeet

**Companion to:** PRD.md, Architecture.md, rules.md
**Principle:** Scaffold first, then build block by block. Every phase must end in a working, demoable state before the next begins — no phase starts on top of an unstable base.

---

## Role Split (applies across all phases)

| Prince | Jeet |
|---|---|
| Frontend (Next.js, Tailwind, UI components) | Database schema, migrations, RLS policies |
| Supabase client integration (queries, hooks) | Business logic (billing calc, prescription rules, clinical safety checks) |
| Authentication & role-based routing | Edge Functions (PDF generation, webhooks, server-side logic) |
| Realtime subscriptions (consuming) | Realtime triggers/setup (DB side) |
| i18n / localization | Third-party integrations (WhatsApp/SMS, GST invoicing) |
| Role-specific screens: Doctor, Nurse, Billing, Admin, Patient UIs | Data validation, error-code mapping, seed data, backend testing |

**Working agreement:** Jeet ships the schema + RLS + a working Supabase table before Prince builds the screen that depends on it. Prince ships the UI shell/mock-data version in parallel where possible, so nobody blocks on the other unnecessarily — wire real data in once both sides are ready.

---

## Phase 0 — Project Scaffolding
**Goal:** Empty but correctly wired project. Nothing functional yet, but the skeleton is right so nothing needs restructuring later.

### Prince
- Initialize Next.js (App Router) + Tailwind project per `Architecture.md` folder structure
- Set up route groups: `(auth)`, `(doctor)`, `(nurse)`, `(billing)`, `(admin)`, `(patient)`
- Set up `lib/supabase/client.ts` and `server.ts` boilerplate
- Set up base layout, navigation shell, and placeholder pages for each role
- Deploy empty shell to Vercel — confirm CI/CD pipeline works (push → auto-deploy)

### Jeet
- Create Supabase project (dev environment), confirm region (Mumbai if available)
- Set up `supabase/migrations/` structure and Supabase CLI locally
- Create initial `tenants` and `profiles` tables with RLS enabled (even if minimal)
- Set up `.env.example` and document required environment variables
- Confirm `supabase db push` workflow works end-to-end

### Definition of Done
- Empty app deployed on Vercel, connected to a real (empty) Supabase project
- Folder structure matches `Architecture.md` exactly
- Both devs can run the project locally with no setup friction

---

## Phase 1 — Foundation: Auth, Tenancy, Base Layout
**Goal:** A user can sign up, get assigned a role and tenant, log in, and land on the correct role-based screen. No clinical features yet — just a working, secure shell.

### Prince
- Build login/signup UI (Supabase Auth — email or phone OTP)
- Build onboarding flow: first user creates a tenant, becomes admin
- Implement `middleware.ts` for role-based route protection
- Build base app shell per role (top nav, sidebar, placeholder dashboard) for Doctor, Nurse, Billing, Admin
- Implement `useTenant()` hook to read current user's tenant + role + feature-tier
- Set up i18n scaffold (Hindi + English strings, language switcher)

### Jeet
- Finalize `profiles` table (role, tenant_id, linked to `auth.users`)
- Write RLS policies for `tenants` and `profiles`, test with two dummy tenants
- Write DB trigger: new `auth.users` row → auto-create matching `profiles` row
- Build Admin-only "assign role" logic (Edge Function or RLS-gated update)
- Write seed script: 2 dummy tenants, 1 doctor + 1 nurse + 1 billing user each, for local testing
- Document error codes for common auth/tenancy failures (for Prince's error-mapping UI)

### Definition of Done
- A new user can sign up, create a tenant, and reach their role's dashboard
- Two tenants tested — confirmed no cross-tenant data visible anywhere
- Admin can invite/assign roles to new users within their tenant
- All auth error states show mapped, user-friendly messages (no raw Postgres errors)

---

## Phase 2 — Core OPD Flow (Tier 1: Solo Clinic MVP)
**Goal:** A single clinic can fully run OPD: register a patient, doctor sees them, writes a note, prescribes, billing captures the charge. This phase alone should be a shippable Tier 1 product.

### Prince
- Patient registration UI (Billing/Reception screen)
- Doctor's queue view (today's patients, new vs. follow-up, wait-time indicator)
- Patient chart view (history, allergies, current meds — pulled via `usePatientHistory()`)
- Clinical note-taking UI (template-based + free text, no mandatory fields)
- Prescription authoring UI (drug search/autosuggest UI, dose fields, generic/brand toggle)
- Billing screen: auto-populated pending charges view, invoice UI

### Jeet
- Schema: `patients`, `visits`, `clinical_notes`, `prescriptions`, `prescription_items`, `billing_line_items`, `invoices`
- RLS policies for all above, tested cross-tenant
- DB trigger: new prescription/visit event → auto-insert into `billing_line_items`
- Drug database seed (basic Indian drug list) + interaction/allergy check logic (silent-by-default, hard-interrupt only for high severity)
- Edge Function: generate prescription PDF
- Edge Function: generate GST-compliant invoice PDF
- Error-code mapping for registration conflicts (duplicate phone/patient), prescription save failures

### Definition of Done
- Full OPD loop works end-to-end for one tenant: register → queue → consult → prescribe → bill
- Prescription and invoice PDFs generate correctly
- Billing charges auto-appear with zero manual entry by billing staff
- Cross-tenant isolation re-verified with new tables
- This phase deployed and usable by a real pilot clinic

---

## Phase 3 — Nurse Workflows & IPD Foundations (Tier 2 groundwork)
**Goal:** Add nurse task-board and basic IPD/bed tracking, laying groundwork for nursing-home-scale tenants.

### Prince
- Nurse task-board UI (time-bound tasks: vitals due, meds due)
- Vitals entry UI with trend-graph display (feeds into doctor's rounds view)
- Doctor's IPD rounds view (list of inpatients, vitals trend at a glance)
- Bed/ward assignment UI (basic version)
- Realtime wiring: task board and rounds view update live via Supabase subscriptions

### Jeet
- Schema: `vitals`, `tasks`, `beds`, extend `visits` for IPD (admit/discharge status)
- RLS policies for new tables
- DB trigger: nurse vitals entry → auto-updates doctor's rounds data (no separate fetch step)
- Barcode/QR med-administration logic (data model + validation)
- Lab order/result schema (`lab_orders`, `lab_results`) + critical-value flagging logic
- Edge Function: critical lab value → push alert trigger

### Definition of Done
- A tenant can admit a patient, assign a bed, and nurses/doctors see live-updating vitals and tasks
- Critical lab values trigger visible alerts, not passive queue entries
- Tier 2 feature flag correctly gates this module's visibility per tenant

---

## Phase 4 — Admin, Multi-Branch & Tier 3 Groundwork
**Goal:** Admin gets real visibility and control; groundwork laid for larger hospital tenants (OT, blood bank placeholders, insurance/TPA fields) without fully building them yet unless prioritized.

### Prince
- Admin dashboard UI (patient volume, revenue, occupancy — charts)
- User/role management UI (invite, deactivate, change role)
- Tenant settings UI (branding, feature-tier display, language preference)
- End-of-day reconciliation view for billing (captured vs. expected charges)
- Insurance/TPA claim form UI (data entry, not adjudication)

### Jeet
- Aggregation queries/views for admin dashboard metrics (scoped by tenant_id)
- Schema/RLS for `insurance_claims`, placeholder schema for `ot_schedule`, `blood_bank` (Tier 3, structure only)
- Reconciliation logic: compare `billing_line_items` vs. `invoices` for discrepancies
- Audit log table + triggers (who changed what, for compliance)
- Error handling audit: confirm every write operation across the app has proper error mapping (cross-check against `rules.md` Section 3)

### Definition of Done
- Admin can see real metrics and manage users for their tenant
- Reconciliation view correctly flags billing mismatches
- Tier 3 schema exists and is flag-gated, even if UI is minimal
- Full error-handling audit passed against `rules.md`

---

## Phase 5 — Hardening, Testing & Pilot Launch Prep
**Goal:** Bug reduction, polish, and confidence before a real clinic uses this with real patient data.

### Prince
- UI polish pass: loading states, empty states, mobile/tablet responsiveness check
- Localization completeness check (no untranslated strings on core flows)
- Accessibility pass on core doctor/nurse/billing screens (contrast, tap-target size for tablet use)
- Manual QA pass on every role's core flow

### Jeet
- RLS penetration testing: attempt cross-tenant access on every table, document results
- Load-test basic concurrent-write scenarios (multiple nurses/doctors writing simultaneously)
- Backup/restore process documented for Supabase project
- Final review of `rules.md` compliance (no PII in logs, no service-role leaks, no swallowed errors)
- Write minimal e2e tests (Playwright) for the critical path: register → consult → prescribe → bill

### Definition of Done
- Zero known cross-tenant data leaks
- Critical path covered by at least one automated e2e test
- No console errors/warnings on core screens
- Product is ready for first real pilot clinic onboarding

---

## Cross-Phase Rules

1. **No phase begins until the previous phase's Definition of Done is met** — resist the urge to jump ahead on an exciting feature while the base is still shaky.
2. **Schema changes always come from Jeet's side first**, communicated before Prince builds UI against it — avoids Prince building against a shape that changes underneath him.
3. **Both devs test cross-tenant isolation themselves** whenever a new table is added — don't rely solely on the other person's testing.
4. **Weekly sync point per phase minimum** — even async, confirm both sides' work integrates before calling a phase done.
5. Any deviation from this plan (skipping a phase, reordering) should be a conscious decision, noted in this file, not a silent drift.

---

*This file should be updated as phases complete — mark actual completion dates and any scope changes, so it stays a living project tracker, not just an upfront plan.*
