import { memo, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { Check, Copy } from "lucide-react"
import { Mermaid } from "./mermaid"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Extract the plain-text content of a node's children — used to pull the raw
// source out of a fenced code block (for mermaid and copy-friendly blocks).
function nodeText(children: React.ReactNode): string {
  if (typeof children === "string") return children
  if (Array.isArray(children)) return children.map(nodeText).join("")
  if (
    children &&
    typeof children === "object" &&
    "props" in (children as any)
  ) {
    return nodeText((children as any).props?.children)
  }
  return ""
}

function CodeBlock({ children, ...props }: React.ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  async function copy() {
    try {
      await navigator.clipboard.writeText(nodeText(children))
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      data-slot="markdown-code-block"
      className="relative my-3 max-w-full rounded-lg bg-[#0d1117] text-zinc-100"
    >
      <div className="pointer-events-none sticky top-2 z-10 -mb-10 h-10 pt-2 pr-2 text-right">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="pointer-events-auto bg-[#161b22]/90 text-zinc-300 shadow-sm ring-1 ring-white/15 backdrop-blur-sm hover:bg-[#21262d] hover:text-white"
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre
        data-slot="markdown-code-scroll"
        className="max-w-full overflow-x-auto px-3 pt-10 pb-3 text-xs leading-relaxed"
        {...props}
      >
        {children}
      </pre>
    </div>
  )
}

function createComponents({
  highlightCode,
  renderMermaid,
}: {
  highlightCode: boolean
  renderMermaid: boolean
}): Components {
  return {
    // `code` covers both inline code and fenced blocks. Settled Mermaid fences
    // are handed to the diagram renderer; streaming fences remain plain code.
    code({ className, children, ...props }) {
      // Block code carries a `language-*` class, or (for language-less fences)
      // spans multiple lines. Everything else is inline.
      const hasLang = /language-(\w+)/.test(className ?? "")
      const isBlock = hasLang || nodeText(children).includes("\n")
      if (!isBlock) {
        return (
          <code
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-words"
            {...props}
          >
            {children}
          </code>
        )
      }
      if (renderMermaid && /language-mermaid/.test(className ?? "")) {
        return <Mermaid chart={nodeText(children)} />
      }
      return (
        <code
          className={cn(
            highlightCode && "hljs",
            "font-mono text-[0.85em]",
            className
          )}
          {...props}
        >
          {children}
        </code>
      )
    },
    // Settled Mermaid diagrams render their own container. Streaming Mermaid
    // source uses the same copyable code-block chrome as every other fence.
    pre({ children, ...props }) {
      const child: any = Array.isArray(children) ? children[0] : children
      const lang: string = child?.props?.className ?? ""
      if (renderMermaid && /language-mermaid/.test(lang)) {
        return <>{children}</>
      }
      return <CodeBlock {...props}>{children}</CodeBlock>
    },
    a({ children, ...props }) {
      // External links open in the OS browser via the main process handler.
      return (
        <a
          className="text-primary underline underline-offset-2"
          target="_blank"
          rel="noreferrer"
          {...props}
        >
          {children}
        </a>
      )
    },
    table({ children, ...props }) {
      return (
        <div className="my-3 max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-sm" {...props}>
            {children}
          </table>
        </div>
      )
    },
  }
}

const remarkPlugins = [remarkGfm]
const settledRehypePlugins = [rehypeHighlight]
const settledComponents = createComponents({
  highlightCode: true,
  renderMermaid: true,
})
const streamingComponents = createComponents({
  highlightCode: false,
  renderMermaid: false,
})

type MarkdownProps = {
  content: string
  mode?: "settled" | "streaming"
}

// Renders assistant Markdown with GFM in both modes. Settled content adds syntax
// highlighting and Mermaid diagrams; streaming content defers both enrichments.
export const Markdown = memo(function Markdown({
  content,
  mode = "settled",
}: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none dark:prose-invert",
        "max-w-full min-w-0 [overflow-wrap:anywhere]",
        "prose-pre:bg-transparent prose-pre:p-0", // <pre> styling handled above
        "prose-headings:font-semibold prose-p:leading-relaxed"
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={mode === "settled" ? settledRehypePlugins : undefined}
        components={
          mode === "settled" ? settledComponents : streamingComponents
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
