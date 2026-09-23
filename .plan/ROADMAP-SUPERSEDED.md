# Roadmap — Superseded

- **`039` — Inspectable Process consultations / Agent exchanges.** Superseded by `106` Mission Control.
  Its result-integrity prerequisite (explicit phase results) is folded into `106.3` and applies to all
  Processes; same-run consultation is replaced by `106.4`'s addressable seat messaging, including an
  answer-only wake for finished workers that preserves `039`'s safety invariant. The user observes all
  exchanges in Comms.
- **`070` — Pods: autonomous agent teams with mutable work graphs.** Superseded by `106` Mission Control,
  which keeps the seed's thesis (mutable work graph, user-owned definition of done, budgets, independent
  verification, no second runtime) and makes it concrete as Seat → Pod → Rig topology over an
  Initiative → Mission → Slice map driven by a deterministic Navigator.
- **`078` + `079` — Global repetition detection and automatic skill drafting.** Superseded by `087`,
  which detects opportunities per meaningful root request, validates them after successful execution,
  and generates an inert draft only after the user opts in. The stable-ID plan files remain for history.
- **`018` — Agentic goal mode.** Superseded by `025`, whose general Process engine can represent
  `018`'s fixed plan → execute → review → fix → finalize pipeline as a built-in Process
  template. The stable-ID plan file remains for history; it is not queued implementation work.
