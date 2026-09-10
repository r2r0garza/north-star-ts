export interface StreamCheckpointState<T> {
  segments: T[]
  streamCheckpoints: Record<string, T[]>
  streamRetrying: boolean
}

export interface StreamAttemptEvent {
  phase: "start" | "commit" | "rollback"
  attemptId: string
  retrying?: boolean
}

export function applyStreamAttempt<T, S extends StreamCheckpointState<T>>(
  state: S,
  event: StreamAttemptEvent
): S {
  if (event.phase === "start") {
    return {
      ...state,
      streamCheckpoints: {
        ...state.streamCheckpoints,
        [event.attemptId]: state.segments,
      },
      streamRetrying: false,
    }
  }

  const checkpoint = state.streamCheckpoints[event.attemptId]
  const streamCheckpoints = { ...state.streamCheckpoints }
  delete streamCheckpoints[event.attemptId]
  return {
    ...state,
    segments:
      event.phase === "rollback" && checkpoint ? checkpoint : state.segments,
    streamCheckpoints,
    streamRetrying: event.phase === "rollback" && event.retrying === true,
  }
}
