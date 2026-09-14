import type { ToolCall } from "../../../shared/session/types"
import { formatToolFileDiff } from "../../../shared/session/toolResults"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"

export function ToolFileDiffs({ fileDiffs, additionalFileDiffs }: Pick<ToolCall, "fileDiffs" | "additionalFileDiffs">) {
  return <>
    {fileDiffs?.map((file) => (
      <section key={file.filePath} aria-label={`File diff: ${file.filePath}`} className="mt-3 min-w-0">
        <div className="break-all font-mono text-xs text-muted-foreground">{file.filePath}</div>
        <MarkdownCodeBlock className="language-diff">{formatToolFileDiff(file)}</MarkdownCodeBlock>
      </section>
    ))}
    {Boolean(additionalFileDiffs) && <p className="mt-2 text-xs text-muted-foreground">{additionalFileDiffs} additional file diffs omitted by the agent.</p>}
  </>
}
