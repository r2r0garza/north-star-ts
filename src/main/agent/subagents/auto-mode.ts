export class SubagentAutoModeRelay {
  private enabled: boolean
  private readonly children = new Map<string, (enabled: boolean) => void>()

  constructor(
    enabled: boolean,
    private readonly onEnable: (conversationId: string) => void
  ) {
    this.enabled = enabled
  }

  set(enabled: boolean): void {
    this.enabled = enabled
    for (const [conversationId, update] of this.children) {
      update(enabled)
      if (enabled) this.onEnable(conversationId)
    }
  }

  register(
    conversationId: string,
    update: (enabled: boolean) => void
  ): () => void {
    this.children.set(conversationId, update)
    update(this.enabled)
    if (this.enabled) this.onEnable(conversationId)
    return () => {
      if (this.children.get(conversationId) === update) {
        this.children.delete(conversationId)
      }
    }
  }
}
