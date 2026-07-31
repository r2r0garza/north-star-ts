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

// Inline slash-command picker rendered above the composer. The parent owns the
// filtered/ranked list (via rankSkills) and the highlighted item, since the
// textarea — not this menu — holds focus; we render with filtering off and drive
// the highlight through cmdk's controlled `value`. Mouse hover highlights (via
// onValueChange), click selects.
export function SkillMenu({
  items,
  activeValue,
  onActiveValueChange,
  onSelect,
  className,
}: {
  // Already ranked/filtered by the parent — rendered in order.
  items: SkillSummary[]
  // The highlighted skill name (controlled).
  activeValue: string | null
  onActiveValueChange: (value: string) => void
  onSelect: (skill: SkillSummary) => void
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
            No matching skills
          </CommandEmpty>
          {items.map((skill) => (
            <CommandItem
              key={skill.name}
              value={skill.name}
              onSelect={() => onSelect(skill)}
              className="flex-col items-start gap-0.5"
            >
              <span className="font-medium">/{skill.name}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {skill.description}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}
