import { createRoot } from "react-dom/client"
import "../../src/renderer/src/globals.css"
import {
  ArtifactChoiceContext,
  ConversationArtifact,
} from "../../src/renderer/src/components/conversation-artifact"
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "../../src/renderer/src/components/ui/message-scroller"
import {
  validateUiConceptSnapshot,
  type ArtifactReference,
  type UiConceptSnapshot,
} from "../../src/shared/conversation-artifacts"

// Representative PR116 redesign requests, validated by the real contract.
const settings = validateUiConceptSnapshot({
  title: "Notification settings redesign",
  description: "Tabs group channels; each preference is a labelled switch.",
  tree: {
    type: "stack",
    gap: "lg",
    children: [
      { type: "text", role: "heading", text: "Notifications" },
      {
        type: "tabs",
        tabs: [
          {
            label: "Email",
            children: [
              {
                type: "field",
                label: "Weekly summary",
                orientation: "horizontal",
                control: { type: "switch", defaultChecked: true },
              },
              {
                type: "field",
                label: "Digest address",
                control: { type: "input", inputType: "email" },
              },
            ],
          },
          {
            label: "Push",
            children: [
              {
                type: "field",
                label: "Frequency",
                control: { type: "select", options: ["Instant", "Hourly"] },
              },
            ],
          },
        ],
      },
      {
        type: "row",
        justify: "end",
        children: [{ type: "button", text: "Save preferences" }],
      },
    ],
  },
})
const listDetail = validateUiConceptSnapshot({
  title: "Inbox list/detail",
  density: "compact",
  tree: {
    type: "grid",
    columns: 2,
    children: [
      {
        type: "card",
        title: "Conversations",
        children: [
          {
            type: "table",
            columns: ["From", "Subject"],
            rows: [
              ["Ana", "Invoice"],
              ["Ben", "Roadmap"],
            ],
          },
          { type: "button", text: "Open Ana", goTo: "detail" },
        ],
      },
      { type: "card", title: "Preview", surface: "muted", children: [] },
    ],
  },
  states: [
    {
      id: "detail",
      label: "Ana's conversation",
      tree: {
        type: "stack",
        children: [
          { type: "text", role: "heading", text: "Invoice from Ana" },
          { type: "button", text: "Back to list", goTo: "initial" },
        ],
      },
    },
  ],
})
const dashboard = (title: string, typeScale?: "sm" | "lg") =>
  validateUiConceptSnapshot({
    title,
    ...(typeScale ? { typeScale } : {}),
    tree: {
      type: "grid",
      columns: 3,
      children: ["Active users", "Errors", "Latency"].map((label) => ({
        type: "card",
        title: label,
        children: [
          { type: "text", role: "heading", text: "Sample" },
          { type: "badge", text: "sample data", variant: "outline" },
        ],
      })),
    },
  })
const longText = validateUiConceptSnapshot({
  title: "Long content",
  tree: { type: "text", text: "x".repeat(500) },
})
const ideas = validateUiConceptSnapshot({
  title: "Four dashboard ideas",
  alternatives: ["Card grid", "Table first", "Split view", "Timeline"].map(
    (label, i) => ({
      id: `idea${i + 1}`,
      label,
      tree: { type: "text", role: "heading", text: `${label} layout` },
    })
  ),
})
const revisions: Record<string, UiConceptSnapshot[]> = {
  ideas: [ideas],
  settings: [settings],
  list: [listDetail],
  dashboard: [dashboard("Dashboard concept"), dashboard("Dashboard v2", "lg")],
  long: [longText],
}
let reads = 0
const choices: unknown[] = []
Object.assign(window, {
  cowork: {
    db: {
      artifacts: {
        read: async (
          conversationId: string,
          artifactId: string,
          revision: number
        ) => {
          reads++
          const snapshot = revisions[artifactId][revision - 1]
          return {
            artifact: {
              schemaVersion: 1,
              conversationId,
              invocationId: `${artifactId}-${revision}`,
              reference: reference(artifactId, revision),
              snapshot,
            },
          }
        },
      },
    },
  },
  qualification: { reads: () => reads, choices },
})
function reference(artifactId: string, revision = 1): ArtifactReference {
  return {
    schemaVersion: 1,
    artifactId,
    revision,
    kind: "ui_concept",
    title: revisions[artifactId][revision - 1].title,
    rowCount: 0,
  }
}
const items: Array<[string, number]> = [
  ["settings", 1],
  ["list", 1],
  ["dashboard", 1],
  ["dashboard", 2],
  ["long", 1],
  ["ideas", 1],
]
function App() {
  return (
    <main
      style={{ width: 360, maxWidth: "100%", height: "100vh", margin: "auto" }}
    >
      <ArtifactChoiceContext.Provider value={(choice) => choices.push(choice)}>
        <MessageScrollerProvider>
          <MessageScroller style={{ height: "100vh" }}>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                {items.map(([id, revision]) => (
                  <MessageScrollerItem key={`${id}-${revision}`}>
                    <p>Prose before {id}.</p>
                    <ConversationArtifact
                      conversationId="qualification"
                      reference={reference(id, revision)}
                    />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </ArtifactChoiceContext.Provider>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
