import {
  deleteConversation,
  deleteConversations,
} from "../db/repositories/conversations"
import { deletePlanFiles } from "../agent/tools/plan-file"

export async function deleteConversationWithArtifacts(
  id: string
): Promise<void> {
  deleteConversation(id)
  await deletePlanFiles([id])
}

export async function deleteConversationsWithArtifacts(
  ids: Iterable<string>
): Promise<void> {
  const unique = [...new Set(ids)]
  deleteConversations(unique)
  await deletePlanFiles(unique)
}

export async function cleanupConversationArtifacts(
  ids: Iterable<string>
): Promise<void> {
  await deletePlanFiles(ids)
}
