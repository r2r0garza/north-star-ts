export function agentSourceLabel(
  sourceKind: string,
  systemName: string
): string {
  switch (sourceKind) {
    case "north_star":
      return systemName
    case "github":
      return "GitHub"
    case "copilot":
      return "Copilot"
    case "cursor":
      return "Cursor"
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    default:
      return sourceKind
        .replaceAll("_", " ")
        .replace(/\b\w/g, (character) => character.toUpperCase())
  }
}
