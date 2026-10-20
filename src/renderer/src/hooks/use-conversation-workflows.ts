import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { WorkflowConversationContext } from "../App"
import type { WorkflowDefinition } from "../../../shared/workflows"
import type { WorkflowRun } from "../../../shared/workflow-runs"
import {
  formatWorkflowResult,
  workflowFinalOutput,
} from "../../../shared/workflow-result"

export function workflowUnavailableReason(
  workflow: WorkflowDefinition
): string | null {
  if (!workflow.defaultObjective.trim())
    return "A predefined objective is required."
  if (
    !workflow.steps.length ||
    workflow.steps.some((step) => !step.instructions.trim())
  )
    return "Nonempty workflow steps are required."
  return null
}

type TrackedRun = { run: WorkflowRun; stale: boolean; missing: boolean }
type PendingLaunch = { key: string; workflowId: string }
export function useConversationWorkflows({
  context,
  visible,
  append,
}: {
  context: WorkflowConversationContext | null
  visible: boolean
  append: (text: string, context: WorkflowConversationContext) => boolean
}) {
  const current = useRef(context)
  current.current = context
  const mounted = useRef(true)
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{
    context: WorkflowConversationContext | null
    message: string
  } | null>(null)
  const [tracked, setTracked] = useState<Record<string, TrackedRun[]>>({})
  const [pending, setPending] = useState<Set<PendingLaunch>>(new Set())
  const pendingRef = useRef(new Set<PendingLaunch>())
  useEffect(() => {
    setActionError(null)
  }, [context?.key, context?.generation])
  const aliases = useRef<Record<string, string>>({})
  const revision = useRef(0)
  const refreshId = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    const id = ++refreshId.current
    setLoading(true)
    try {
      const rows = await window.cowork.db.workflows.list()
      if (mounted.current && id === refreshId.current) {
        setDefinitions(
          rows.filter((workflow) => workflow.viewInConversationSidebar === true)
        )
        setLoadError(null)
      }
    } catch {
      if (mounted.current && id === refreshId.current)
        setLoadError("Could not load workflows. Refresh to retry.")
    } finally {
      if (mounted.current && id === refreshId.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])
  const hasRuns = Object.values(tracked).some((rows) => rows.length)
  useEffect(() => {
    if (!visible)
      setTracked((all) =>
        Object.fromEntries(
          Object.entries(all).map(([key, entries]) => [
            key,
            entries.map((entry) => ({ ...entry, stale: true })),
          ])
        )
      )
  }, [visible])
  useEffect(() => {
    if (!visible || !hasRuns) return
    let cancelled = false
    let busy = false
    async function poll() {
      if (busy) return
      busy = true
      const started = revision.current
      try {
        const rows = await window.cowork.workflowRuns.list()
        if (!cancelled && started === revision.current)
          setTracked((all) =>
            Object.fromEntries(
              Object.entries(all).map(([key, entries]) => [
                key,
                entries.map((entry) => {
                  const run = rows.find((row) => row.id === entry.run.id)
                  return run
                    ? { run, stale: false, missing: false }
                    : { ...entry, stale: true, missing: true }
                }),
              ])
            )
          )
      } catch {
        if (!cancelled && started === revision.current)
          setTracked((all) =>
            Object.fromEntries(
              Object.entries(all).map(([key, entries]) => [
                key,
                entries.map((entry) => ({ ...entry, stale: true })),
              ])
            )
          )
      } finally {
        busy = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [visible, hasRuns])
  function stillCurrent(origin: WorkflowConversationContext) {
    return (
      current.current?.generation === origin.generation &&
      current.current?.key === origin.key
    )
  }
  async function start(workflowId: string) {
    const origin = current.current
    if (!origin?.ready || !origin.workspace.trim()) {
      setActionError({
        context: origin,
        message: "A valid conversation workspace is required.",
      })
      return
    }
    if (
      [...pendingRef.current].some(
        (entry) => entry.key === origin.key && entry.workflowId === workflowId
      )
    )
      return
    setActionError(null)
    const token = { key: origin.key, workflowId }
    pendingRef.current.add(token)
    setPending(new Set(pendingRef.current))
    try {
      const definitions = await window.cowork.db.workflows.list()
      const workflow = definitions.find(
        (row) => row.id === workflowId && row.viewInConversationSidebar === true
      )
      if (!workflow)
        throw new Error(
          "This workflow is no longer available in the sidebar. Refresh to update."
        )
      const reason = workflowUnavailableReason(workflow)
      if (reason) throw new Error(reason)
      const workspaces = await window.cowork.db.workspaces.list()
      const workspace =
        workspaces.find((row) => row.path === origin.workspace) ??
        (await window.cowork.db.workspaces.upsert(origin.workspace))
      if (!stillCurrent(origin))
        throw new Error("Conversation context changed. Please run again.")
      const run = await window.cowork.workflowRuns.start({
        workflowId,
        objective: workflow.defaultObjective.trim(),
        workspaceId: workspace.id,
        projectId: origin.projectId,
      })
      revision.current++
      if (!mounted.current) return
      const destination = aliases.current[origin.key] ?? origin.key
      setTracked((all) => ({
        ...all,
        [destination]: [
          { run, stale: false, missing: false },
          ...(all[destination] ?? []),
        ],
      }))
      toast.success(`Started ${run.workflow.name}`)
    } catch (cause) {
      if (mounted.current && stillCurrent(origin))
        setActionError({
          context: origin,
          message:
            cause instanceof Error ? cause.message : "Could not start workflow",
        })
    } finally {
      pendingRef.current.delete(token)
      if (mounted.current) setPending(new Set(pendingRef.current))
    }
  }
  async function addToChat(id: string) {
    const origin = current.current
    if (!origin) return
    setActionError(null)
    try {
      const rows = await window.cowork.workflowRuns.list()
      const run = rows.find((row) => row.id === id)
      if (!run || !workflowFinalOutput(run))
        throw new Error("Completed workflow output is unavailable.")
      if (!stillCurrent(origin) || !append(formatWorkflowResult(run), origin))
        throw new Error(
          "Conversation changed. Add the result again in the intended conversation."
        )
      toast.success(
        "Workflow result added to your draft. Review before sending."
      )
    } catch (cause) {
      if (mounted.current && stillCurrent(origin))
        setActionError({
          context: origin,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not retrieve workflow output",
        })
    }
  }
  function adopt(from: string, to: string) {
    aliases.current[from] = to
    for (const entry of pendingRef.current) {
      if (entry.key === from) entry.key = to
    }
    setPending(new Set(pendingRef.current))
    revision.current++
    setTracked((all) => {
      const next = { ...all, [to]: [...(all[to] ?? []), ...(all[from] ?? [])] }
      delete next[from]
      return next
    })
  }
  return {
    definitions,
    loading,
    error:
      (actionError &&
      actionError.context?.key === context?.key &&
      actionError.context?.generation === context?.generation
        ? actionError.message
        : null) ?? loadError,
    refresh,
    start,
    addToChat,
    adopt,
    runs: context ? (tracked[context.key] ?? []) : [],
    pending: (id: string) =>
      [...pending].some(
        (entry) => entry.key === context?.key && entry.workflowId === id
      ),
    workspaceReady: !!context?.ready && !!context.workspace.trim(),
  }
}

export type ConversationWorkflows = ReturnType<typeof useConversationWorkflows>
