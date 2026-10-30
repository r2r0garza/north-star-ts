import { randomUUID } from "crypto"
import { getDb } from "../connection"
import {
  ARTIFACT_LIMITS,
  validateArtifactSnapshot,
  validateArtifactPresentation,
  artifactRowCount,
  isPresentationTool,
  PRESENTATION_TOOLS,
  type ArtifactEnvelope,
  type ArtifactReference,
  type ArtifactPresentation,
} from "../../../shared/conversation-artifacts"
import type { ToolCallLifecycle } from "../types"

const PRESENTATION_TOOL_SQL = Object.keys(PRESENTATION_TOOLS)
  .map((name) => `'${name}'`)
  .join(", ")

export class ArtifactQuotaError extends Error {}
export class ArtifactRevisionConflictError extends Error {}

interface RevisionRow {
  artifact_id: string
  revision: number
  conversation_id: string
  invocation_id: string
  snapshot: string
}
function envelope(row: RevisionRow): ArtifactEnvelope {
  if (Buffer.byteLength(row.snapshot) > ARTIFACT_LIMITS.bytes)
    throw new Error("Oversized artifact")
  const raw = JSON.parse(row.snapshot)
  if (raw.schemaVersion !== 1) throw new Error("Unsupported artifact version")
  const snapshot = validateArtifactSnapshot(raw)
  return {
    schemaVersion: 1,
    conversationId: row.conversation_id,
    invocationId: row.invocation_id,
    reference: {
      schemaVersion: 1,
      artifactId: row.artifact_id,
      revision: row.revision,
      kind: snapshot.kind,
      title: snapshot.title,
      rowCount: artifactRowCount(snapshot),
    },
    snapshot,
  }
}

// Called only within the lifecycle's successful settlement transaction.
export function persistConversationArtifact(
  owner: ToolCallLifecycle,
  input: ArtifactPresentation
): ArtifactReference {
  const db = getDb()
  if (
    !db.inTransaction ||
    owner.state !== "started" ||
    !isPresentationTool(owner.toolName) ||
    !owner.assistantMessageId
  )
    throw new Error(
      "Artifact requires an active durable presentation invocation."
    )
  const message = db
    .prepare(
      "SELECT tool_calls FROM messages WHERE id = ? AND conversation_id = ?"
    )
    .get(owner.assistantMessageId, owner.conversationId) as
    | { tool_calls: string | null }
    | undefined
  if (
    !message ||
    !JSON.parse(message.tool_calls ?? "[]").some(
      (c: { id: string; name: string }) =>
        c.id === owner.toolCallId && c.name === owner.toolName
    )
  )
    throw new Error("Artifact invocation owner is unavailable.")
  const validated = validateArtifactPresentation(
    input,
    PRESENTATION_TOOLS[owner.toolName]
  )
  const { artifactId, expectedBaseRevision, ...spec } = validated
  const snapshot = validateArtifactSnapshot(spec)
  let row = db
    .prepare(
      "SELECT * FROM conversation_artifact_revisions WHERE conversation_id = ? AND invocation_id = ?"
    )
    .get(owner.conversationId, owner.invocationId) as RevisionRow | undefined
  if (!row) {
    let revision = 1
    if (artifactId !== undefined) {
      const latest = db
        .prepare(
          "SELECT max(revision) AS revision FROM conversation_artifact_revisions WHERE artifact_id = ? AND conversation_id = ?"
        )
        .get(artifactId, owner.conversationId) as { revision: number | null }
      const base = readConversationArtifact(
        owner.conversationId,
        artifactId,
        expectedBaseRevision!
      ).artifact
      if (
        latest.revision !== expectedBaseRevision ||
        !base ||
        base.snapshot.kind !== snapshot.kind
      )
        throw new ArtifactRevisionConflictError(
          "Artifact revision conflict: use an owned artifact of the same kind and its current expectedBaseRevision."
        )
      revision = expectedBaseRevision! + 1
    }
    const serialized = JSON.stringify(snapshot)
    const bytes = Buffer.byteLength(serialized)
    const quota = db
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes FROM conversation_artifact_revisions WHERE conversation_id = ?"
      )
      .get(owner.conversationId) as { count: number; bytes: number }
    if (
      quota.count >= ARTIFACT_LIMITS.conversationRevisions ||
      quota.bytes + bytes > ARTIFACT_LIMITS.conversationBytes
    )
      throw new ArtifactQuotaError(
        "Conversation artifact quota exceeded; start a new conversation or present fewer snapshots."
      )
    row = {
      artifact_id: artifactId ?? randomUUID(),
      revision,
      conversation_id: owner.conversationId,
      invocation_id: owner.invocationId,
      snapshot: serialized,
    }
    db.prepare(
      "INSERT INTO conversation_artifact_revisions (artifact_id, revision, conversation_id, invocation_id, snapshot, byte_length) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      row.artifact_id,
      row.revision,
      row.conversation_id,
      row.invocation_id,
      row.snapshot,
      bytes
    )
  } else if (
    JSON.stringify(envelope(row).snapshot) !== JSON.stringify(snapshot) ||
    (artifactId !== undefined &&
      (row.artifact_id !== artifactId ||
        row.revision !== expectedBaseRevision! + 1))
  ) {
    throw new Error("Invocation already owns a different artifact snapshot.")
  }
  db.prepare(
    "INSERT INTO tool_result_artifacts (lifecycle_id, artifact_id, revision) VALUES (?, ?, ?)"
  ).run(owner.id, row.artifact_id, row.revision)
  return envelope(row).reference
}

export function readConversationArtifact(
  conversationId: string,
  artifactId: string,
  revision: number
):
  | { artifact: ArtifactEnvelope; error?: never }
  | { artifact?: never; error: string } {
  try {
    if (
      typeof conversationId !== "string" ||
      typeof artifactId !== "string" ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      return { error: "Artifact unavailable: invalid reference." }
    const row = getDb()
      .prepare(
        `SELECT r.* FROM conversation_artifact_revisions r
      WHERE r.conversation_id = ? AND r.artifact_id = ? AND r.revision = ?
      AND EXISTS (SELECT 1 FROM tool_result_artifacts a JOIN tool_call_lifecycle l ON l.id = a.lifecycle_id
        JOIN messages m ON m.id = l.assistant_message_id AND m.conversation_id = l.conversation_id
        WHERE a.artifact_id = r.artifact_id AND a.revision = r.revision
        AND l.conversation_id = r.conversation_id AND l.state = 'settled_success'
        AND EXISTS (SELECT 1 FROM json_each(coalesce(m.tool_calls, '[]')) c
          WHERE json_extract(c.value, '$.id') = l.tool_call_id
            AND json_extract(c.value, '$.name') = l.tool_name
            AND l.tool_name IN (${PRESENTATION_TOOL_SQL})))`
      )
      .get(conversationId, artifactId, revision) as RevisionRow | undefined
    return row
      ? { artifact: envelope(row) }
      : {
          error:
            "Artifact unavailable: reference missing or not owned by this conversation.",
        }
  } catch {
    return { error: "Artifact unavailable: unsupported or corrupt content." }
  }
}

export function toolArtifactReference(
  conversationId: string,
  toolCallId: string
): ArtifactReference | undefined {
  const row = getDb()
    .prepare(
      `SELECT r.* FROM conversation_artifact_revisions r
    JOIN tool_result_artifacts a ON a.artifact_id = r.artifact_id AND a.revision = r.revision
    JOIN tool_call_lifecycle l ON l.id = a.lifecycle_id
    WHERE l.conversation_id = ? AND l.tool_call_id = ? AND l.state = 'settled_success'
      AND r.conversation_id = l.conversation_id`
    )
    .get(conversationId, toolCallId) as RevisionRow | undefined
  if (!row) return undefined
  return readConversationArtifact(conversationId, row.artifact_id, row.revision)
    .artifact?.reference
}
