import { describe, expect, it } from "vitest"
import {
  renameTermIdentifier,
  renameTermValue,
  renameTermsInJson,
} from "./work-terms-migration"

describe("work term renames", () => {
  it("renames identifiers in their own style", () => {
    expect(renameTermIdentifier("slice", "snake")).toBe("user_story")
    expect(renameTermIdentifier("slice", "camel")).toBe("userStory")
    expect(renameTermIdentifier("slices", "camel")).toBe("userStories")
    expect(renameTermIdentifier("assign_slice", "snake")).toBe(
      "assign_user_story"
    )
    expect(renameTermIdentifier("between_missions", "snake")).toBe(
      "between_milestones"
    )
    expect(renameTermIdentifier("edit_initiative", "snake")).toBe(
      "edit_feature"
    )
    expect(renameTermIdentifier("sliceId", "camel")).toBe("userStoryId")
    expect(renameTermIdentifier("maxConcurrentSlices", "camel")).toBe(
      "maxConcurrentUserStories"
    )
    expect(renameTermIdentifier("maxPlanRevisionsPerMission", "camel")).toBe(
      "maxPlanRevisionsPerMilestone"
    )
    expect(renameTermIdentifier("initiativeId", "camel")).toBe("featureId")
  })

  it("leaves Mission Control, mission statements, and unrelated words alone", () => {
    expect(renameTermIdentifier("missionControl", "camel")).toBe(
      "missionControl"
    )
    expect(renameTermIdentifier("mission_control", "snake")).toBe(
      "mission_control"
    )
    expect(renameTermIdentifier("missionStatement", "camel")).toBe(
      "missionStatement"
    )
    expect(renameTermIdentifier("permission", "snake")).toBe("permission")
    expect(renameTermIdentifier("submission", "camel")).toBe("submission")
  })

  it("renames decision keys segment by segment and keeps ids", () => {
    expect(renameTermValue("slice_failed:abc-123:2")).toBe(
      "user_story_failed:abc-123:2"
    )
    expect(renameTermValue("budget:maxPlanRevisionsPerMission:soft")).toBe(
      "budget:maxPlanRevisionsPerMilestone:soft"
    )
    expect(renameTermValue("a slice of work")).toBe("a slice of work")
  })

  it("renames JSON keys and enum values but not the user's words or keys", () => {
    expect(
      renameTermsInJson({
        op: "add_slice",
        mission: "mission-1",
        slice: {
          key: "slice",
          title: "Slice the cake",
          dependsOn: ["mission"],
        },
        rights: ["assign_slice", "accept_proof"],
        budget: { key: "maxConcurrentSlices" },
      })
    ).toEqual({
      op: "add_user_story",
      milestone: "mission-1",
      userStory: {
        key: "slice",
        title: "Slice the cake",
        dependsOn: ["mission"],
      },
      rights: ["assign_user_story", "accept_proof"],
      budget: { key: "maxConcurrentUserStories" },
    })
  })
})
