import { describe, expect, it } from "vitest"
import type { Feature, Project } from "@/types"
import {
  filterFeatures,
  groupFeaturesByProject,
  isStaleFilter,
} from "./feature-project-filter"

const project = (id: string, position: number) =>
  ({ id, name: id, workspaceId: null, position }) as Project
const feature = (id: string, projectId: string | null, status = "draft") =>
  ({ id, projectId, status }) as Feature

const projects = [project("a", 0), project("b", 1), project("c", 2)]
const features = [
  feature("1", "a"),
  feature("2", "a", "completed"),
  feature("3", "c", "active"),
  feature("4", null, "paused"),
]

describe("groupFeaturesByProject", () => {
  it("counts every status, keeps zero-count projects, and project order", () => {
    const groups = groupFeaturesByProject(features, projects)
    expect(groups.total).toBe(4)
    expect(groups.unassigned).toBe(1)
    expect(
      groups.byProject.map(({ project, count }) => [project.id, count])
    ).toEqual([
      ["a", 2],
      ["b", 0],
      ["c", 1],
    ])
  })

  it("counts a feature whose project is unknown only in the total", () => {
    const groups = groupFeaturesByProject([feature("x", "gone")], projects)
    expect(groups.total).toBe(1)
    expect(groups.unassigned).toBe(0)
    expect(groups.byProject.every(({ count }) => count === 0)).toBe(true)
  })
})

describe("filterFeatures", () => {
  it("filters by selection", () => {
    const ids = (list: Feature[]) => list.map((item) => item.id)
    expect(ids(filterFeatures(features, { kind: "all" }))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ])
    expect(ids(filterFeatures(features, { kind: "none" }))).toEqual(["4"])
    expect(ids(filterFeatures(features, { kind: "project", id: "a" }))).toEqual(
      ["1", "2"]
    )
    expect(filterFeatures(features, { kind: "project", id: "b" })).toEqual([])
  })
})

describe("isStaleFilter", () => {
  const groups = groupFeaturesByProject(features, projects)
  it("flags a deleted project and an empty No-project bucket", () => {
    expect(isStaleFilter({ kind: "project", id: "gone" }, groups)).toBe(true)
    expect(
      isStaleFilter(
        { kind: "none" },
        groupFeaturesByProject([feature("1", "a")], projects)
      )
    ).toBe(true)
  })

  it("keeps All, live projects (even empty), and a non-empty bucket", () => {
    expect(isStaleFilter({ kind: "all" }, groups)).toBe(false)
    expect(isStaleFilter({ kind: "project", id: "b" }, groups)).toBe(false)
    expect(isStaleFilter({ kind: "none" }, groups)).toBe(false)
  })
})
