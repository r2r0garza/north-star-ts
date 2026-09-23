import { Fragment, useEffect, useRef, useState } from "react"
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { ConversationSearchResult, Mode } from "@/types"

const SNIPPET_START = "\u0001"
const SNIPPET_END = "\u0002"
const MODE_LABEL: Record<Mode, string> = {
  chat: "Chat",
  interactive: "Interactive",
  north_star: "North Star",
}

type SearchState =
  | { status: "idle"; results: ConversationSearchResult[] }
  | { status: "loading"; results: ConversationSearchResult[] }
  | { status: "ready"; results: ConversationSearchResult[] }
  | { status: "error"; results: ConversationSearchResult[] }

export function ConversationSearchDialog({
  open,
  onOpenChange,
  onSelectConversation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectConversation: (id: string, mode: Mode) => void
}) {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<SearchState>({
    status: "idle",
    results: [],
  })
  const requestId = useRef(0)

  useEffect(() => {
    if (!open) {
      requestId.current += 1
      setQuery("")
      setState({ status: "idle", results: [] })
      return
    }

    const terms = query.match(/[\p{L}\p{N}]+/gu)
    if (!terms?.length) {
      requestId.current += 1
      setState({ status: "idle", results: [] })
      return
    }

    const currentRequest = ++requestId.current
    const timer = window.setTimeout(() => {
      setState({ status: "loading", results: [] })
      void window.cowork.db.conversations
        .search(query, { limit: 30 })
        .then((results) => {
          if (requestId.current === currentRequest) {
            setState({ status: "ready", results })
          }
        })
        .catch(() => {
          if (requestId.current === currentRequest) {
            setState({ status: "error", results: [] })
          }
        })
    }, 200)

    return () => window.clearTimeout(timer)
  }, [open, query])

  function select(result: ConversationSearchResult) {
    onSelectConversation(result.conversationId, result.mode)
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search conversations"
      description="Search conversation titles and transcript content"
      className="max-w-xl"
    >
      <Command shouldFilter={false} loop>
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search conversations…"
          aria-label="Search conversations"
        />
        <CommandList className="max-h-96 p-1">
          {state.status === "idle" && (
            <SearchMessage>Type a title or transcript phrase</SearchMessage>
          )}
          {state.status === "loading" && (
            <SearchMessage>Searching conversations…</SearchMessage>
          )}
          {state.status === "error" && (
            <SearchMessage>Search failed. Try again.</SearchMessage>
          )}
          {state.status === "ready" && state.results.length === 0 && (
            <SearchMessage>No conversations found</SearchMessage>
          )}
          {state.status !== "idle" &&
            state.results.map((result) => (
              <CommandItem
                key={result.conversationId}
                value={result.conversationId}
                onSelect={() => select(result)}
                className="items-start py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {result.title?.trim() || "Untitled conversation"}
                  </div>
                  {result.snippet && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      <HighlightedSnippet value={result.snippet} />
                    </p>
                  )}
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {[
                      MODE_LABEL[result.mode],
                      result.projectName,
                      formatDate(result.updatedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </CommandItem>
            ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

function SearchMessage({ children }: { children: string }) {
  return (
    <div
      className="py-8 text-center text-sm text-muted-foreground"
      role="status"
    >
      {children}
    </div>
  )
}

export function HighlightedSnippet({ value }: { value: string }) {
  const parts = value.split(
    new RegExp(`(${SNIPPET_START}|${SNIPPET_END})`, "g")
  )
  let highlighted = false
  return parts.map((part, index) => {
    if (part === SNIPPET_START) {
      highlighted = true
      return null
    }
    if (part === SNIPPET_END) {
      highlighted = false
      return null
    }
    return highlighted ? (
      <mark
        key={index}
        className="bg-yellow-200/70 text-inherit dark:bg-yellow-700/50"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    )
  })
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(timestamp))
}
