import * as providerAccountsRepo from "../../db/repositories/provider-accounts"
import * as settingsService from "../../settings/service"
import type { LlmSelection } from "./index"

// Whether the account a selection resolves to accepts image input. Read before
// resolveLlm (the context build replays retained tool images), so it never
// throws: an unresolvable selection reports true and resolveLlm surfaces the
// real error afterward.
export function selectionAcceptsImages(
  sel: LlmSelection = { accountId: null, modelId: null }
): boolean {
  try {
    const accountId = sel.accountId ?? settingsService.getLlm().activeAccountId
    if (!accountId) return true
    return providerAccountsRepo.getAccount(accountId)?.acceptsImages ?? true
  } catch {
    return true
  }
}
