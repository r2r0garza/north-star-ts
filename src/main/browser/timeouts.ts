// Per-action timeouts for agent browser handles. Navigation waits longest (real
// page loads); reads and interactions are quicker. All are bounded so a hung
// page can't wedge a turn.
export const NAVIGATE_TIMEOUT_MS = 30_000
export const SNAPSHOT_TIMEOUT_MS = 15_000
export const SCREENSHOT_TIMEOUT_MS = 15_000
export const INTERACT_TIMEOUT_MS = 15_000
