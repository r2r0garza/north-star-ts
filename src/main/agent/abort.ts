// Abort-reason sentinels, in a LEAF module (no heavy imports) so consumers can
// distinguish a shutdown from a genuine cancel without importing the agent barrel
// (`agent/index.ts`), which would close an import cycle through the tool graph
// (plan 038.3 found this: scheduler → agent barrel → tools/index → … ).

// A shutdown abort (app will-quit). A task/run aborted with this reason is RESUMABLE
// — the next boot's reconcile flips it interrupted→queued rather than settling it
// terminal. The runner uses it so a gate isn't fabricated as denied on quit (plan
// 012); the process scheduler uses it so an in-flight phase-run isn't terminally
// cancelled on quit (plan 038.3).
export const SHUTDOWN_ABORT_REASON = Symbol("agent:shutdown")

// A deliberate PAUSE abort (plan 008). Distinct from a plain cancel/stop so the
// runner maps the resulting {stopped} to `paused` (a durable resume state) rather
// than `cancelled` (terminal), and the process scheduler leaves in-flight phase-runs
// recoverable (plan 038.3). Re-exported from tasks/runner for back-compat.
export const PAUSE_ABORT_REASON = Symbol("task:pause")
