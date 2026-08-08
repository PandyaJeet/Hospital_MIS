# Phases.md
## Development Phases

**Companion to:** PRD.md, Architecture.md, rules.md
**Principle:** Scaffold first, then build block by block. Every phase must end in a working, demoable state before the next begins — no phase starts on top of an unstable base.

---

## Phase 0 — Project Scaffolding
**Goal:** Empty but correctly wired project. Nothing functional yet, but the skeleton is right so nothing needs restructuring later.

### Definition of Done
- Empty app deployed on Vercel, connected to a real (empty) Supabase project
- Folder structure matches `Architecture.md` exactly
- The project runs locally with no setup friction

---

## Phase 1 — Foundation: Auth, Tenancy, Base Layout
**Goal:** A user can sign up, get assigned a role and tenant, log in, and land on the correct role-based screen. No clinical features yet — just a working, secure shell.

### Definition of Done
- A new user can sign up, create a tenant, and reach their role's dashboard
- Two tenants tested — confirmed no cross-tenant data visible anywhere
- Admin can invite/assign roles to new users within their tenant
- All auth error states show mapped, user-friendly messages (no raw Postgres errors)

---

## Phase 2 — Core OPD Flow (Tier 1: Solo Clinic MVP)
**Goal:** A single clinic can fully run OPD: register a patient, doctor sees them, writes a note, prescribes, billing captures the charge. This phase alone should be a shippable Tier 1 product.

### Definition of Done
- Full OPD loop works end-to-end for one tenant: register → queue → consult → prescribe → bill
- Prescription and invoice PDFs generate correctly
- Billing charges auto-appear with zero manual entry by billing staff
- Cross-tenant isolation re-verified with new tables
- This phase deployed and usable by a real pilot clinic

---

## Phase 3 — Nurse Workflows & IPD Foundations (Tier 2 groundwork)
**Goal:** Add nurse task-board and basic IPD/bed tracking, laying groundwork for nursing-home-scale tenants.

### Definition of Done
- A tenant can admit a patient, assign a bed, and nurses/doctors see live-updating vitals and tasks
- Critical lab values trigger visible alerts, not passive queue entries
- Tier 2 feature flag correctly gates this module's visibility per tenant

---

## Phase 4 — Admin, Multi-Branch & Tier 3 Groundwork
**Goal:** Admin gets real visibility and control; groundwork laid for larger hospital tenants (OT, blood bank placeholders, insurance/TPA fields) without fully building them yet unless prioritized.

### Definition of Done
- Admin can see real metrics and manage users for their tenant
- Reconciliation view correctly flags billing mismatches
- Tier 3 schema exists and is flag-gated, even if UI is minimal
- Full error-handling audit passed against `rules.md`

---

## Phase 5 — Hardening, Testing & Pilot Launch Prep
**Goal:** Bug reduction, polish, and confidence before a real clinic uses this with real patient data.

### Definition of Done
- Zero known cross-tenant data leaks
- Critical path covered by at least one automated e2e test
- No console errors/warnings on core screens
- Product is ready for first real pilot clinic onboarding

---

## Cross-Phase Rules

1. **No phase begins until the previous phase's Definition of Done is met** — resist the urge to jump ahead on an exciting feature while the base is still shaky.
2. **Schema changes always come from the backend side first**, communicated before UI is built against it — avoids building against a shape that changes underneath.
3. **Cross-tenant isolation is tested whenever a new table is added** — don't rely on a single person's testing.
4. **Weekly sync point per phase minimum** — even async, confirm both tracks integrate before calling a phase done.
5. Any deviation from this plan (skipping a phase, reordering) should be a conscious decision, noted in this file, not a silent drift.

---

*This file should be updated as phases complete — mark actual completion dates and any scope changes, so it stays a living project tracker, not just an upfront plan.*
