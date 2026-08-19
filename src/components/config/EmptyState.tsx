import { FileText } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function EmptyState() {
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>Select a configuration file</EmptyTitle>
        <EmptyDescription>
          Browse instructions, agents, skills, commands, and settings from the sidebar.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
