export interface SteeringInput {
  id: string
  message: string
  attachments: string[]
  skills: string[]
}

export interface SteeringMessage extends SteeringInput {
  conversationId: string
  runId: string
  createdAt: number
  status: "queued" | "returned"
}

export interface SteeringState {
  runId: string | null
  messages: SteeringMessage[]
}
