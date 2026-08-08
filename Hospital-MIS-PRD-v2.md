# Product Requirements Document
## Multi-Tenant Hospital Management Information System (HMIS) for India
### Cloud-Hosted MVP Architecture (Supabase + Vercel)

**Version:** 2.0 (Revised for solo-developer, low-hassle build)
**Owner:** Product Team
**Status:** For Review

---

## 1. Executive Summary

A multi-tenant Hospital Management Information System for Indian healthcare providers — from a single-doctor clinic to larger multi-department hospitals — built as a **centrally-hosted, cloud-first web application** using Supabase (managed Postgres + auth + storage) and Vercel (frontend hosting).

This version deliberately **defers the local-first/offline-architecture** described in earlier planning in favor of the fastest, lowest-cost, most AI-development-friendly path to a working product. Offline-first local deployment remains a valid future direction (see Section 9) but is out of scope for this build.

**Core principles for this version:**
- Ship a real, usable product fast, as a solo developer, using well-documented, AI-tool-friendly infrastructure
- Zero infrastructure to self-manage — no servers, no VPS, no manual backups
- Multi-tenancy via a single shared database, isolated by `tenant_id` and enforced with Postgres Row-Level Security (RLS)
- Same role-first design philosophy as before: doctor, nurse, billing, patient, admin each get a purpose-built view, connected by shared data — not shared screens

---

## 2. What Changed From v1 (and Why)

| v1 Assumption | v2 Decision | Reason |
|---|---|---|
| Local-first, node-per-clinic, works fully offline | Cloud-hosted, single centralized backend | Dramatically simpler to build, deploy, and support solo; matches "minimal hassle" priority |
| Custom CRDT/event-sourced sync between nodes | No sync layer — single source of truth in Supabase | Removes the hardest, least AI-reliable engineering problem from MVP scope |
| Self-hosted PocketBase (SQLite) per node | Supabase-managed Postgres, single project | No server management; RLS gives clean multi-tenancy; no future SQLite-scaling ceiling |
| Cloud only for aggregation/admin | Cloud is the *only* environment — no local mode | Consistent with dropping offline-first for MVP |

**What did not change:** the persona-first design principles (Section 6 of v1), the tiered feature-activation model, and the long-term ambition around ABDM integration and cross-tenant referrals — these remain valid and are preserved below.

---

## 3. Problem Statement

*(Unchanged from v1 — restated briefly)*

Most Indian HMIS products are billing-first and clinician-last, leading doctors to revert to paper. Small clinics are priced out of enterprise systems; large hospitals outgrow basic ones. Referral continuity is poor, and billing leakage from manual charge capture is common. This product aims to fix the *user experience and data continuity* problems first, using the simplest infrastructure that lets a solo developer actually ship it.

---

## 4. Goals & Success Metrics (MVP-adjusted)

### Goals
1. Ship a working single-clinic product fast, with minimal infrastructure overhead
2. Achieve genuine daily use by doctors, not just billing/admin staff
3. Support multiple hospital tenants safely on one shared backend, with zero data leakage between tenants
4. Keep hosting cost at ₹0 through development and early pilot
5. Keep the codebase simple enough that AI coding tools (Claude Code etc.) can reliably extend it without introducing subtle multi-tenant bugs

### Success Metrics
- First pilot clinic fully onboarded and using the system for OPD + prescriptions within [X weeks of dev start]
- ₹0 hosting spend until real multi-clinic usage requires paid tier
- Zero cross-tenant data leakage incidents (verified via RLS policy tests)
- ≥80% of prescriptions issued digitally, not on paper, at pilot clinic
- <2 second load time for doctor's patient-history view

---

## 5. Architecture Overview

### 5.1 Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (or Next.js) on Vercel | Free tier; deploys directly from Git |
| Backend | Supabase (managed Postgres) | Free tier to start; handles DB, auth, storage, realtime |
| Auth | Supabase Auth | Role-based (doctor/nurse/billing/admin/patient) |
| File storage | Supabase Storage | Reports, scanned documents, prescriptions as PDF |
| Multi-tenancy | Single Supabase project, `tenant_id` column on every table, enforced via Row-Level Security | No per-tenant infra to manage |
| Data region | Supabase Mumbai (ap-south-1) region if available | Keeps hospital data within India |

### 5.2 How data flows

- One Supabase project serves **all tenants** (all clinics/hospitals using the product)
- Every table (patients, visits, prescriptions, billing, etc.) includes a `tenant_id` column
- RLS policies ensure a logged-in user can only ever query rows matching their own `tenant_id` — enforced at the database level, not just in application code, so even a bug in the frontend cannot leak another tenant's data
- Frontend (Vercel) calls Supabase directly via its client libraries — no custom backend server needed for most operations

### 5.3 What this architecture explicitly does NOT do (by design, for now)

- No offline operation — the app requires internet connectivity to function
- No local database on-premise at the clinic
- No custom sync/conflict-resolution logic
- No per-clinic physical hosting

These are conscious deferrals, not oversights — see Section 9 for how this evolves later.

### 5.4 Tiered Feature Activation (unchanged concept from v1)

Even without local-first architecture, the same-schema, tier-based module activation still applies:

| Tier | Modules Unlocked |
|---|---|
| 1 — Solo Clinic | Registration, OPD queue, prescriptions, basic billing |
| 2 — Small Hospital/Nursing Home | + IPD/beds, pharmacy inventory, lab orders, multi-user roles |
| 3 — Large Hospital | + OT scheduling, blood bank, radiology/PACS integration, insurance/TPA claims, multi-department workflows |

Tiers are just feature flags per `tenant_id` — no infrastructure change needed to move a tenant up a tier.

---

## 6. Functional Requirements by Persona

*(Carried forward from v1 — unchanged, since these are UX/workflow requirements independent of hosting choice)*

### 6.1 Doctor
- Patient history visible within 2 seconds of opening a file
- Queue view with new vs. follow-up flag, wait-time indicator
- Template + voice-dictation note entry, regional language support
- Prescription authoring with drug auto-suggest, dose defaults, generic/brand toggle
- Silent-by-default interaction/allergy checking; hard interrupt only for high-severity combinations
- One-tap condition-specific order sets
- Critical lab value push alerts
- Referral action transferring full case history (within-tenant for MVP; cross-tenant deferred — see Section 9)
- No mandatory fields blocking a clinical note from saving

### 6.2 Nurse
- Task-board UI: time-bound tasks per bed/patient
- Fast vitals entry with automatic trend-graph generation
- Barcode/QR-based medication administration
- Nursing entries auto-flow into doctor's rounds view

### 6.3 Reception / Billing
- Fast registration flow
- Automatic charge capture from every chargeable clinical event
- Insurance/TPA claim format support (CGHS, ESIC, major private TPAs)
- GST-compliant invoicing
- End-of-day reconciliation view

### 6.4 Patient
- Queue/token visibility (WhatsApp/SMS integration or in-app)
- Digital prescription delivery post-consultation
- Report push notification when diagnostics are ready

### 6.5 Admin (Tenant Owner)
- Dashboard: patient volume, revenue, occupancy, staff utilization (scoped to their `tenant_id`)
- User/role provisioning within their tenant

### 6.6 Platform Owner (You)
- Ability to view/manage all tenants at the database level (via Supabase dashboard directly during MVP — no custom super-admin UI needed yet)
- Per-tenant feature-tier flag management

---

## 7. Non-Functional Requirements (MVP-adjusted)

| Category | Requirement |
|---|---|
| Availability | Dependent on Supabase + Vercel uptime (both high-SLA managed services) |
| Performance | Doctor-facing screens load in <2 seconds on typical clinic broadband/4G |
| Data isolation | Enforced via Postgres RLS on every table — verified with explicit cross-tenant access tests before pilot launch |
| Data residency | Supabase project hosted in Mumbai region if available |
| Localization | Hindi + at least one regional language at launch |
| Cost | ₹0 through development; Supabase/Vercel free tiers sufficient for pilot with one clinic |
| Compliance | DPDP Act alignment for consent and data handling; ABDM integration deferred to post-MVP |

---

## 8. Out of Scope (this version)

- Offline/local-first operation (deferred — see Section 9)
- Custom multi-instance sync engine
- Cross-tenant patient record sharing (deferred until ABDM integration phase)
- Native PACS image viewer, OT robotics/device integration
- Insurance underwriting/claims adjudication (submission-format support only)
- Telemedicine video consultation

---

## 9. Future Evolution Path (post-MVP)

This is not abandoned — it's sequenced:

1. **Now (this PRD):** single Supabase project, cloud-only, one or a few pilot clinics, prove the product works and doctors actually want it
2. **Next:** if a clinic's connectivity proves unreliable in practice, introduce a lightweight offline cache (e.g., local browser storage + background sync) for critical read paths (patient history, prescriptions) — a much smaller problem than full local-first architecture
3. **Later:** if a genuinely large hospital or connectivity-poor rural clinic needs it, revisit true local-first deployment (local PocketBase/Postgres node + sync) as described in PRD v1 — by then, the product's data model and workflows will already be validated, so this becomes an infrastructure add-on, not a rebuild
4. **Later still:** ABDM/ABHA integration, cross-tenant consented record sharing, patient-facing app

---

## 10. Open Questions

1. At what pilot scale (number of tenants/concurrent users) will Supabase's free tier need to move to paid — and what's that cost threshold?
2. What's the right regional language priority order for launch (Hindi + which one next)?
3. Should the platform-owner (super-admin) view get a real UI in MVP, or is direct Supabase dashboard access sufficient for the pilot phase?
4. What's the minimum viable consent/DPDP-alignment implementation needed before onboarding a real clinic with real patient data?

---

## 11. Phasing (Proposed)

| Phase | Scope |
|---|---|
| Phase 1 | Tier 1 solo-clinic MVP: registration, OPD, prescriptions, basic billing, Supabase + Vercel live, RLS multi-tenancy tested |
| Phase 2 | Tier 2: IPD, pharmacy inventory, lab orders, multi-user roles within a tenant |
| Phase 3 | Tier 3: OT, blood bank, radiology integration, insurance/TPA, multi-branch admin dashboard |
| Phase 4 | Offline resilience layer, ABDM integration, cross-tenant referrals, patient-facing app |

---

*This PRD intentionally trades architectural ambition for shipping speed. The persona-first UX principles from v1 remain the product's core differentiator; the infrastructure underneath is now the simplest path to proving that UX works with a real clinic, rebuilt for more ambitious deployment only once that's validated.*
