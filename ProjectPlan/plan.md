# AI Upload Portal — End-to-End Delivery Plan (Design → Release)

## Context
A high-level MVP schedule already exists at
`C:\ShapeShifter_code\UI_designer\ProjectPlan\Upload_Portal_MVP_Timeline.xlsx`
("AI Upload Portal — MVP Schedule, Jun 15 – Aug 14 2026", 5 phases / 5 gates,
Praveer 80% + Scott support, sign-off by Hamish). This document expands that
timeline into a **Jira-ready breakdown**: Epics = phases, Stories with
acceptance criteria (AC), size, owner, and dependencies. The **ThreadValidate
CAD app already built this session** (`src/components/CadValidator.jsx`) is the
Phase-1 "Mock UI" deliverable and is reused, not rebuilt.

**Goal:** a garment-industry upload portal where vetted prospects upload a CAD
package (`.zip` = 1× `.xlsx` spec + many `.tmp` Gerber files), the system
deterministically validates it, an AI layer explains failures, and valid
submissions land in Google Drive — shippable by **Aug 14 2026**.

## Stack & assumptions (confirmed)
- **Frontend:** React 18 + Vite + Tailwind (existing app), `lucide-react`,
  `jszip` (client zip read), `jspdf` (report). Reuse `CadValidator.jsx`.
- **Backend:** Node (Express or Next.js API routes) for auth, upload handling,
  validation orchestration, Drive writes, notifications, AI proxy.
- **Storage:** Google Drive API (service account) — per-submission folders.
- **Auth:** invite-link / magic-link (no self-serve accounts in MVP).
- **AI guidance:** Anthropic Claude (default `claude-sonnet-4-6` for guidance;
  `claude-haiku-4-5` for cheap checklist hints). API key server-side only.
- **Notifications:** transactional email (e.g. SES/Resend/SendGrid).

## How to load into Jira
Create **5 Epics** (one per phase) + **1 cross-cutting Epic** (Security/IP &
Ops). Each `UP-x.y` below is a **Story**; bullet AC become the story's
acceptance criteria; **Gate** rows are **milestones**. Sizes: S ≈ ≤1d, M ≈
2–3d, L ≈ 4–5d.

---

## EPIC 0 — Spec & Workflows  → Gate 0 (Scott approves)
- **UP-0.1 Kickoff & MVP scope cut-list** — S — Scott + Praveer
  - AC: documented in/out list for MVP; explicit "not in MVP" (e.g. AI parsing
    of CAD geometry); agreed by both owners.
- **UP-0.2 Data spec — machine-checkable "valid submission"** — L — Scott
  - AC: enumerate accepted CAD formats; define `.tmp`/Gerber expectations;
    `.xlsx`/PO schema (required sheets, columns, types); list of deterministic
    validation rules; each rule expressed so it is automatable (no human
    judgment). This is the contract the validation engine (UP-2.5) implements.
- **UP-0.3 Paper workflow mockups (user journeys)** — M — Praveer
  - AC: end-to-end flows for invite → upload → validate → fix → resubmit →
    success; error/edge journeys covered.
- **Gate 0 milestone:** data spec & workflows approved by Scott. Blocks Epic 2.

## EPIC 1 — Mock UI & Approval  → Gate 1 (Hamish sign-off)
- **UP-1.1 Finalize interactive mock UI** — M — Praveer
  - AC: idle / selected / validating / fail / pass states; failed-file list with
    root cause + suggested fix; downloadable PDF report; ShapeShifter branding.
    *(Largely DONE — `CadValidator.jsx`, `downloadFailureReport`.)*
- **UP-1.2 Internal review of mock & consolidate feedback** — S — Praveer + Scott
  - AC: single consolidated feedback list (dedup'd) ready for stakeholder review.
- **UP-1.3 Book + run Hamish & stakeholder review** — S — Praveer *(book NOW — risk #1)*
  - AC: meeting held by ~Jun 29; decisions captured.
- **UP-1.4 Revise mock from consolidated feedback (single round)** — M — Praveer
  - AC: agreed changes applied; one round only.
- **Gate 1 milestone:** design sign-off (Hamish). **Build starts only after.**

## EPIC 2 — Core Build  → Gate 2 (E2E upload-to-Drive demo)
- **UP-2.1 Scaffolding, hosting & CI/CD** — M — Praveer/Steve
  - AC: repo + FE/BE app skeleton; dev/staging envs; automated build & deploy;
    env-var/secret management; health check.
- **UP-2.2 Invite-link authentication** — M — Praveer
  - AC: generate single-use/expiring invite links; gate the portal behind a
    valid link/session; revoke/expire; no public signup.
- **UP-2.3 Multi-file upload flow** — M — Praveer
  - AC: drag-drop + browse; `.zip` accepted; progress indicator; client size
    guard; clear states (extends existing drop zone).
- **UP-2.4 Google Drive integration** — L — Praveer
  - AC: service-account auth; per-submission folder (naming convention from
    UP-0.2); upload files; write a metadata log (who/when/result); least-priv
    scopes.
- **UP-2.5 Deterministic validation engine** — L — Scott + Praveer
  - AC: implements UP-0.2 rules — required files present, CAD/`.tmp` format
    checks, `.xlsx` schema checks; returns structured pass/fail + per-file
    reasons. **Replaces** the simulated `simulateTmpFailures()` in
    `CadValidator.jsx`; UI/report consume real results unchanged.
- **UP-2.6 Wire report to real results** — S — Praveer
  - AC: existing PDF report (`downloadFailureReport`) populated from real engine
    output; filename mirrors uploaded zip.
- **Gate 2 milestone:** working end-to-end upload → validate → Drive demo.

## EPIC 3 — AI Guidance  → Gate 3 (feature-complete demo)
- **UP-3.1 AI guidance layer (Anthropic Claude)** — L — Praveer
  - AC: explains *why* a file failed in plain language; answers format questions;
    shows a progress checklist; calls Claude **server-side** (key never in FE);
    scoped to guidance only (no CAD geometry parsing — risk #3); graceful
    fallback if API unavailable.
- **UP-3.2 Internal notifications (status emails)** — M — Praveer
  - AC: transactional email on submission outcome (pass/fail) to internal team;
    includes package name + summary + link.
- **UP-3.3 Internal E2E test with real cut-plan data** — M — Scott + Praveer
  - AC: 2–3 genuine client CAD+PO packages sourced by mid-July (risk #4); full
    flow exercised; defects logged.
- **Gate 3 milestone:** feature-complete demo (Hamish).

## EPIC 4 — Harden & Pilot  → Gate 4 (MVP LAUNCH, Aug 14)
- **UP-4.1 Bug fixes + security/access review (client IP)** — L — Praveer/Steve
  - AC: Drive access controls verified; data-handling note for prospects; secret
    review; dependency/vuln pass; auth/abuse review (risk #5).
- **UP-4.2 Friendly prospect pilot run** — M — Scott + Praveer
  - AC: one real prospect completes an upload; feedback + issues captured.
- **UP-4.3 Pilot fixes + runbook/docs** — M — Praveer
  - AC: pilot defects fixed; ops runbook (deploy, rotate keys, revoke invites,
    incident steps) + user-facing how-to.
- **UP-4.4 Contingency buffer** — — — buffer (do not fill speculatively).
- **Gate 4 milestone:** MVP launch (effective ship Fri Aug 14).

## CROSS-CUTTING EPIC — Security/IP & Ops (threaded through 2–4)
- **UP-X.1 Data-handling & IP note** — S — required, not nice-to-have (risk #5).
- **UP-X.2 Observability** — S — logging/metrics for uploads, validation
  outcomes, AI calls, errors.
- **UP-X.3 Secrets & key management** — S — Claude/Drive/email keys server-side,
  rotation documented.

## Risks → tracked mitigations (from your plan)
1. **Feedback-loop slip past Jul 2** → UP-1.3 booked now; one consolidated round.
2. **Spec ambiguity** → UP-0.2 must be machine-checkable by Gate 0 (blocks 2.5).
3. **AI scope creep** → UP-3.1 AC fixes scope to explanations + deterministic
   checks, not geometry parsing.
4. **Real test data** → UP-3.3 sources 2–3 packages by mid-July.
5. **Client IP** → UP-4.1 + UP-X.1 Drive controls + data-handling note.

## Definition of Done per gate (use as verification)
- **G0:** spec doc + workflow mockups approved by Scott; every validation rule
  is automatable.
- **G1:** mock signed off by Hamish; feedback closed.
- **G2:** a real `.zip` uploaded through the deployed app validates and lands in
  Drive with a metadata entry; report reflects real results.
- **G3:** real client data passes/fails correctly; AI explanations sensible;
  status email received; demoed to Hamish.
- **G4:** security/IP review closed; pilot completed; runbook published;
  launched.
