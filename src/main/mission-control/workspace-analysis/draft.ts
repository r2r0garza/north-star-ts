import type {
  Evidence,
  Finding,
} from "../../../shared/mission-control/workspace-analysis"

// A finding before assembly: evidence without ids, no status yet.
export type FindingDraft = Omit<
  Finding,
  "status" | "evidence" | "alternatives"
> & {
  evidence: Array<Omit<Evidence, "id">>
  alternatives?: Finding["alternatives"]
}
