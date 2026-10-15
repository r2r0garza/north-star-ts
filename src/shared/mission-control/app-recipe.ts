import { lowerFirst } from "./app-launch"

// Recipe state and its plain-language side (plan 112.3). Whether a
// workspace's app launch recipe is known to start the app, per branch, and
// what the user is asked when recipe repair can't make it start. Shared by
// the main process (which verifies, repairs, and records) and the renderer
// (which shows the state and the question's choices). Pure.

// Plan 112, design B: what a failed run says about where the fault is.
// `environment`: the app didn't run (recipe repair); `feature`: it ran and
// misbehaved (the story is rejected); `test_defect`: QA's own check is broken.
export type FailureClass = "environment" | "feature" | "test_defect"

export type AppRecipeStateName = "absent" | "unverified" | "verified" | "broken"

export interface AppRecipeFailureRecord {
  stage: string
  class: FailureClass
  reason: string
  // Plain language: "the app needs a Postgres database on port 5432 …".
  summary: string
  // The end of the output of what failed.
  logs: string
  service?: string
  prerequisite?: string
  missingEnv?: string[]
}

// What a choice does. The user never types or reviews a command: each choice
// is something the harness or the repair seat applies.
export type AppRecipeChoiceEffect =
  // Check again as is (the user started the database, added the key).
  | { kind: "retry" }
  // Run recipe repair again, with what the user agreed to.
  | { kind: "repair"; guidance: string }
  // Stop trying: stories waiting on the app end unverified.
  | { kind: "skip" }

export interface AppRecipeChoice {
  id: string
  label: string
  effect: AppRecipeChoiceEffect
}

export interface AppRecipeQuestion {
  id: string
  featureId: string
  // The story waiting on the app, if one is.
  userStoryId: string | null
  // The Comms escalation that carries it to the user.
  messageId: string | null
  question: string
  choices: AppRecipeChoice[]
  askedAt: number
  // Which failure it's about (failureKey), so the next question can say
  // whether the answer fixed it.
  about?: string
}

export interface AppRecipeState {
  workspaceId: string
  branch: string
  state: AppRecipeStateName
  // The commit a `verified` state holds for.
  commit: string | null
  failure: AppRecipeFailureRecord | null
  // Recipe repair attempts since the recipe last verified (never a story's).
  repairAttempts: number
  question: AppRecipeQuestion | null
  updatedAt: number
}

// The state of a workspace with no row for a branch.
export function initialRecipeState(
  workspaceId: string,
  branch: string,
  hasRecipe: boolean
): AppRecipeState {
  return {
    workspaceId,
    branch,
    state: hasRecipe ? "unverified" : "absent",
    commit: null,
    failure: null,
    repairAttempts: 0,
    question: null,
    updatedAt: 0,
  }
}

// The state in a sentence, for the analysis panel and the story view.
export function describeRecipeState(
  state: Pick<AppRecipeState, "state" | "failure">
): string {
  switch (state.state) {
    case "absent":
      return "There's no way to start the app yet: the builder adds one when it makes the app runnable."
    case "unverified":
      return "Not checked yet."
    case "verified":
      return "The app starts and loads."
    case "broken":
      return state.failure
        ? `The app didn't start: ${sentence(state.failure.summary)}`
        : "The app didn't start."
  }
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, "")
  return `${trimmed}.`
}

// Database-ish prerequisites a container can provide.
const CONTAINER_PREREQUISITE =
  /postgres|mysql|mariadb|redis|mongo|database|rabbit|kafka|elastic|memcache/i

// The plain-language question for a failure repair couldn't fix, with
// concrete choices. `prerequisite` is the unavailable prerequisite's label.
// `repairable` false (the user wrote the recipe, or no builder can repair
// it): no choice that needs recipe repair is offered.
export function questionFor(input: {
  failure: AppRecipeFailureRecord
  prerequisite?: { label: string; hint: string } | null
  repairable?: boolean
}): { question: string; choices: AppRecipeChoice[] } {
  const { failure } = input
  const repairable = input.repairable !== false
  const skip: AppRecipeChoice = {
    id: "skip",
    label: "Skip running the app for now",
    effect: { kind: "skip" },
  }
  if (failure.reason === "prerequisite_unavailable" && input.prerequisite) {
    const what = input.prerequisite.label
    const container =
      repairable &&
      CONTAINER_PREREQUISITE.test(`${what} ${input.prerequisite.hint}`)
    return {
      question: `The app needs ${lowerFirst(what)}, and it isn't running.${container ? " Start one with Docker?" : ""}`,
      choices: [
        ...(container
          ? [
              {
                id: "docker",
                label: "Start one with Docker",
                effect: {
                  kind: "repair" as const,
                  guidance: `The user agreed to run ${lowerFirst(what)} with Docker. Add a service to the recipe that runs it in a container on an "auto" port (with {port} as the published port and a project name or container name that includes {port}, so parallel worktrees don't collide), wire the app to it with {port:<key>}, and replace the prerequisite.`,
                },
              },
            ]
          : []),
        {
          id: "self",
          label: "I'll start it myself",
          effect: { kind: "retry" },
        },
        skip,
      ],
    }
  }
  if (failure.reason === "missing_env" && failure.missingEnv?.length) {
    const keys = failure.missingEnv.join(", ")
    const one = failure.missingEnv.length === 1
    return {
      question: `The app needs ${one ? "a value" : "values"} for ${keys}, which ${one ? "isn't" : "aren't"} in the project's .env.local or .env. Add ${one ? "it" : "them"} there, then check again.`,
      choices: [
        {
          id: "retry",
          label: "I added it, check again",
          effect: { kind: "retry" },
        },
        skip,
      ],
    }
  }
  return {
    question: `Mission Control couldn't get the app to start: ${sentence(failure.summary)}`,
    choices: [
      ...(repairable
        ? ([
            {
              id: "repair",
              label: "Try repairing it again",
              effect: {
                kind: "repair",
                guidance:
                  "The user asked for another attempt after the last ones failed. Look for what the earlier attempts missed.",
              },
            },
          ] satisfies AppRecipeChoice[])
        : []),
      {
        id: "retry",
        label: "I fixed it myself, check again",
        effect: { kind: "retry" },
      },
      skip,
    ],
  }
}

// What a failure is about, to tell "fixed, and now this" from "the same".
export function failureKey(failure: AppRecipeFailureRecord): string {
  return [
    failure.reason,
    failure.service ?? "",
    failure.prerequisite ?? "",
    (failure.missingEnv ?? []).join(","),
  ].join("|")
}
