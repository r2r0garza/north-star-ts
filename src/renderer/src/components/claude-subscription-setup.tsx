import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { ClaudeSubscriptionPreflight } from "@/types"

export function ClaudeSubscriptionSetup({
  accountId,
  onChecked,
  onModelsChanged,
}: {
  accountId?: string
  onChecked?: (ready: boolean) => void
  onModelsChanged?: () => Promise<void>
}) {
  const [status, setStatus] = useState<ClaudeSubscriptionPreflight | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function check(refresh = false) {
    setBusy(true)
    setHint(null)
    onChecked?.(false)
    try {
      if (refresh && accountId) {
        const result =
          await window.cowork.providers.refreshClaudeSubscriptionModels(
            accountId
          )
        setStatus(result.preflight)
        setHint(result.catalog?.hint ?? null)
        onChecked?.(result.preflight.ok)
        if (result.ok) await onModelsChanged?.()
      } else {
        const result =
          await window.cowork.providers.preflightClaudeSubscription()
        setStatus(result)
        onChecked?.(result.ok)
      }
    } catch {
      setStatus(null)
      setHint(
        "Could not check subscription setup. Recheck the official CLI installation and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-xs">
      <p className="text-amber-700 dark:text-amber-300">
        Experimental integration, not an officially supported API. Uses your
        host's official Claude Code CLI login; personal Pro/Max only. All
        subscription entries share that login.
      </p>
      <p>
        Install the official native Claude Code CLI yourself, then run{" "}
        <code>claude auth login</code> in your terminal. North Star does not
        install, update or sign in for you. Organization, API-key and token-only
        configurations are not supported in this release; do not bypass managed
        policy.
      </p>
      <p>
        Requests consume subscription allowances and may use account-configured
        usage credits or overages. List-price cost estimates are unverified and
        are not your bill. Model visibility does not prove entitlement.
      </p>
      <p>
        North Star owns tools, approvals and conversation history. Container
        selection applies to tools; model inference still runs through the host
        CLI.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void check()}
        >
          {busy ? (
            <Spinner />
          ) : status ? (
            "Recheck CLI login"
          ) : (
            "Check CLI login"
          )}
        </Button>
        {accountId && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void check(true)}
          >
            Refresh CLI models
          </Button>
        )}
      </div>
      {status && (
        <p
          role="status"
          className={status.ok ? "text-muted-foreground" : "text-destructive"}
        >
          {status.version ? `Claude Code ${status.version}. ` : ""}
          {status.hint}
        </p>
      )}
      {hint && <p role="status">{hint}</p>}
    </div>
  )
}
