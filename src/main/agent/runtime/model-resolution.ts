import { getAccount } from "../../db/repositories/provider-accounts"
import { listModels } from "../../db/repositories/models"
import * as mappingsRepo from "../../db/repositories/external-agent-model-mappings"
import type {
  ExternalAgentModelMapping,
  ExternalAgentModelSourceKind,
  ModelEntry,
  ProviderAccount,
} from "../../db/types"

export type ExternalAgentModelResolution =
  | {
      status: "inherit"
      sourceKind: ExternalAgentModelSourceKind
      sourceModel: null
      destinationAccountId: string
      destinationModelId: string
      reason: "omitted" | "inherit"
      warnings: string[]
    }
  | {
      status: "exact"
      sourceKind: ExternalAgentModelSourceKind
      sourceModel: string
      destinationAccountId: string
      destinationModelId: string
      model: ModelEntry
      warnings: string[]
    }
  | {
      status: "saved"
      sourceKind: ExternalAgentModelSourceKind
      sourceModel: string
      destinationAccountId: string
      destinationModelId: string
      mapping: ExternalAgentModelMapping
      model: ModelEntry
      warnings: string[]
    }
  | {
      status: "unresolved"
      sourceKind: ExternalAgentModelSourceKind
      sourceModel: string
      destinationAccountId: string
      reason: "no_mapping" | "stale_mapping" | "missing_account"
      mapping?: ExternalAgentModelMapping
      models: ModelEntry[]
      warnings: string[]
    }

export interface ResolvedMappingView extends ExternalAgentModelMapping {
  destinationAccount: ProviderAccount | null
  destinationModel: ModelEntry | null
  stale: boolean
}

function isInheritToken(sourceModel: string | null | undefined): boolean {
  return (
    sourceModel == null ||
    sourceModel.trim() === "" ||
    sourceModel.trim().toLowerCase() === "inherit"
  )
}

export function resolveExternalAgentModel(input: {
  sourceKind: ExternalAgentModelSourceKind
  sourceModel?: string | null
  destinationAccountId: string
  conversationModelId: string
}): ExternalAgentModelResolution {
  if (isInheritToken(input.sourceModel)) {
    return {
      status: "inherit",
      sourceKind: input.sourceKind,
      sourceModel: null,
      destinationAccountId: input.destinationAccountId,
      destinationModelId: input.conversationModelId,
      reason:
        input.sourceModel?.trim().toLowerCase() === "inherit"
          ? "inherit"
          : "omitted",
      warnings: [],
    }
  }

  const sourceModel = input.sourceModel!.trim()
  const account = getAccount(input.destinationAccountId)
  if (!account || !account.enabled) {
    return {
      status: "unresolved",
      sourceKind: input.sourceKind,
      sourceModel,
      destinationAccountId: input.destinationAccountId,
      reason: "missing_account",
      models: [],
      warnings: ["Destination account is missing or disabled."],
    }
  }

  const models = listModels(input.destinationAccountId)
  const exact = models.find((model) => model.modelId === sourceModel)
  if (exact) {
    return {
      status: "exact",
      sourceKind: input.sourceKind,
      sourceModel,
      destinationAccountId: input.destinationAccountId,
      destinationModelId: exact.modelId,
      model: exact,
      warnings: [],
    }
  }

  const mapping = mappingsRepo.getMapping(
    input.sourceKind,
    sourceModel,
    input.destinationAccountId
  )
  if (mapping) {
    const mapped = models.find(
      (model) => model.modelId === mapping.destinationModelId
    )
    if (mapped) {
      return {
        status: "saved",
        sourceKind: input.sourceKind,
        sourceModel,
        destinationAccountId: input.destinationAccountId,
        destinationModelId: mapped.modelId,
        mapping,
        model: mapped,
        warnings: [],
      }
    }
    return {
      status: "unresolved",
      sourceKind: input.sourceKind,
      sourceModel,
      destinationAccountId: input.destinationAccountId,
      reason: "stale_mapping",
      mapping,
      models,
      warnings: [
        `Saved mapping points at missing model '${mapping.destinationModelId}'.`,
      ],
    }
  }

  return {
    status: "unresolved",
    sourceKind: input.sourceKind,
    sourceModel,
    destinationAccountId: input.destinationAccountId,
    reason: "no_mapping",
    models,
    warnings: [],
  }
}

export function listMappingViews(): ResolvedMappingView[] {
  return mappingsRepo.listMappings().map((mapping) => {
    const destinationAccount = getAccount(mapping.destinationAccountId) ?? null
    const destinationModel =
      listModels(mapping.destinationAccountId).find(
        (model) => model.modelId === mapping.destinationModelId
      ) ?? null
    return {
      ...mapping,
      destinationAccount,
      destinationModel,
      stale: !destinationAccount || !destinationModel,
    }
  })
}
