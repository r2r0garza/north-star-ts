export type LiveMessageSegment =
  | { kind: "text"; text: string }
  | { kind: string }

export function liveMessageContent(segments: LiveMessageSegment[]): string {
  return segments
    .filter(
      (segment): segment is { kind: "text"; text: string } =>
        segment.kind === "text"
    )
    .map((segment) => segment.text)
    .join("")
}
