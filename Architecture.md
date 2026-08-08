# Architecture.md
## Hospital MIS — Technical Architecture, Folder Structure & Tech Stack

**Version:** 1.0 (MVP — Cloud-hosted, Supabase + Vercel)
**Companion to:** Hospital-MIS-PRD-v2.md

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend framework | **Next.js (React)** | File-based routing, server + client components, deploys natively on Vercel, huge AI-tool familiarity |
| Styling | **Tailwind CSS** | Fast to build with, easy for AI tools to generate consistent UI, no design-system overhead for MVP |
| Backend / DB | **Supabase (Postgres)** | Managed DB + Auth + Storage + Realtime in one place, no server to run |
| Auth | **Supabase Auth** | Email/phone OTP login, role stored in `profiles` table, session handled client-side via Supabase SDK |
| ORM / DB access | **Supabase JS client** (`@supabase/supabase-js`) directly, no separate ORM | Fewer moving parts; RLS does the security work instead of app-layer checks |
| File storage | **Supabase Storage** | Prescriptions (PDF), lab reports, scanned documents |
| Hosting (frontend) | **Vercel** | Free tier, git-based deploys, zero server management |
| Hosting (backend) | **Supabase Cloud (Mumbai region if available)** | Managed, no VPS, data residency in India |
| Notifications | **WhatsApp Business API / Twilio** (Phase 2) | Patient-facing queue/report updates |
| PDF generation | **react-pdf** or a serverless function using **pdf-lib** | Prescription and invoice generation |
| State management | **React Context + Supabase Realtime subscriptions** | No Redux needed at this scale; realtime queue/task updates come straight from DB subscriptions |
| Language/i18n | **next-intl** or **react-i18next** | Hindi + regional language support |
| Testing | **Vitest** (unit) + **Playwright** (e2e, optional for MVP) | Lightweight, fast feedback for solo dev |

---

## 2. High-Level System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENT (Browser)                     │
│   Next.js App — role-based views (Doctor/Nurse/Billing/  │
│         Reception/Admin) — deployed on Vercel             │
└───────────────────────┬───────────────────────────────────┘
                         │  (Supabase JS SDK — REST + Realtime)
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    SUPABASE PROJECT                       │
│                                                             │
│   ┌───────────────┐   ┌───────────────┐   ┌────────────┐ │
│   │  Postgres DB   │   │  Supabase     │   │  Supabase  │ │
│   │  + Row-Level   │   │  Auth         │   │  Storage   │ │
│   │  Security      │   │  (roles/OTP)  │   │  (files)   │ │
│   └───────────────┘   └───────────────┘   └────────────┘ │
│                                                             │
│   ┌────────────────────────────────────────────────────┐ │
│   │  Realtime Engine (Postgres logical replication)     │ │
│   │  → pushes live updates to subscribed clients         │ │
│   │  (queue changes, new vitals, lab results, etc.)      │ │
│   └────────────────────────────────────────────────────┘ │
│                                                             │
│   ┌────────────────────────────────────────────────────┐ │
│   │  Edge Functions (serverless, optional)               │ │
│   │  → PDF generation, WhatsApp webhook, billing calc     │ │
│   └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
          ┌───────────────────────────────┐
          │  External integrations         │
          │  WhatsApp/SMS, GST/e-invoicing,│
          │  ABDM (deferred to later phase)│
          └───────────────────────────────┘
```

**Key architectural rule:** the frontend never talks to a custom backend server for CRUD operations — it talks to Supabase directly, and **Row-Level Security is the enforcement boundary for multi-tenancy**, not application code. Edge Functions are used only for things that genuinely need server-side logic (PDF generation, third-party webhooks, complex billing calculations) — not as a general-purpose API layer.

---

## 3. The "One Event, Many Views" Flow

This is the core interaction pattern from the PRD, translated into how data actually moves:

```
Doctor orders a lab test
        │
        ▼
INSERT into `lab_orders` table (tenant_id, patient_id, ordered_by, status='pending')
        │
        ├──► Realtime subscription on `lab_orders` (filtered by tenant_id)
        │        → Lab tech's queue view updates instantly
        │
        ├──► Realtime subscription on `lab_orders`
        │        → Nurse's task board shows "sample collection due"
        │
        ├──► DB trigger auto-inserts into `billing_line_items`
        │        → Billing counter's pending charges update automatically
        │
        └──► Edge Function triggered on insert
                 → Sends WhatsApp message to patient: "Test ordered"
```

Every persona's view is just a **filtered query or realtime subscription** on the same underlying tables — no duplicate data entry, no separate "notify billing" step for the doctor to remember.

---

## 4. Multi-Tenancy Model

- Every business table has a `tenant_id` column (foreign key to a `tenants` table)
- Every table has RLS policies like:
  ```sql
  create policy "tenant_isolation"
  on patients
  for all
  using (tenant_id = (select tenant_id from profiles where id = auth.uid()));
  ```
- A user's `tenant_id` is resolved from their `profiles` row (linked to Supabase Auth `auth.uid()`), never passed from the client as a trusted value
- Feature-tier flags (Tier 1/2/3) live on the `tenants` table itself — the frontend reads this to conditionally render modules (IPD, OT, blood bank, etc.)

---

## 5. Folder Structure

```
hospital-mis/
├── apps/
│   └── web/                          # Next.js application
│       ├── app/                      # App Router (Next.js 13+)
│       │   ├── (auth)/
│       │   │   ├── login/
│       │   │   └── onboarding/       # tenant + first-user setup
│       │   │
│       │   ├── (doctor)/
│       │   │   ├── queue/            # today's patient queue
│       │   │   ├── patient/[id]/     # patient chart, history, notes
│       │   │   ├── prescribe/        # prescription authoring
│       │   │   └── rounds/           # IPD rounds view (Tier 2+)
│       │   │
│       │   ├── (nurse)/
│       │   │   ├── tasks/            # task board (vitals, meds due)
│       │   │   └── vitals/[patientId]/
│       │   │
│       │   ├── (billing)/
│       │   │   ├── register/         # patient registration
│       │   │   ├── invoice/[id]/
│       │   │   └── reconciliation/   # end-of-day view
│       │   │
│       │   ├── (admin)/
│       │   │   ├── dashboard/        # tenant-level metrics
│       │   │   ├── users/            # role/user management
│       │   │   └── settings/         # tenant feature-tier, branding
│       │   │
│       │   ├── (patient)/            # optional lightweight patient portal
│       │   │   ├── queue-status/
│       │   │   └── reports/
│       │   │
│       │   ├── layout.tsx
│       │   └── page.tsx              # landing/redirect based on role
│       │
│       ├── components/
│       │   ├── ui/                   # shared primitives (button, modal, table)
│       │   ├── doctor/               # doctor-specific components
│       │   ├── nurse/
│       │   ├── billing/
│       │   └── shared/               # patient-card, queue-item, etc.
│       │
│       ├── lib/
│       │   ├── supabase/
│       │   │   ├── client.ts         # browser client
│       │   │   ├── server.ts         # server-side client (RSC/Edge Functions)
│       │   │   └── types.ts          # generated DB types
│       │   ├── auth/
│       │   │   └── getSession.ts
│       │   ├── i18n/
│       │   └── utils/
│       │
│       ├── hooks/
│       │   ├── useRealtimeQueue.ts
│       │   ├── usePatientHistory.ts
│       │   └── useTenant.ts
│       │
│       ├── styles/
│       ├── public/
│       ├── middleware.ts             # role-based route protection
│       └── next.config.js
│
├── supabase/
│   ├── migrations/                   # SQL migration files (schema history)
│   ├── functions/                    # Edge Functions
│   │   ├── generate-prescription-pdf/
│   │   ├── whatsapp-webhook/
│   │   └── billing-calc/
│   ├── seed.sql                      # sample data for dev
│   └── config.toml
│
├── packages/                         # (future) shared code if app splits further
│   └── shared-types/
│
├── docs/
│   ├── PRD.md
│   ├── Architecture.md               # this file
│   └── schema-diagram.png
│
├── .env.example
├── package.json
└── README.md
```

**Route grouping note:** the `(doctor)`, `(nurse)`, `(billing)`, `(admin)`, `(patient)` folders use Next.js route groups — they don't affect the URL path, just organize role-specific screens together and let `middleware.ts` apply role-based access control cleanly.

---

## 6. Core Database Tables (high level — full schema in a separate doc)

| Table | Purpose |
|---|---|
| `tenants` | One row per clinic/hospital; holds feature-tier flag, name, branding |
| `profiles` | Extends Supabase `auth.users`; holds `tenant_id`, `role` (doctor/nurse/billing/admin/patient) |
| `patients` | Patient master data, scoped by `tenant_id` |
| `visits` | OPD/IPD visit records, links patient ↔ doctor ↔ tenant |
| `clinical_notes` | Doctor's notes per visit |
| `prescriptions` + `prescription_items` | Prescribed drugs, dosage, linked to visit |
| `lab_orders` / `lab_results` | Diagnostic orders and results |
| `vitals` | Nurse-logged vitals, time-series per patient |
| `tasks` | Nurse task board items (vitals due, meds due, etc.) |
| `billing_line_items` / `invoices` | Auto-populated charges, GST-compliant invoicing |
| `beds` | IPD bed tracking (Tier 2+) |

All tables above carry `tenant_id` and are governed by RLS.

---

## 7. Auth & Role Flow

```
1. User signs up / is invited → Supabase Auth creates auth.users row
2. Trigger creates matching `profiles` row (tenant_id, role='pending')
3. Tenant admin assigns actual role (doctor/nurse/billing) from Admin panel
4. On login, middleware.ts reads role from profiles → redirects to
   the correct route group: /queue (doctor), /tasks (nurse), etc.
5. Every subsequent DB query is automatically scoped by RLS using
   auth.uid() → profiles.tenant_id — no manual filtering needed in app code
```

---

## 8. Deployment Flow

```
Local dev  →  git push  →  Vercel (frontend auto-deploy from main branch)
                        →  Supabase CLI (migrations pushed via `supabase db push`)

Environments:
  - Local:      .env.local → points to a Supabase dev project (or local Supabase via CLI)
  - Staging:    Vercel preview deploys → Supabase staging project
  - Production: Vercel production → Supabase production project (Mumbai region)
```

---

## 9. Where This Architecture Deliberately Stops (MVP Boundaries)

- No offline mode — every screen assumes connectivity to Supabase
- No custom backend server — Edge Functions handle the few cases that need server-side logic, nothing more
- No cross-tenant data sharing yet — `tenant_id` isolation is strict and total at this stage
- No native mobile app — responsive web app only, works on tablets/phones via browser

These boundaries match Section 9 ("Future Evolution Path") of the PRD — this architecture is intentionally the simplest version that lets a solo developer ship and validate the product first.

---

*This document should evolve alongside the PRD. Any architectural decision that changes multi-tenancy, auth, or the offline/online model should be reflected here before implementation.*
