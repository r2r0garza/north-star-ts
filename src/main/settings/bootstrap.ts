import * as providerAccountsRepo from "../db/repositories/provider-accounts"
import * as modelsRepo from "../db/repositories/models"
import * as secrets from "../settings/secrets"
import * as settingsService from "../settings/service"
import { DEFAULT_MODEL, DEFAULT_PORTKEY_BASE_URL } from "../agent/providers"

// One-time migration from the pre-settings world: if no provider accounts exist
// yet but an API key is present in the environment (.env.local's NEXT_apiKey or
// the system PORTKEY_API_KEY — how the app was configured before this slice),
// seed a Portkey account from it so existing dev setups keep working without
// re-entering the key. After this runs, the stored account is the source of
// truth; the env var is NOT consulted again at runtime.
//
// Safe to call on every boot: it no-ops once any account exists. Failures
// (e.g. secure storage unavailable) are swallowed — the user can still configure
// a provider manually in Settings.
export function seedProviderFromEnvIfEmpty(): void {
  try {
    if (providerAccountsRepo.listAccounts().length > 0) return
    const envKey = process.env.NEXT_apiKey ?? process.env.PORTKEY_API_KEY
    if (!envKey) return
    if (!secrets.isSecureStorageAvailable()) return

    const account = providerAccountsRepo.createAccount({
      provider: "portkey",
      displayName: "Portkey",
      baseUrl: DEFAULT_PORTKEY_BASE_URL,
    })
    secrets.setApiKey(account.id, envKey)
    const model = modelsRepo.addModel({
      accountId: account.id,
      modelId: DEFAULT_MODEL,
      origin: "seeded",
    })
    settingsService.setLlm({
      activeAccountId: account.id,
      activeModelId: model.modelId,
    })
  } catch (err) {
    console.error(
      "Provider env-seed failed (configure a provider in Settings):",
      err
    )
  }
}
