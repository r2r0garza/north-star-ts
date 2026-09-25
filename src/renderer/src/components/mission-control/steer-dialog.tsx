import { useEffect, useMemo, useState } from "react"
import { Send } from "lucide-react"
import { toast } from "sonner"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { SeatOverview } from "@/types"

// Steer (plan 106.4 decision 6): the user's one explicit write into Comms. It is
// sent from user@rig, in its own thread, and targets pod leads by default so
// the chain of command stays legible; "Message seat directly" opts into any
// seated seat.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export function SteerDialog({
  open,
  initiativeId,
  seats,
  initialTarget,
  onOpenChange,
  onSent,
}: {
  open: boolean
  initiativeId: string
  seats: SeatOverview[]
  initialTarget?: string | null
  onOpenChange: (open: boolean) => void
  onSent: () => void
}) {
  const seated = useMemo(() => seats.filter((seat) => !seat.vacant), [seats])
  const leads = useMemo(() => seated.filter((seat) => seat.isLead), [seated])
  const [direct, setDirect] = useState(false)
  const [to, setTo] = useState("")
  const [body, setBody] = useState("")
  const [sending, setSending] = useState(false)
  const choices = direct || leads.length === 0 ? seated : leads

  useEffect(() => {
    if (!open) return
    const wanted = initialTarget
      ? seated.find((seat) => seat.address === initialTarget)
      : null
    setDirect(!!wanted && !wanted.isLead)
    setTo(wanted?.address ?? leads[0]?.address ?? seated[0]?.address ?? "")
    setBody("")
  }, [open, initialTarget, leads, seated])

  useEffect(() => {
    if (to && !choices.some((seat) => seat.address === to))
      setTo(choices[0]?.address ?? "")
  }, [choices, to])

  const send = async () => {
    setSending(true)
    try {
      await window.cowork.missionControl.comms.steer({
        initiativeId,
        to,
        body,
        direct: direct || leads.length === 0,
      })
      toast.success(`Sent to ${to}`)
      onOpenChange(false)
      onSent()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Steer</DialogTitle>
          <DialogDescription>
            Your message is delivered as coming from you, never from another
            agent. It carries information and direction, not approvals.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>To</Label>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a seat" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((seat) => (
                  <SelectItem key={seat.address} value={seat.address}>
                    {seat.address}
                    {seat.isLead ? " · lead" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {leads.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={direct}
                onCheckedChange={(value) => setDirect(value === true)}
              />
              Message seat directly (bypass the pod lead)
            </label>
          )}
          <div className="space-y-1">
            <Label className="font-mono text-xs text-muted-foreground">
              You (user@rig) → {to || "…"}
            </Label>
            <Textarea
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What should they know or change?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!to || !body.trim() || sending}
            onClick={() => void send()}
          >
            <Send className="size-4" /> Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
