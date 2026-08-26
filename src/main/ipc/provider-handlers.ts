import { app, ipcMain } from "electron"
import * as providerAccountsRepo from "../db/repositories/provider-accounts"
import * as modelsRepo from "../db/repositories/models"
import * as secrets from "../settings/secrets"
import * as settingsService from "../settings/service"
import {
  fetchGatewayModelIds,
  hasActiveProvider,
  invalidate as invalidateProviderClient,
} from "../agent/providers"
import type { CreateAccountInput } from "../db/repositories/provider-accounts"
import type { AddModelInput } from "../db/repositories/models"
import type { LlmSettings } from "../settings/service"
import type { ModelEntry, ProviderAccount } from "../db/types"
import { CLAUDE_CODE_MODELS, detectClaudeCode } from "../agent/cli/claude"

// IPC for LLM provider accounts, their models, API keys (safeStorage), and the
// active selection. The renderer NEVER receives a plaintext key — only `hasKey`
// on the account shape and a masked string from `providers:getMaskedKey`. All
// secret handling stays in the main process (secrets.ts). Any change to an
// account's credentials or the active selection invalidates the cached client so
// the next turn rebuilds.

// An account plus its masked key state, the shape the Settings UI renders.
export interface AccountView extends ProviderAccount {
  maskedKey: string | null
}

function toView(account: ProviderAccount): AccountView {
  return { ...account, maskedKey: secrets.getMaskedApiKey(account.id) ?? null }
}

function clearMemoryForAccount(accountId: string): void {
  const memory = settingsService.getMemory()
  if (memory.accountId === accountId) {
    settingsService.setMemory({ ...memory, accountId: null, modelId: null })
  }
}

function clearTitleGenerationForAccount(accountId: string): void {
  const title = settingsService.getTitleGeneration()
  if (title.accountId === accountId) {
    settingsService.setTitleGeneration({ accountId: null, modelId: null })
  }
}

function clearMemoryForModel(accountId: string, modelId: string): void {
  const memory = settingsService.getMemory()
  if (memory.accountId === accountId && memory.modelId === modelId) {
    settingsService.setMemory({ ...memory, accountId: null, modelId: null })
  }
}

function clearTitleGenerationForModel(
  accountId: string,
  modelId: string
): void {
  const title = settingsService.getTitleGeneration()
  if (title.accountId === accountId && title.modelId === modelId) {
    settingsService.setTitleGeneration({ accountId: null, modelId: null })
  }
}

// An account plus its models — the unit the composer's grouped picker renders.
export interface AccountWithModels {
  account: AccountView
  models: ModelEntry[]
}

export function registerProviderHandlers(): void {
  // Whether secure key storage is usable — the UI checks before offering to save.
  ipcMain.handle("providers:secureStorageAvailable", () =>
    secrets.isSecureStorageAvailable()
  )

  // ── Accounts ──────────────────────────────────────────────────────────────
  ipcMain.handle("providers:list", () =>
    providerAccountsRepo.listAccounts().map(toView)
  )
  ipcMain.handle("providers:create", (_e, input: CreateAccountInput) => {
    const account = providerAccountsRepo.createAccount(input)
    if (account.provider === "claude_code") {
      for (const model of CLAUDE_CODE_MODELS) {
        const added = modelsRepo.addModel({
          accountId: account.id,
          modelId: model.id,
          modelName: model.name,
          origin: "seeded",
        })
        if (model.favorite) modelsRepo.updateModel(added.id, { favorite: true })
      }
    }
    return toView(account)
  })
  ipcMain.handle("providers:detectClaudeCode", () =>
    detectClaudeCode(app.getPath("userData"))
  )
  ipcMain.handle("providers:reorder", (_e, orderedIds: string[]) =>
    providerAccountsRepo.reorderAccounts(orderedIds).map(toView)
  )
  ipcMain.handle(
    "providers:update",
    (
      _e,
      id: string,
      patch: {
        displayName?: string
        baseUrl?: string | null
        enabled?: boolean
      }
    ) => {
      const account = providerAccountsRepo.updateAccount(id, patch)
      const llm = settingsService.getLlm()
      if (!account.enabled && llm.activeAccountId === id) {
        settingsService.setLlm({ activeAccountId: null, activeModelId: null })
      } else {
        invalidateProviderClient() // base_url or enabled may have changed
      }
      if (!account.enabled) clearMemoryForAccount(id)
      if (!account.enabled) clearTitleGenerationForAccount(id)
      return toView(account)
    }
  )
  ipcMain.handle("providers:delete", (_e, id: string) => {
    providerAccountsRepo.deleteAccount(id)
    // If the deleted account was active, clear the selection so the next turn
    // surfaces a clean "configure a provider" error instead of a stale id.
    const llm = settingsService.getLlm()
    if (llm.activeAccountId === id) {
      settingsService.setLlm({ activeAccountId: null, activeModelId: null })
    } else {
      invalidateProviderClient()
    }
    clearMemoryForAccount(id)
    clearTitleGenerationForAccount(id)
  })

  // ── API key (safeStorage; plaintext never leaves main) ──────────────────────
  // Returns { ok } or { ok:false, error } so the renderer can show a clear
  // message when secure storage is unavailable (no silent plaintext fallback).
  ipcMain.handle(
    "providers:setKey",
    (_e, id: string, plaintext: string): { ok: boolean; error?: string } => {
      try {
        secrets.setApiKey(id, plaintext)
        invalidateProviderClient()
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to store key.",
        }
      }
    }
  )
  ipcMain.handle("providers:clearKey", (_e, id: string) => {
    secrets.clearApiKey(id)
    invalidateProviderClient()
  })
  ipcMain.handle(
    "providers:getMaskedKey",
    (_e, id: string) => secrets.getMaskedApiKey(id) ?? null
  )

  // ── Models ──────────────────────────────────────────────────────────────
  ipcMain.handle("models:list", (_e, accountId: string) =>
    modelsRepo.listModels(accountId)
  )
  ipcMain.handle("models:add", (_e, input: AddModelInput) =>
    modelsRepo.addModel(input)
  )
  ipcMain.handle(
    "models:update",
    (
      _e,
      id: string,
      patch: { modelId?: string; modelName?: string | null; favorite?: boolean }
    ) => {
      const before = modelsRepo.getModel(id)
      const updated = modelsRepo.updateModel(id, patch)
      if (before && before.modelId !== updated.modelId) {
        clearMemoryForModel(before.accountId, before.modelId)
        clearTitleGenerationForModel(before.accountId, before.modelId)
      }
      return updated
    }
  )
  ipcMain.handle("models:delete", (_e, id: string) => {
    const model = modelsRepo.getModel(id)
    modelsRepo.deleteModel(id)
    if (model) clearMemoryForModel(model.accountId, model.modelId)
    if (model) clearTitleGenerationForModel(model.accountId, model.modelId)
    invalidateProviderClient() // the active model may have been removed
  })
  ipcMain.handle("models:deleteForAccount", (_e, accountId: string) => {
    modelsRepo.deleteModelsForAccount(accountId)
    const llm = settingsService.getLlm()
    if (llm.activeAccountId === accountId) {
      settingsService.setLlm({
        activeAccountId: accountId,
        activeModelId: null,
      })
    } else {
      invalidateProviderClient()
    }
    clearMemoryForAccount(accountId)
    clearTitleGenerationForAccount(accountId)
  })

  // Import the gateway catalog and merge it into the local list. On failure
  // returns { ok:false, error } and leaves the local list untouched.
  ipcMain.handle(
    "models:importFromGateway",
    async (_e, accountId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const ids = await fetchGatewayModelIds(accountId)
        modelsRepo.mergeGatewayModels(accountId, ids)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to fetch models from the gateway.",
        }
      }
    }
  )

  // Every account paired with its models, for the composer's grouped model
  // picker (so a user can switch provider+model per session without Settings).
  ipcMain.handle("providers:listWithModels", (): AccountWithModels[] =>
    providerAccountsRepo
      .listAccounts()
      .filter((account) => account.enabled)
      .map((account) => ({
        account: toView(account),
        models: modelsRepo.listModels(account.id),
      }))
  )

  // ── Default selection (the starting point for new conversations) ────────────
  // The per-conversation override is stored on the conversation row (db:
  // conversations:update with accountId/modelId); this is only the default.
  ipcMain.handle("providers:getDefault", () => settingsService.getLlm())
  ipcMain.handle("providers:setDefault", (_e, next: LlmSettings) =>
    settingsService.setLlm(next)
  )
  // Whether a usable provider+model is configured (drives first-launch + Send gate).
  ipcMain.handle("providers:hasActive", () => hasActiveProvider())
}
