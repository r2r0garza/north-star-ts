import { useState } from "react"
import {
  BarChart3Icon,
  BotIcon,
  GitBranchIcon,
  MessageSquareIcon,
  MousePointerClickIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface StartupGuideDialogProps {
  agentName: string
  open: boolean
  onDismiss: (dontShowAgain: boolean) => void
}

const GUIDE_ITEMS = [
  {
    key: "chat",
    title: "Chat",
    icon: MessageSquareIcon,
    description:
      "Use Chat for general conversation, planning, and file-assisted questions that do not need a workspace.",
  },
  {
    key: "interactive",
    title: "Interactive",
    icon: MousePointerClickIcon,
    description:
      "Use Interactive when you want the agent to work directly in a project folder with tools, terminals, and reviewable changes.",
  },
  {
    key: "agent",
    title: null,
    icon: BotIcon,
    description:
      "Use this workspace-backed mode for longer autonomous work where the agent can plan, execute, and keep momentum across steps.",
  },
  {
    key: "processes",
    title: "Processes",
    icon: GitBranchIcon,
    description:
      "Processes are reusable multi-step workflows for repeatable work, including live runs and approval points.",
  },
  {
    key: "dashboards",
    title: "Dashboards",
    icon: BarChart3Icon,
    description:
      "Dashboards collect live project signals and task outputs into views you can revisit without digging through transcripts.",
  },
]

export function StartupGuideDialog({
  agentName,
  open,
  onDismiss,
}: StartupGuideDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const handleDismiss = () => {
    onDismiss(dontShowAgain)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleDismiss()}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            Getting around {window.cowork.system().displayName}
          </DialogTitle>
          <DialogDescription>
            Pick the surface that matches the work you want to do.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {GUIDE_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <section
                key={item.key}
                className="rounded-lg border bg-background/70 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <h3 className="font-heading text-sm font-medium">
                    {item.title ?? agentName}
                  </h3>
                </div>
                <p className="text-sm leading-5 text-muted-foreground">
                  {item.description}
                </p>
              </section>
            )
          })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={dontShowAgain}
            onCheckedChange={(checked) => setDontShowAgain(checked === true)}
          />
          <span>Don&apos;t show this again</span>
        </label>
        <DialogFooter>
          <Button onClick={handleDismiss}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
