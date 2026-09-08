import { getDb } from "../connection"
import type {
  ExternalAgentModelMapping,
  ExternalAgentModelSourceKind,
} from "../types"

interface ExternalAgentModelMappingRow {
  source_kind: ExternalAgentModelSourceKind
  source_model: string
  normalized_source_model: string
  destination_account_id: string
  destination_model_id: string
  created_at: number
  updated_at: number
}

export interface UpsertExternalAgentModelMappingInput {
  sourceKind: ExternalAgentModelSourceKind
  sourceModel: string
  destinationAccountId: string
  destinationModelId: string
}

export function normalizeSourceModel(sourceModel: string): string {
  return sourceModel.trim().replace(/\s+/g, " ").toLowerCase()
}

function assertInput(input: UpsertExternalAgentModelMappingInput): {
  normalizedSourceModel: string
  sourceModel: string
} {
  const sourceModel = input.sourceModel.trim()
  const normalizedSourceModel = normalizeSourceModel(sourceModel)
  if (!normalizedSourceModel) {
    throw new Error("Source model is required.")
  }
  if (!input.destinationAccountId.trim()) {
    throw new Error("Destination account is required.")
  }
  if (!input.destinationModelId.trim()) {
    throw new Error("Destination model is required.")
  }
  return { normalizedSourceModel, sourceModel }
}

function toMapping(
  row: ExternalAgentModelMappingRow
): ExternalAgentModelMapping {
  return {
    sourceKind: row.source_kind,
    sourceModel: row.source_model,
    normalizedSourceModel: row.normalized_source_model,
    destinationAccountId: row.destination_account_id,
    destinationModelId: row.destination_model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listMappings(): ExternalAgentModelMapping[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM external_agent_model_mappings
       ORDER BY source_kind ASC, updated_at DESC`
    )
    .all() as ExternalAgentModelMappingRow[]
  return rows.map(toMapping)
}

export function getMapping(
  sourceKind: ExternalAgentModelSourceKind,
  sourceModel: string,
  destinationAccountId: string
): ExternalAgentModelMapping | undefined {
  const normalized = normalizeSourceModel(sourceModel)
  if (!normalized) return undefined
  const row = getDb()
    .prepare(
      `SELECT * FROM external_agent_model_mappings
       WHERE source_kind = ?
         AND normalized_source_model = ?
         AND destination_account_id = ?`
    )
    .get(sourceKind, normalized, destinationAccountId) as
    | ExternalAgentModelMappingRow
    | undefined
  return row ? toMapping(row) : undefined
}

export function upsertMapping(
  input: UpsertExternalAgentModelMappingInput
): ExternalAgentModelMapping {
  const { normalizedSourceModel, sourceModel } = assertInput(input)
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO external_agent_model_mappings
        (source_kind, source_model, normalized_source_model, destination_account_id,
         destination_model_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, normalized_source_model, destination_account_id)
       DO UPDATE SET
         source_model = excluded.source_model,
         destination_model_id = excluded.destination_model_id,
         updated_at = excluded.updated_at`
    )
    .run(
      input.sourceKind,
      sourceModel,
      normalizedSourceModel,
      input.destinationAccountId,
      input.destinationModelId.trim(),
      now,
      now
    )
  return getMapping(input.sourceKind, sourceModel, input.destinationAccountId)!
}

export function deleteMapping(
  sourceKind: ExternalAgentModelSourceKind,
  sourceModel: string,
  destinationAccountId: string
): void {
  getDb()
    .prepare(
      `DELETE FROM external_agent_model_mappings
       WHERE source_kind = ?
         AND normalized_source_model = ?
         AND destination_account_id = ?`
    )
    .run(sourceKind, normalizeSourceModel(sourceModel), destinationAccountId)
}

export function deleteMappingsForAccount(destinationAccountId: string): void {
  getDb()
    .prepare(
      "DELETE FROM external_agent_model_mappings WHERE destination_account_id = ?"
    )
    .run(destinationAccountId)
}
