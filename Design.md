# Design.md
## UI/UX & Visual Design System — Hospital MIS

**Companion to:** PRD.md, Architecture.md, phases.md
**Purpose:** Single source of truth for how the product looks, feels, and behaves — so Prince (and any AI tool generating UI code) builds consistent screens without re-deciding design choices feature by feature.

---

## 1. Design Philosophy

Three rules govern every screen in this product, derived directly from the PRD's persona research:

1. **Speed over polish.** A doctor should never wait on an animation, a nurse should never hunt for a button. Every design decision is judged against "does this make the 20%-most-used action faster or slower."
2. **Clarity over density.** Indian hospital staff use this on everything from a ₹8k tablet to a large desktop monitor, often in bright OPD rooms or dim wards. High contrast, large touch targets, no cramming.
3. **Calm, not clinical-cold.** Healthcare software tends to look either sterile-corporate or garish. This product should feel trustworthy and steady — more like a well-designed tool than a hospital form.

**Anti-goals:** no dashboard-for-dashboard's-sake charts, no decorative animation, no dense data tables where a doctor needs a quick glance instead, no generic "SaaS blue gradient" look.

---

## 2. Color System

### Philosophy
A **calm, desaturated base** with **one confident accent color**, plus a strict, small set of semantic colors for clinical meaning (never decorative). Color in this product should carry *meaning* (urgent, normal, pending) more than *branding*.

### Core Palette

| Token | Hex | Usage |
|---|---|---|
| `background` | `#F7F8FA` | App background, light neutral gray — not stark white (reduces glare in bright OPD rooms) |
| `surface` | `#FFFFFF` | Cards, panels, modals |
| `surface-muted` | `#EEF1F4` | Secondary panels, sidebar, disabled states |
| `border` | `#DDE2E7` | Dividers, input borders |
| `text-primary` | `#1A2027` | Main text — near-black, not pure black (softer on eyes) |
| `text-secondary` | `#5C6672` | Labels, metadata, timestamps |
| `text-disabled` | `#A0A8B1` | Placeholder, disabled text |

### Accent (Brand)

| Token | Hex | Usage |
|---|---|---|
| `accent` | `#0F766E` (teal) | Primary buttons, active nav, links, focus states |
| `accent-hover` | `#0D5F58` | Hover/pressed state |
| `accent-subtle` | `#E6F4F2` | Selected row background, subtle highlights |

*Why teal, not blue:* avoids the generic "every SaaS app is blue" look, while still reading as calm/medical/trustworthy. Distinct enough to be memorable, not loud enough to be tiring across all-day clinical use.

### Semantic Colors (used only for meaning, never decoration)

| Token | Hex | Usage |
|---|---|---|
| `success` | `#16A34A` | Confirmed save, normal vitals, completed task |
| `warning` | `#D97706` | Needs attention, pending, follow-up due |
| `critical` | `#DC2626` | Critical lab value, high-severity drug interaction, overdue task |
| `info` | `#2563EB` | Informational banners, new/unread indicators |

**Rule:** `critical` red is reserved *exclusively* for genuine clinical urgency (per PRD's silent-by-default alert philosophy). It must never be reused for generic UI errors like "field required" — use `text-secondary` + icon for those instead, so red retains its urgency signal.

### Dark Mode
Not required for MVP (OPD/ward environments are typically well-lit, and clinical color-coding — especially red/green for vitals — needs to stay unambiguous). Revisit only if night-shift ward usage becomes a real pain point post-pilot.

---

## 3. Typography

### Font Choice

| Use | Font | Why |
|---|---|---|
| UI / Latin text | **Inter** | Excellent legibility at small sizes, wide weight range, free, huge language/character support, used heavily in clinical/data UIs |
| Hindi / Devanagari | **Noto Sans Devanagari** | Pairs cleanly with Inter, free, designed for UI legibility, Google-maintained (reliable rendering across devices) |
| Other regional languages | **Noto Sans [Script]** family (e.g., Noto Sans Tamil, Noto Sans Bengali) | Same design family as Devanagari pairing — keeps visual consistency across every language the app supports |
| Numerals (vitals, doses, amounts) | Inter (tabular figures enabled) | Numbers must align in columns — always use `font-variant-numeric: tabular-nums` for vitals tables, billing, dosage fields |

### Type Scale

| Token | Size | Weight | Usage |
|---|---|---|---|
| `text-xs` | 12px | 400 | Timestamps, metadata |
| `text-sm` | 14px | 400 | Secondary labels, table body |
| `text-base` | 16px | 400 | Default body text |
| `text-lg` | 18px | 500 | Section headers, patient name in chart |
| `text-xl` | 22px | 600 | Screen titles |
| `text-2xl` | 28px | 700 | Critical alerts, key numbers (e.g., vitals value on rounds view) |

**Minimum size rule:** nothing below 14px anywhere in a doctor/nurse-facing screen — this is used on small tablets by people who don't have time to squint.

---

## 4. Spacing, Layout & Grid

- **Base unit:** 4px grid (spacing values: 4, 8, 12, 16, 24, 32, 48, 64)
- **Touch targets:** minimum 44×44px for any tappable element — this is a tablet-first product for ward/OPD use, not a mouse-precision desktop tool
- **Card padding:** 16px mobile / 24px desktop, consistent across all modules
- **Max content width:** 1280px on large desktop admin screens; clinical screens (doctor/nurse) stay narrower (~960px) to keep information scannable, not stretched
- **Layout pattern:** persistent left sidebar (role-based nav) + top bar (patient context / search / user menu) + main content area — consistent across all role dashboards so switching between Doctor/Nurse/Billing views (for multi-role staff) feels familiar

---

## 5. Component Design Principles

### Buttons
- Primary action = solid `accent` fill, one per screen/section max (no competing primary buttons)
- Secondary actions = outline style, `border` color
- Destructive actions (delete, discard) = `critical` color, always require confirmation
- Never disable a button without explaining why nearby (e.g., "Complete required fields" tooltip, not just a grayed-out mystery button)

### Forms
- Label above field, not placeholder-as-label (placeholders disappear on input — bad for error recovery and accessibility)
- Inline validation, shown on blur, not just on submit
- No mandatory red asterisks on clinical free-text fields (per PRD — doctor notes should never block save)
- Group related fields visually (e.g., vitals fields clustered, not one long undifferentiated list)

### Tables / Lists
- Zebra striping avoided (adds visual noise) — use whitespace and subtle borders instead
- Row hover state (`surface-muted`) for scanability
- Critical/urgent rows get a left-edge color bar (`critical` or `warning`), not a full-row color wash — keeps the table calm while still flagging urgency

### Cards (patient cards, queue items)
- Patient name always largest, boldest element on the card
- Status (waiting, in-consultation, done) shown as a small colored tag, top-right of card
- Avoid photos/avatars unless clinically useful — keep visual weight on data, not decoration

### Modals
- Reserved for genuinely interrupting actions (critical alerts, destructive confirmations)
- Never used for routine data entry that could be inline — modals break flow, and doctors specifically dislike being pulled out of context (per PRD)

### Loading & Empty States
- Skeleton loaders for content areas (not spinners) — feels faster, preserves layout stability
- Empty states always include a clear next action ("No patients in queue yet" + relevant call-to-action), never a bare "No data" message

---

## 6. Iconography

- **Icon set:** Lucide Icons (open-source, consistent stroke width, huge coverage, pairs well with Tailwind projects)
- **Style:** outline/stroke icons only (not filled) for a lighter, calmer visual weight — filled icons reserved only for active/selected states
- **Stroke width:** consistent 1.5–2px across the app
- Icons are always paired with a text label in primary navigation — never icon-only for critical actions (accessibility + reduces training time for non-tech-savvy staff)

---

## 7. Motion & Interaction

- **Minimal, functional motion only** — no decorative animation
- Transitions: 150–200ms ease-out for hover/focus states, 200–250ms for panel/modal open-close
- Realtime data updates (new queue entry, task completed) should **fade/slide in gently**, not pop abruptly — sudden UI jumps are disorienting in a live clinical environment
- No animation on data that changes frequently (vitals trend lines) — motion there would be distracting, not helpful

---

## 8. Role-Specific UI Notes

### Doctor
- Information-dense but calm — patient history, vitals trend, and prescribing tool visible without excessive scrolling
- Trend graphs (not raw number tables) for vitals — visual pattern recognition matters more than exact figures at a glance
- Prescription UI should feel closer to a fast search-and-select tool than a form

### Nurse
- Task-board = card/kanban style, not a data table — designed for quick visual triage ("what's due now") over detailed record-keeping
- Large tap targets, minimal text entry — most nurse interactions should be select/tap, not type

### Billing/Reception
- Dense, table-heavy UI is acceptable and expected here (this persona is comfortable with spreadsheet-like density, unlike doctors)
- Numbers must be highly legible — tabular figures, right-aligned amounts, clear currency formatting (₹ symbol, comma separators per Indian numbering system — e.g., ₹1,00,000 not ₹100,000)

### Admin
- Chart-forward dashboard acceptable here (this is the one persona where a "dashboard" aesthetic fits) — but charts should be simple (bar/line), never 3D or decorative

### Patient (if/when patient portal is built)
- Extremely minimal, large text, plain language — assume lowest tech-familiarity of any persona
- Status shown as simple visual states (waiting / in progress / done), not clinical terminology

---

## 9. Frontend Feature Checklist (design-relevant, ties to PRD)

- [ ] Silent-by-default alerts — low-severity notices as small inline badges, not modals; high-severity as clear, hard-to-miss (but not alarming-red-everywhere) interrupts
- [ ] Regional language switcher accessible from every screen's top bar, not buried in settings
- [ ] Offline/connectivity-lost state has a clear, calm banner (not a scary red error) — since MVP is cloud-only, this must be graceful, not broken-looking
- [ ] Every write action (save note, prescribe, bill) shows explicit success confirmation — a small toast, not just an assumed save
- [ ] Responsive breakpoints tested at: phone (patient/nurse quick-checks), tablet (primary device for doctor/nurse), desktop (primary for billing/admin)

---

## 10. Design Tokens (for implementation — Tailwind config reference)

```js
// tailwind.config.js (excerpt)
theme: {
  extend: {
    colors: {
      background: '#F7F8FA',
      surface: '#FFFFFF',
      'surface-muted': '#EEF1F4',
      border: '#DDE2E7',
      'text-primary': '#1A2027',
      'text-secondary': '#5C6672',
      'text-disabled': '#A0A8B1',
      accent: {
        DEFAULT: '#0F766E',
        hover: '#0D5F58',
        subtle: '#E6F4F2',
      },
      success: '#16A34A',
      warning: '#D97706',
      critical: '#DC2626',
      info: '#2563EB',
    },
    fontFamily: {
      sans: ['Inter', 'Noto Sans Devanagari', 'sans-serif'],
    },
    spacing: {
      // 4px base grid — Tailwind's default scale already aligns with this
    },
  },
}
```

---

## 11. What This Doc Does Not Cover (deliberately)

- Pixel-exact mockups per screen — this is a systemized design language, not a Figma file; specific screens get designed as they're built, using these tokens
- Marketing/landing-page design — this file governs the product application, not any external marketing site
- Native mobile app design — MVP is responsive web only, per Architecture.md boundaries

---

*Update this file whenever a real design decision is made or changed — new component pattern, color adjustment, font change. Like the other project docs, this should stay a living reference, not a one-time spec.*
