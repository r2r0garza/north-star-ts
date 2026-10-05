import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type {
  FeatureProjectFilter,
  FeatureProjectGroups,
} from "./feature-project-filter"

function RailRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
      )}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        ({count})
      </span>
    </button>
  )
}

// Left rail of the Features list (plan 106.10), styled like Dashboards'.
export function FeaturesProjectRail({
  groups,
  selection,
  onSelect,
}: {
  groups: FeatureProjectGroups
  selection: FeatureProjectFilter
  onSelect: (selection: FeatureProjectFilter) => void
}) {
  return (
    <div className="flex w-60 shrink-0 flex-col border-r">
      <div className="flex h-12 shrink-0 items-center px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          <RailRow
            label="All features"
            count={groups.total}
            selected={selection.kind === "all"}
            onClick={() => onSelect({ kind: "all" })}
          />
          {groups.byProject.length > 0 && <div className="my-1 border-t" />}
          {groups.byProject.map(({ project, count }) => (
            <RailRow
              key={project.id}
              label={project.name}
              count={count}
              selected={
                selection.kind === "project" && selection.id === project.id
              }
              onClick={() => onSelect({ kind: "project", id: project.id })}
            />
          ))}
          {groups.unassigned > 0 && (
            <>
              <div className="my-1 border-t" />
              <RailRow
                label="No project"
                count={groups.unassigned}
                selected={selection.kind === "none"}
                onClick={() => onSelect({ kind: "none" })}
              />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
