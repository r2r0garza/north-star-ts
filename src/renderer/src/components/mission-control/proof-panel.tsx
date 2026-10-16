import { useEffect, useState } from "react"
import {
  CheckCircle2,
  CircleSlash,
  FileText,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChangedFilesBar } from "@/components/changed-files-bar"
import type { ChangedFile } from "@/lib/timeline"
import type {
  ProofCriterionStatus,
  ProofVerificationMethod,
  UserStoryProof,
  UserStorySpec,
} from "@/types"

// The structured user story proof (plan 106.3): each acceptance criterion with its
// status and evidence, the verifier, and whether verification was independent
// of the builders. Plan 112.4 adds how each criterion was verified and its
// saved evidence.

const METHOD_META: Record<
  ProofVerificationMethod,
  { label: string; weak?: boolean }
> = {
  app_exercised: { label: "App exercised" },
  command: { label: "Command" },
  builder_tests: { label: "Builder's tests only", weak: true },
  code_read: { label: "Code read", weak: true },
}

const STATUS_META: Record<
  ProofCriterionStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  met: {
    label: "Met",
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-500",
  },
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

function MethodBadge({ method }: { method?: ProofVerificationMethod }) {
  const meta = method ? METHOD_META[method] : null
  return (
    <Badge
      variant="outline"
      className={`h-5 px-1.5 text-[11px] font-normal ${
        !meta
          ? "text-muted-foreground"
          : meta.weak
            ? "border-amber-500/50 text-amber-600 dark:text-amber-500"
            : ""
      }`}
      title="How this criterion was verified"
    >
      {meta?.label ?? "Unspecified"}
    </Badge>
  )
}

// Saved evidence lives in app data (absolute paths); main reads it only from
// the evidence directory. Screenshots show as thumbnails, other files as
// names; clicking opens the file.
export function EvidenceFiles({ paths }: { paths: string[] }) {
  const [files, setFiles] = useState<
    Record<string, { dataUrl: string | null } | null>
  >({})
  // A fresh array each render; refetch only when the paths themselves change.
  const key = paths.join("\n")
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      key.split("\n").map(async (path) => {
        try {
          return [
            path,
            await window.cowork.missionControl.evidence.read(path),
          ] as const
        } catch {
          return [path, null] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setFiles(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [key])
  return (
    <div className="flex flex-wrap gap-2">
      {paths.map((path) => {
        const name = path.split(/[\\/]/).pop() || path
        const file = files[path]
        const open = () => void window.cowork.missionControl.evidence.open(path)
        if (file?.dataUrl)
          return (
            <button
              key={path}
              type="button"
              onClick={open}
              title={path}
              className="overflow-hidden rounded border bg-muted transition hover:ring-2 hover:ring-ring"
            >
              <img
                src={file.dataUrl}
                alt={name}
                className="h-20 w-32 object-cover object-top"
              />
            </button>
          )
        return (
          <button
            key={path}
            type="button"
            onClick={open}
            disabled={!file}
            title={file ? path : `${path} (no longer saved)`}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-muted disabled:opacity-60"
          >
            <FileText className="size-3" />
            {name}
          </button>
        )
      })}
    </div>
  )
}

const isAbsolutePath = (path: string) =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)

export function isUserStoryProof(value: unknown): value is UserStoryProof {
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
  proof: UserStoryProof
  spec: UserStorySpec
  workspacePath: string
}) {
  const accepted = proof.verdict === "accepted"
  // Plan 112.3: the app couldn't be run, so nothing was verified.
  const unverified = proof.verdict === "unverified"
  const verifier =
    proof.verifiedBy.kind === "seat"
      ? proof.verifiedBy.address
      : proof.verifiedBy.kind === "command"
        ? `command phase ${proof.verifiedBy.phaseKey}`
        : "Mission Control"
  const independent =
    proof.verifiedBy.kind === "command" ||
    (proof.verifiedBy.kind === "seat" &&
      !proof.builderAddresses.includes(proof.verifiedBy.address))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            accepted ? "default" : unverified ? "outline" : "destructive"
          }
          className={`capitalize ${unverified ? "border-amber-500/60 text-amber-700 dark:text-amber-400" : ""}`}
        >
          {proof.verdict}
        </Badge>
        {unverified ? (
          <Badge variant="outline" className="gap-1">
            The app couldn't be run to check it
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1">
            <ShieldCheck className="size-3" /> Verified by {verifier}
          </Badge>
        )}
        {proof.acceptedUnverified && (
          <Badge variant="outline">
            Accepted unverified: {proof.acceptedUnverified.note}
          </Badge>
        )}
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
          const evidence = (criterion.artifacts ?? []).filter(isAbsolutePath)
          const workspaceFiles = (criterion.artifacts ?? []).filter(
            (path) => !isAbsolutePath(path)
          )
          return (
            <div key={criterion.id} className="space-y-1.5 p-3">
              <div className="flex items-start gap-2">
                <Icon className={`mt-0.5 size-4 shrink-0 ${meta.className}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{criterion.id}</span>{" "}
                    {spec.acceptance[index] ?? ""}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={meta.className}>{meta.label}</span>
                    {!unverified && <MethodBadge method={criterion.method} />}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {criterion.evidence}
                  </div>
                  {criterion.reason && (
                    <div className="text-xs text-amber-600 dark:text-amber-500">
                      Reason: {criterion.reason}
                    </div>
                  )}
                </div>
              </div>
              {evidence.length ? (
                <div className="pl-6">
                  <EvidenceFiles paths={evidence} />
                </div>
              ) : null}
              {workspaceFiles.length ? (
                <div className="pl-6">
                  <ChangedFilesBar
                    files={artifactFiles(workspaceFiles)}
                    workspace={workspacePath}
                    onOpenHtml={(relPath) =>
                      void window.cowork.openInEditor(workspacePath, relPath)
                    }
                    onReviewAll={(files) => {
                      for (const file of files)
                        void window.cowork.openInEditor(
                          workspacePath,
                          file.path
                        )
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
