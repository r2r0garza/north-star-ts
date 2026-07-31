import { defaultFilter } from "cmdk"
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import type { SkillSummary } from "@/types"

// Rank skills against the typed query using cmdk's built-in scorer (prefix >
// word-boundary > substring). Matches on the skill NAME only, so description
// words never pull unrelated skills up. An empty query returns all skills in
// their source order. Exported so the composer can navigate the SAME ordered
// list the menu renders (arrow keys) while the textarea keeps focus.
//
// Skills are a small in-memory list, so ranking is client-side. Files are NOT
// ranked here — that list can be huge and is filtered server-side per keystroke.
export function rankSkills(
  skills: SkillSummary[],
  query: string
): SkillSummary[] {
  if (!query) return skills
  return skills
    .map((skill) => ({ skill, score: defaultFilter(skill.name, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.skill)
}

// One row in the mention menu — kind-agnostic. `value` is the stable identity
// (skill name / file path) used for the controlled highlight and selection;
// `primary` is the bold line, `secondary` the muted subtitle.
export type MentionItem = {
  value: string
  primary: string
  secondary?: string
}

// Inline mention picker rendered above the composer, shared by the `/` skill
// menu and the `@` file menu. The parent owns the filtered/ranked list and the
// highlighted item, since the textarea — not this menu — holds focus; we render
// with cmdk filtering off and drive the highlight through its controlled
// `value`. Mouse hover highlights (via onValueChange), click selects.
export function MentionMenu({
  items,
  activeValue,
  onActiveValueChange,
  onSelect,
  emptyLabel,
  className,
}: {
  // Already ranked/filtered by the parent — rendered in order.
  items: MentionItem[]
  // The highlighted value (controlled).
  activeValue: string | null
  onActiveValueChange: (value: string) => void
  onSelect: (item: MentionItem) => void
  emptyLabel: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-md",
        className
      )}
    >
      <Command
        shouldFilter={false}
        value={activeValue ?? ""}
        onValueChange={onActiveValueChange}
        // The textarea keeps focus; suppress cmdk's own root focus-stealing.
        className="bg-transparent"
      >
        <CommandList>
          <CommandEmpty className="py-3 text-muted-foreground">
            {emptyLabel}
          </CommandEmpty>
          {items.map((item) => (
            <CommandItem
              key={item.value}
              value={item.value}
              onSelect={() => onSelect(item)}
              className="flex-col items-start gap-0.5"
            >
              <span className="font-medium">{item.primary}</span>
              {item.secondary && (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {item.secondary}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}
