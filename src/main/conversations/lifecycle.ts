import {
  deleteConversation,
  deleteConversations,
} from "../db/repositories/conversations"
import { deletePlanFiles } from "../agent/tools/plan-file"
import { deleteChatScratchDirs } from "../agent/tools/chat_shell"

export async function deleteConversationWithArtifacts(
  id: string
): Promise<void> {
  deleteConversation(id)
  await deletePlanFiles([id])
  await deleteChatScratchDirs([id])
}

export async function deleteConversationsWithArtifacts(
  ids: Iterable<string>
): Promise<void> {
  const unique = [...new Set(ids)]
  deleteConversations(unique)
  await deletePlanFiles(unique)
  await deleteChatScratchDirs(unique)
}

export async function cleanupConversationArtifacts(
  ids: Iterable<string>
): Promise<void> {
  const unique = [...new Set(ids)]
  await deletePlanFiles(unique)
  await deleteChatScratchDirs(unique)
}
