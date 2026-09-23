import type {
  AccountWithModels,
  ProcessRuntimeSlot,
  ProcessRuntimeSnapshot,
  ProcessRuntimeSnapshotSelection,
} from "@/types"

export interface RuntimeBadgeDisplay {
  // Compact badge text: the resolved model, prefixed by its account when known.
  label: string
  // Full detail for the hover title: account, model id, and where it came from.
  title: string
}

const SOURCE_LABELS: Record<ProcessRuntimeSnapshotSelection["source"], string> =
  {
    phase_agent: "Phase agent override",
    phase: "Phase override",
    run: "Run default",
    source_conversation: "Source conversation",
    default: "Global default",
  }

// Derive the runtime badge for one slot of a phase run from its persisted
// `runtime_snapshot` — the provider/model actually handed to the worker, which
// can differ from anything the agent's own metadata suggests. Returns null when
// there is nothing concrete to show (historical runs with no snapshot, or a
// snapshot that recorded only "use the default" with no account/model), so the
// caller keeps its legacy rendering.
export function runtimeBadgeDisplay(
  snapshot: ProcessRuntimeSnapshot | null | undefined,
  providers: AccountWithModels[],
  slot: ProcessRuntimeSlot = "worker"
): RuntimeBadgeDisplay | null {
  const selection = snapshot?.[slot]
  if (!selection?.modelId) return null

  const entry = selection.accountId
    ? providers.find((p) => p.account.id === selection.accountId)
    : undefined
  const model = entry?.models.find((m) => m.modelId === selection.modelId)
  const modelLabel = model?.modelName || selection.modelId
  const accountName = entry?.account.displayName

  const label = accountName ? `${accountName} / ${modelLabel}` : modelLabel
  const details = [
    accountName ??
      (selection.accountId ? "Account no longer available" : undefined),
    selection.modelId,
    `Runtime source: ${SOURCE_LABELS[selection.source]}`,
  ].filter(Boolean)

  return { label, title: details.join(" · ") }
}
