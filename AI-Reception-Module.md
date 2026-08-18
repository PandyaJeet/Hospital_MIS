# AI-Reception-Module.md
## AI Voice Assistant — Call Answering & Appointment Booking

**Companion to:** PRD.md, Architecture.md, rules.md, Design.md
**Status:** New module proposal — Phase placement suggested in Section 8

---

## 1. What This Module Is

An AI-powered phone assistant that answers incoming calls to a clinic/hospital, converses naturally (including in Hindi/regional languages), understands the caller's intent, and books, reschedules, or cancels appointments directly into the same `visits`/appointments data the rest of the system uses — without a human receptionist picking up.

**This is not a chatbot bolted onto a website.** It answers real phone calls, because that's still how the vast majority of Indian patients — especially in smaller towns, older patients, less tech-familiar users — actually try to reach a clinic.

---

## 2. Why This Matters (ties back to personas)

- **Patient**: no more busy signals, no more calling during a doctor's OPD hours and getting ignored, works 24/7 including after clinic hours for next-day booking
- **Reception/Billing staff**: freed from constant phone interruptions during in-person patient handling — the PRD already identified phone-juggling as a real friction point for this persona
- **Admin/Owner**: lower staffing cost for small clinics that can't afford a dedicated receptionist at all — this could be the feature that makes the product viable for genuinely small solo-doctor clinics, not just larger tenants
- **Doctor**: fewer walk-in/phone-driven schedule surprises — appointments land directly and correctly in the queue system doctors already see

---

## 3. Scope for MVP of This Module

### In scope
- Answer inbound calls, greet caller, understand spoken intent in Hindi + English (expand regional languages after validation)
- Book a new appointment (collect: patient name, phone, preferred date/time, doctor/department if applicable, reason for visit — brief, non-diagnostic)
- Check existing appointment status ("when is my appointment") for a known phone number
- Reschedule or cancel an existing appointment
- Hand off to a human (voicemail/callback queue or live transfer if staff available) when the request falls outside booking (medical questions, emergencies, complaints)
- Send an SMS/WhatsApp confirmation after booking, matching the existing patient-notification pattern in the PRD

### Explicitly out of scope (for this module, always)
- **No clinical advice, diagnosis, or triage of any kind.** This assistant books appointments — it does not answer "what's wrong with me" or "should I be worried about X symptom." Any such query gets an immediate, polite redirect to book an appointment or contact emergency services if the caller indicates urgency.
- **No handling of genuine emergencies.** The assistant must be able to recognize emergency language and immediately direct the caller to call emergency services / come to the ER, not attempt to book a routine slot.
- No payment collection over the call in MVP (billing stays in-person/existing flow)

---

## 4. How It Fits the Existing Architecture

This module plugs into the same Supabase-backed system already defined in `Architecture.md` — it's a new input channel into the same `visits`/appointments data, not a parallel system.

```
Inbound Call
    │
    ▼
Telephony Provider (e.g., Exotel, Knowlarity, Twilio — India-capable)
    │  (voice stream)
    ▼
Speech-to-Text (STT) ──► Conversational AI Layer ──► Text-to-Speech (TTS)
    │                          │
    │                          ▼
    │                 Appointment Booking Logic
    │                 (Edge Function — calls same
    │                  Supabase tables as the rest
    │                  of the app: patients, visits)
    │                          │
    └──────── response audio ◄─┘
                               │
                               ▼
                    tenant_id resolved from the
                    clinic's phone number mapping
                    (each tenant has a registered
                    number in a `tenant_phone_numbers`
                    table)
                               │
                               ▼
                 Appointment appears instantly in
                 Doctor's queue view, Billing's
                 registration record, etc. — same
                 "one event, many views" pattern
                 already used elsewhere in the app
```

**Key architectural point:** the AI assistant doesn't get its own separate booking system — it writes to the exact same `visits`/`patients` tables as the in-person registration flow, going through the same RLS/tenant isolation rules already defined in `rules.md`. A booking made by the AI assistant looks identical, downstream, to one made by a human at the counter.

---

## 5. Suggested Tech Approach

| Piece | Suggested approach | Notes |
|---|---|---|
| Telephony (answer calls, route numbers) | Exotel or Knowlarity (India-focused) or Twilio | Need per-tenant phone number provisioning; India-focused providers often handle local number compliance more smoothly |
| Speech-to-Text | Provider's built-in STT, or a dedicated multilingual STT API | Must handle Hindi + English + code-switching (callers often mix languages mid-sentence — very common in India) |
| Conversational logic | LLM-based (e.g., Claude via API) with a **strictly scoped system prompt** — booking-only, hard-boundaried against clinical questions | This is the "brain" — keep its job narrow, not a general assistant |
| Text-to-Speech | Provider's TTS or a dedicated multilingual TTS API | Natural-sounding Hindi/regional voice matters a lot for trust — a robotic voice will make patients hang up |
| Booking logic | Supabase Edge Function | Same DB, same RLS rules as the rest of the app — no separate booking database |
| Fallback/handoff | Call transfer to a real staff number, or voicemail-to-task (creates a "callback needed" task on Billing's task list) | Never leave a caller stuck with an AI that can't resolve their need |

**Cost note (ties to your "minimal financial burden" priority from earlier):** telephony + STT/TTS usage is usage-based (per-minute), not free like Supabase's tier — budget for this as a small per-call cost once you pilot it, but it requires no upfront infrastructure investment either. Suggest testing with a very limited pilot (one clinic, capped call volume) before wider rollout.

---

## 6. Conversation Design Principles

1. **Confirm, always.** Read back the booked date/time/doctor before ending the call — never assume the AI understood correctly without verification.
2. **Fail toward a human, not toward silence.** If the AI is uncertain twice in a row, it should offer to connect to staff or take a callback message — not keep guessing.
3. **Short turns, plain language.** Match the same "calm, clear, not clinical-cold" philosophy from `Design.md` — this applies to voice tone and script, not just visual UI.
4. **Never pretend to be human if asked.** If a caller asks "am I speaking to a person," the assistant states clearly that it's an automated assistant. This is both an honesty requirement and, in India, increasingly expected under telecom/consumer-protection norms for automated calling systems.
5. **Emergency detection is a hard gate, not a soft one.** Certain keywords/patterns (chest pain, unconscious, severe bleeding, "emergency") must immediately break out of the booking flow into a clear redirect script — this should be tested rigorously before any real pilot use.

---

## 7. Rules.md Additions (for AI coding + AI conversation behavior)

Add to `rules.md` when this module is built:

- The conversational AI's system prompt is version-controlled in the repo, not edited ad hoc in a provider dashboard — treat it like code, review changes
- No clinical claims, diagnosis, or symptom triage logic is ever added to this assistant's scope, even if requested for convenience later — this is a permanent boundary, not a v1 limitation
- Every call transcript is logged for quality review, but per PHI rules already established, transcripts must be stored securely and **never** included in general logs/error trackers — treat call transcripts with the same sensitivity as clinical notes
- Booking actions taken by the AI assistant must be tagged in the DB (e.g., `booked_via: 'ai_assistant'`) so staff can always distinguish AI-booked vs. human-booked appointments for audit/trust purposes

---

## 8. Suggested Phasing

This module is **not** part of the Tier 1 MVP — it's a strong differentiator to build *after* the core product (registration, OPD, prescriptions, billing) is validated with a real pilot clinic, since it depends on that same data model already being solid.

| Phase | Scope |
|---|---|
| Phase 5+ (post-MVP, after `phases.md`'s Phase 5 hardening) | Build AI Reception module: telephony integration, booking-only conversational flow, Hindi + English support, hard clinical/emergency boundaries, staff handoff path |
| Following phase | Expand regional language support, add reschedule/cancel flows, add call analytics for admin (calls answered, booking conversion rate) |

**Why after, not during, MVP:** the module's entire value depends on writing correctly into a `visits`/`patients` schema that needs to already be stable — building it in parallel with that schema still being designed would mean rebuilding the booking logic repeatedly. It also introduces a new cost line (telephony/STT/TTS) that's easier to justify once you have a real pilot clinic asking for it.

---

## 9. Open Questions

1. Which telephony provider has the best Hindi/regional STT+TTS quality and India phone-number compliance — needs a hands-on comparison before committing
2. Should there be a per-tenant toggle to disable AI reception and route straight to staff (some clinics may want human-only, at least initially, for trust reasons)?
3. What's the right escalation path when a clinic has no staff to hand off to at all (solo clinic, after hours) — pure voicemail-to-callback, or should the AI attempt to still complete the booking end-to-end unattended?
4. Legal/consent requirement check: does an automated calling assistant need a specific disclosure under Indian telecom regulations (TRAI) beyond just "this is an automated assistant"? Worth a compliance check before pilot.

---

*This module should be added to `Memory.md`'s source-of-truth table once work begins, and a dedicated contract (`docs/contracts/ai-reception.md`) written per the `Workflow.md` process before Prince/Jeet start building it in parallel.*
