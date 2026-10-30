import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../../src/renderer/src/globals.css"
import { ConversationArtifact } from "../../src/renderer/src/components/conversation-artifact"
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "../../src/renderer/src/components/ui/message-scroller"
import type {
  ConversationArtifact as Snapshot,
  ArtifactReference,
} from "../../src/shared/conversation-artifacts"

const chart: Snapshot = {
  kind: "chart",
  schemaVersion: 1,
  title: "Observed revenue",
  source: "Synthetic qualification data",
  dataAsOf: "2026-10-21",
  chartKind: "line",
  xKey: "month",
  unit: "currency units",
  series: [{ key: "revenue", label: "Revenue" }],
  data: [
    { month: "Jan", revenue: 10 },
    { month: "Feb", revenue: null },
    { month: "Mar", revenue: 30 },
    { month: "Apr", revenue: 40 },
  ],
}
const table: Snapshot = {
  kind: "table",
  schemaVersion: 1,
  title: "Bounded results",
  source: "Synthetic qualification data",
  columns: Array.from({ length: 24 }, (_, i) => ({
    key: `v${i}`,
    label: `Metric ${i + 1}`,
    valueType: "number",
  })),
  data: Array.from({ length: 1000 }, (_, row) =>
    Object.fromEntries(
      Array.from({ length: 24 }, (_, column) => [
        `v${column}`,
        row === 2 ? null : 9 - (row % 10),
      ])
    )
  ),
}
const reference = (
  snapshot: Snapshot,
  artifactId: string
): ArtifactReference => ({
  schemaVersion: 1,
  artifactId,
  revision: 1,
  kind: snapshot.kind,
  title: snapshot.title,
  rowCount: snapshot.data.length,
})
let reads = 0
Object.assign(window, {
  cowork: {
    db: {
      artifacts: {
        read: async (conversationId: string, artifactId: string) => {
          reads++
          const snapshot = artifactId.startsWith("chart") ? chart : table
          return {
            artifact: {
              schemaVersion: 1,
              conversationId,
              invocationId: artifactId,
              reference: reference(snapshot, artifactId),
              snapshot,
            },
          }
        },
      },
    },
  },
  qualification: { reads: () => reads },
})

function App() {
  const [extra, setExtra] = useState(0)
  const [extraTables, setExtraTables] = useState(0)
  return (
    <main
      style={{ width: 360, maxWidth: "100%", height: "100vh", margin: "auto" }}
    >
      <button onClick={() => setExtra(extra + 1)}>Append artifact</button>
      <button onClick={() => setExtraTables(extraTables + 1)}>
        Append table
      </button>
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller style={{ height: "calc(100vh - 32px)" }}>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem>
                <p>Before the observations.</p>
              </MessageScrollerItem>
              <MessageScrollerItem>
                <ConversationArtifact
                  conversationId="qualification"
                  reference={reference(chart, "chart-1")}
                />
              </MessageScrollerItem>
              <MessageScrollerItem>
                <p>After the observations.</p>
              </MessageScrollerItem>
              <MessageScrollerItem>
                <ConversationArtifact
                  conversationId="qualification"
                  reference={reference(table, "table-1")}
                />
              </MessageScrollerItem>
              <MessageScrollerItem key="live" scrollAnchor>
                {Array.from({ length: extra }, (_, i) => (
                  <ConversationArtifact
                    key={i}
                    conversationId="qualification"
                    reference={reference(chart, `chart-${i + 2}`)}
                  />
                ))}
                {Array.from({ length: extraTables }, (_, i) => (
                  <ConversationArtifact
                    key={`table-${i}`}
                    conversationId="qualification"
                    reference={reference(table, `table-${i + 2}`)}
                  />
                ))}
                <p>End of saved results.</p>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
