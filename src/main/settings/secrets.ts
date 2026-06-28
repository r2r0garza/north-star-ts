import { safeStorage } from "electron"
import * as providerAccounts from "../db/repositories/provider-accounts"

// Provider API-key secret handling. Keys are encrypted with Electron's
// safeStorage (OS keychain–backed) and stored ONLY as ciphertext in the
// provider account row. Plaintext exists transiently in the main process — to
// encrypt on save and to build the LLM client — and is never logged, never sent
// over IPC, and never persisted in the clear.
//
// Strict policy (per the 004 LLM-slice decision): if safeStorage is unavailable
// we do NOT fall back to plaintext — every setter/getter throws so the caller can
// surface a clear error. The env var is no longer a fallback either; a configured
// account's stored key is the only source.

export class SafeStorageUnavailableError extends Error {
  constructor() {
    super(
      "Secure key storage (OS keychain) is unavailable, so the API key cannot be " +
        "stored safely. The key was not saved."
    )
    this.name = "SafeStorageUnavailableError"
  }
}

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new SafeStorageUnavailableError()
}

// Whether secure storage is usable on this platform/session. The UI checks this
// before offering to save a key so it can show a clear error instead of failing
// mid-save.
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

// Encrypt and persist an account's API key. Throws if secure storage is
// unavailable (no plaintext fallback).
export function setApiKey(accountId: string, plaintext: string): void {
  assertAvailable()
  const ciphertext = safeStorage.encryptString(plaintext)
  providerAccounts.setEncryptedKey(accountId, ciphertext)
}

// Remove a stored key.
export function clearApiKey(accountId: string): void {
  providerAccounts.clearKey(accountId)
}

// Decrypt an account's key for use inside the main process (building the LLM
// client). Returns undefined when no key is stored. Throws if a key is stored but
// secure storage can't decrypt it (corrupt blob or keychain access lost) so the
// caller doesn't silently run unauthenticated.
export function getApiKey(accountId: string): string | undefined {
  const ciphertext = providerAccounts.getEncryptedKey(accountId)
  if (!ciphertext || ciphertext.length === 0) return undefined
  assertAvailable()
  return safeStorage.decryptString(ciphertext)
}

// A masked view of a stored key for the renderer (never the plaintext). Shows the
// last 4 chars, e.g. "sk-…abcd". Returns undefined when no key is set.
export function getMaskedApiKey(accountId: string): string | undefined {
  let plaintext: string | undefined
  try {
    plaintext = getApiKey(accountId)
  } catch {
    // Can't decrypt (e.g. keychain access lost) but a key IS stored — report a
    // neutral masked placeholder rather than leaking the failure as "no key".
    return "••••"
  }
  if (!plaintext) return undefined
  const tail = plaintext.slice(-4)
  return `••••${tail}`
}
