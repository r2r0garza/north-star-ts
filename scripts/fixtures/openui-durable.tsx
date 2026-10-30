import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "../../src/renderer/src/globals.css"
import { ConversationArtifact } from "../../src/renderer/src/components/conversation-artifact"
import type { ArtifactReference } from "../../src/shared/conversation-artifacts"
function App() {
  const [owner, setOwner] = useState<{
    conversationId: string
    reference: ArtifactReference
  }>()
  useEffect(() => {
    ;(
      window as unknown as { fixture: { reference(): Promise<typeof owner> } }
    ).fixture
      .reference()
      .then(setOwner)
  }, [])
  return (
    <main className="mx-auto max-w-xl p-5">
      <h1 className="text-xl font-semibold">Phase C durable artifact replay</h1>
      <button onClick={() => location.reload()}>Reload conversation</button>
      {owner && (
        <ConversationArtifact
          conversationId={owner.conversationId}
          reference={owner.reference}
        />
      )}
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
