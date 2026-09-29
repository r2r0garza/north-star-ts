import type { Feature, Project } from "@/types"

// The Features tab's project rail selection (plan 106.10).
export type FeatureProjectFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "project"; id: string }

export const ALL_FEATURES: FeatureProjectFilter = { kind: "all" }

export interface FeatureProjectGroups {
  total: number
  unassigned: number
  // Every project, zero counts included, in the caller's (sidebar) order.
  byProject: Array<{ project: Project; count: number }>
}

export function groupFeaturesByProject(
  features: Feature[],
  projects: Project[]
): FeatureProjectGroups {
  const counts = new Map<string, number>()
  let unassigned = 0
  for (const feature of features) {
    if (feature.projectId === null) unassigned++
    else counts.set(feature.projectId, (counts.get(feature.projectId) ?? 0) + 1)
  }
  return {
    total: features.length,
    unassigned,
    byProject: projects.map((project) => ({
      project,
      count: counts.get(project.id) ?? 0,
    })),
  }
}

export function filterFeatures(
  features: Feature[],
  filter: FeatureProjectFilter
): Feature[] {
  if (filter.kind === "all") return features
  if (filter.kind === "none")
    return features.filter((feature) => feature.projectId === null)
  return features.filter((feature) => feature.projectId === filter.id)
}

// A selection the rail can no longer show (its project was deleted, or the
// "No project" row hid at zero) falls back to All.
export function isStaleFilter(
  filter: FeatureProjectFilter,
  groups: FeatureProjectGroups
): boolean {
  if (filter.kind === "none") return groups.unassigned === 0
  if (filter.kind === "project")
    return !groups.byProject.some((entry) => entry.project.id === filter.id)
  return false
}
