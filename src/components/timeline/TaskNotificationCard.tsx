import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { markdownComponents, markdownPlugins } from "./markdown-components"
import { parseTaskNotifications, type TaskNotification } from "@/lib/userMessageContent"
import { cn } from "@/lib/utils"
import { CompletedIcon, FailedIcon, RunningIcon } from "@/components/ui/StatusIcons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

const ERROR_STYLE = {
  Icon: FailedIcon,
  color: "text-destructive",
  bg: "border-destructive/20 bg-destructive/5",
  badgeVariant: "destructive",
} as const

const STATUS_STYLES = {
  completed: { Icon: CompletedIcon, color: "text-success", bg: "border-success/20 bg-success/5", badgeVariant: "secondary", label: "Completed" },
  failed: { ...ERROR_STYLE, label: "Failed" },
  error: { ...ERROR_STYLE, label: "Error" },
  running: { Icon: RunningIcon, color: "text-warning", bg: "border-warning/20 bg-warning/5", badgeVariant: "outline", label: "Running" },
} as const

export function TaskNotificationCard({ notification }: { notification: TaskNotification }) {
  const [expanded, setExpanded] = useState(false)
  const statusStyle = STATUS_STYLES[notification.status as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.running
  const { Icon: StatusIcon } = statusStyle
  const hasDetail = notification.result.length > 0 || notification.outputFile.length > 0
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={cn("my-1 rounded-lg border p-3", statusStyle.bg)}
    >
      <div className="flex items-start gap-2">
        <StatusIcon className={cn("mt-0.5 size-4 shrink-0", statusStyle.color)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{notification.summary}</span>
            <Badge variant={statusStyle.badgeVariant} className={statusStyle.color}>
              {statusStyle.label}
            </Badge>
          </div>
          {hasDetail && (
            <>
              <CollapsibleTrigger
                render={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="mt-1.5 -ml-2 text-muted-foreground"
                  />
                )}
              >
                <Chevron data-icon="inline-start" />
                {expanded ? "Hide detail" : "Show detail"}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 border-t border-border/30 pt-2 text-sm text-foreground/90">
                  {notification.result && (
                    <ReactMarkdown components={markdownComponents} remarkPlugins={markdownPlugins}>
                      {notification.result}
                    </ReactMarkdown>
                  )}
                  {notification.outputFile && (
                    <div className="mt-2">
                      <div className="text-xs font-medium text-muted-foreground">Output file</div>
                      <div className="mt-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                        {notification.outputFile}
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </>
          )}
        </div>
      </div>
    </Collapsible>
  )
}

/**
 * The `task_notification` content block: one or more background tasks reporting
 * back mid-turn. The block carries the record verbatim, so the grammar is
 * parsed here rather than in the session core.
 */
export function TaskNotificationBlock({ content }: { content: string }) {
  const { notifications } = parseTaskNotifications(content)
  if (notifications.length === 0) return null
  return (
    <div className="flex flex-col">
      {notifications.map((n, i) => (
        <TaskNotificationCard key={n.taskId || `notification-${i}`} notification={n} />
      ))}
    </div>
  )
}
