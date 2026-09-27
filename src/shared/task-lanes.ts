// Task runner lanes: each task kind runs in one, and each lane has its own
// number of slots, so background upkeep never delays work and Mission Control
// never makes a chat wait. Model API load is limited separately, by the
// model-request permits (agent/model-permits.ts).
export type TaskLane = "interactive" | "work" | "background"

export const TASK_LANE_SLOTS: Readonly<Record<TaskLane, number>> = {
  // Chats the user started.
  interactive: 2,
  // Process runs (user stories, hooks), seat wakes, todo runs. Sized so the
  // Mission Control concurrency budget, not this lane, sets how many user
  // stories run at once; matches the model-request permits.
  work: 6,
  // Indexing, conversation summaries, dashboard refreshes.
  background: 1,
}
