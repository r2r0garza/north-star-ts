// Re-export the persisted DB row types from the preload surface so renderer
// code can import them from a stable `@/types` path.
export type {
  Approval,
  ApprovalStatus,
  Conversation,
  Message,
  Mode,
  Task,
  TaskCheckpoint,
  TaskEvent,
  TaskStatus,
  Workspace,
} from "../../preload/index"

// ask_user_question types, surfaced for the QuestionPanel.
export type { Question, QuestionOption, QuestionAnswer } from "../../preload/index"
