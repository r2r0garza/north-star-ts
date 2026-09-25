import { CheckCircle2, CircleSlash, ShieldCheck, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChangedFilesBar } from "@/components/changed-files-bar"
import type { ChangedFile } from "@/lib/timeline"
import type { ProofCriterionStatus, SliceProof, SliceSpec } from "@/types"

// The structured slice proof (plan 106.3): each acceptance criterion with its
// status and evidence, the verifier, and whether verification was independent
// of the builders.

const STATUS_META: Record<
  ProofCriterionStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  met: { label: "Met", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-500" },
  not_met: { label: "Not met", icon: XCircle, className: "text-destructive" },
  not_verifiable: {
    label: "Not verifiable",
    icon: CircleSlash,
    className: "text-amber-600 dark:text-amber-500",
  },
}

function artifactFiles(paths: string[]): ChangedFile[] {
  return paths.map((path) => ({
    path,
    baseName: path.split("/").pop() || path,
    kind: "write",
    fileType: /\.html?$/i.test(path) ? "html" : "code",
  }))
}

export function isSliceProof(value: unknown): value is SliceProof {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { criteria?: unknown }).criteria)
  )
}

export function ProofPanel({
  proof,
  spec,
  workspacePath,
}: {
  proof: SliceProof
  spec: SliceSpec
  workspacePath: string
}) {
  const accepted = proof.verdict === "accepted"
  const verifier =
    proof.verifiedBy.kind === "seat"
      ? proof.verifiedBy.address
      : `command phase ${proof.verifiedBy.phaseKey}`
  const independent =
    proof.verifiedBy.kind === "command" ||
    !proof.builderAddresses.includes(proof.verifiedBy.address)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={accepted ? "default" : "destructive"}
          className="capitalize"
        >
          {proof.verdict}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="size-3" /> Verified by {verifier}
        </Badge>
        {independent && (
          <Badge variant="outline">
            {proof.verifiedBy.kind === "command"
              ? "Deterministic evidence"
              : "Independent of builders"}
          </Badge>
        )}
        {proof.builderAddresses.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Built by {proof.builderAddresses.join(", ")}
          </span>
        )}
      </div>
      <div className="divide-y rounded-md border">
        {proof.criteria.map((criterion) => {
          const meta = STATUS_META[criterion.status]
          const Icon = meta.icon
          const index = Number(criterion.id.replace(/^AC-/, "")) - 1
          return (
            <div key={criterion.id} className="space-y-1.5 p-3">
              <div className="flex items-start gap-2">
                <Icon className={`mt-0.5 size-4 shrink-0 ${meta.className}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{criterion.id}</span>{" "}
                    {spec.acceptance[index] ?? ""}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className={meta.className}>{meta.label}</span> ·{" "}
                    {criterion.evidence}
                  </div>
                  {criterion.reason && (
                    <div className="text-xs text-amber-600 dark:text-amber-500">
                      Reason: {criterion.reason}
                    </div>
                  )}
                </div>
              </div>
              {criterion.artifacts?.length ? (
                <div className="pl-6">
                  <ChangedFilesBar
                    files={artifactFiles(criterion.artifacts)}
                    workspace={workspacePath}
                    onOpenHtml={(relPath) =>
                      void window.cowork.openInEditor(workspacePath, relPath)
                    }
                    onReviewAll={(files) => {
                      for (const file of files)
                        void window.cowork.openInEditor(workspacePath, file.path)
                    }}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {proof.warnings?.length ? (
        <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-500">
          {proof.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {proof.acceptedAt && (
        <p className="text-xs text-muted-foreground">
          Accepted {new Date(proof.acceptedAt).toLocaleString()} · frozen
        </p>
      )}
    </div>
  )
}
