import { useId } from "react"
import type { PluginScope } from "../../shared/contracts/plugins"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"

export function PluginScopeEditor({ value, onChange, projects, disabled = false }: {
  value: PluginScope; onChange: (scope: PluginScope) => void; projects: PluginProjectSummary[]; disabled?: boolean
}) {
  const id = useId()
  const selected = new Set(value.type === "projects" ? value.projectIds : [])
  return <FieldSet disabled={disabled}>
    <FieldLegend>Available in</FieldLegend>
    <Field orientation="horizontal">
      <Checkbox id={`${id}-all`} checked={value.type === "all"} disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? { type: "all" } : { type: "projects", projectIds: [] })} />
      <FieldLabel htmlFor={`${id}-all`}>All projects on this host, including new projects</FieldLabel>
    </Field>
    {value.type === "projects" && <div className="flex max-h-40 flex-col gap-3 overflow-y-auto">
      {projects.map((project) => <Field key={project.id} orientation="horizontal">
        <Checkbox id={`${id}-${project.id}`} checked={selected.has(project.id)} disabled={disabled}
          onCheckedChange={(checked) => onChange({ type: "projects", projectIds: checked ? [...value.projectIds, project.id] : value.projectIds.filter((candidate) => candidate !== project.id) })} />
        <FieldLabel htmlFor={`${id}-${project.id}`}>{project.name}</FieldLabel>
      </Field>)}
    </div>}
    <FieldDescription>{value.type === "projects" && value.projectIds.length === 0
      ? "Installed but hidden until you choose a project."
      : "This setting is shared by every client connected to this host."}</FieldDescription>
  </FieldSet>
}
