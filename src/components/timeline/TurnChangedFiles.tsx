import { useMemo, useState, memo } from "react"
import { ChevronDown, ChevronRight, Folder, FileCode2 } from "lucide-react"
import { diffLineCount } from "../../../shared/diff-utils"
import { expandEditToolCalls } from "../../../shared/session/edit-calls"
import { FOCUS_FILE_EVENT } from "@/components/FileChangesPanel"
import { OpIndicator, SubAgentIndicator } from "@/components/FileChangesPanel/file-change-indicators"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChangeBar, LineCounts } from "@/components/shared/ChangeCounts"
import type { Turn, ToolCall } from "../../../shared/session/types"
import { useCapability } from "@/hooks/useCapability"
import { fileTypeIcon } from "@/lib/fileTypeColors"
import { Button } from "@/components/ui/button"

// ── Data types ────────────────────────────────────────────────────────────────

interface FileChangeInfo {
  filePath: string
  additions: number
  deletions: number
  /** Whether file was edited, written (created/overwritten), or both. */
  hasEdit: boolean
  hasWrite: boolean
  /** Agent ID if this change came from a sub-agent. */
  subAgentId: string | null
}

interface TreeNode {
  name: string
  fullPath: string
  /** Original absolute file path (only set on file nodes). */
  absPath: string
  isFile: boolean
  additions: number
  deletions: number
  hasEdit: boolean
  hasWrite: boolean
  /** Last sub-agent ID that modified this file (null if main agent only). */
  subAgentId: string | null
  children: TreeNode[]
}

// ── Compute per-turn file changes (aggregated by file path) ───────────────────

function computeTurnFileChanges(turn: Turn, cwd: string): FileChangeInfo[] {
  const fileMap = new Map<string, { add: number; del: number; hasEdit: boolean; hasWrite: boolean; subAgentId: string | null }>()

  function processToolCall(tc: ToolCall, agentId?: string) {
    const fp = String(tc.input.file_path ?? tc.input.path ?? "")
    if (!fp) return
    const isEdit = tc.name === "Edit"
    const oldStr = isEdit ? String(tc.input.old_string ?? "") : ""
    const newStr = isEdit
      ? String(tc.input.new_string ?? "")
      : String(tc.input.content ?? "")
    const d = diffLineCount(oldStr, newStr)
    const existing = fileMap.get(fp) ?? { add: 0, del: 0, hasEdit: false, hasWrite: false, subAgentId: null }
    existing.add += d.add
    existing.del += d.del
    if (isEdit) existing.hasEdit = true
    else existing.hasWrite = true
    if (agentId) existing.subAgentId = agentId
    fileMap.set(fp, existing)
  }

  expandEditToolCalls(turn.toolCalls, cwd).forEach((tc) => processToolCall(tc))
  turn.subAgentActivity.forEach((msg) =>
    expandEditToolCalls(msg.toolCalls, cwd).forEach((tc) => processToolCall(tc, msg.agentId)),
  )

  return [...fileMap.entries()].map(([filePath, { add, del, hasEdit, hasWrite, subAgentId }]) => ({
    filePath,
    additions: add,
    deletions: del,
    hasEdit,
    hasWrite,
    subAgentId,
  }))
}

// ── Build collapsible file tree from flat file changes ────────────────────────

interface TrieNode {
  children: Map<string, TrieNode>
  isFile: boolean
  absPath: string
  additions: number
  deletions: number
  hasEdit: boolean
  hasWrite: boolean
  subAgentId: string | null
}

function createTrieNode(): TrieNode {
  return { children: new Map(), isFile: false, absPath: "", additions: 0, deletions: 0, hasEdit: false, hasWrite: false, subAgentId: null }
}

function buildFileTree(changes: FileChangeInfo[], cwd: string): TreeNode[] {
  if (changes.length === 0) return []

  const normalizedCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd
  const root = createTrieNode()

  for (const c of changes) {
    let rel = c.filePath
    if (normalizedCwd && rel.startsWith(normalizedCwd + "/")) {
      rel = rel.slice(normalizedCwd.length + 1)
    } else if (rel.startsWith("/")) {
      rel = rel.slice(1)
    }

    const segs = rel.split("/")
    let node = root
    for (let i = 0; i < segs.length; i++) {
      let child = node.children.get(segs[i])
      if (!child) {
        child = createTrieNode()
        node.children.set(segs[i], child)
      }
      if (i === segs.length - 1) {
        child.isFile = true
        child.absPath = c.filePath
        child.additions += c.additions
        child.deletions += c.deletions
        if (c.hasEdit) child.hasEdit = true
        if (c.hasWrite) child.hasWrite = true
        if (c.subAgentId) child.subAgentId = c.subAgentId
      }
      node = child
    }
  }

  function toTree(node: TrieNode, prefix: string): TreeNode[] {
    // Sort: directories first, then files, alphabetically
    const entries = [...node.children.entries()].sort(([aK, aV], [bK, bV]) => {
      const aFile = aV.isFile && aV.children.size === 0
      const bFile = bV.isFile && bV.children.size === 0
      if (aFile !== bFile) return aFile ? 1 : -1
      return aK.localeCompare(bK)
    })

    return entries.map(([name, child]) => {
      const path = prefix ? `${prefix}/${name}` : name

      // Pure file node
      if (child.isFile && child.children.size === 0) {
        return {
          name,
          fullPath: path,
          absPath: child.absPath,
          isFile: true,
          additions: child.additions,
          deletions: child.deletions,
          hasEdit: child.hasEdit,
          hasWrite: child.hasWrite,
          subAgentId: child.subAgentId,
          children: [],
        }
      }

      // Directory node — collapse single-child directory chains
      let c = child
      let cName = name
      let cPath = path
      while (!c.isFile && c.children.size === 1) {
        const [nk, nv] = [...c.children.entries()][0]
        if (nv.isFile && nv.children.size === 0) break // don't collapse a file into dir name
        cName += "/" + nk
        cPath += "/" + nk
        c = nv
      }

      const children = toTree(c, cPath)

      // Sum additions/deletions and aggregate hasEdit/hasWrite/subAgentId from children
      let totalAdd = 0
      let totalDel = 0
      let hasEdit = c.isFile ? c.hasEdit : false
      let hasWrite = c.isFile ? c.hasWrite : false
      let subAgentId: string | null = c.isFile ? c.subAgentId : null
      for (const ch of children) {
        totalAdd += ch.additions
        totalDel += ch.deletions
        if (ch.hasEdit) hasEdit = true
        if (ch.hasWrite) hasWrite = true
        if (ch.subAgentId) subAgentId = ch.subAgentId
      }
      // Include own file data if this node is also a file (edge case)
      if (c.isFile) {
        totalAdd += c.additions
        totalDel += c.deletions
      }

      return {
        name: cName,
        fullPath: cPath,
        absPath: c.absPath,
        isFile: false,
        additions: totalAdd,
        deletions: totalDel,
        hasEdit,
        hasWrite,
        subAgentId,
        children,
      }
    })
  }

  return toTree(root, "")
}

// ── Main component ────────────────────────────────────────────────────────────

interface TurnChangedFilesProps {
  turn: Turn
  turnIndex: number
  cwd: string
}

export const TurnChangedFiles = memo(function TurnChangedFiles({ turn, turnIndex, cwd }: TurnChangedFilesProps) {
  const canAccessHostFiles = useCapability("hostFiles")
  const fileChanges = useMemo(() => computeTurnFileChanges(turn, cwd), [turn, cwd])
  const tree = useMemo(() => buildFileTree(fileChanges, cwd), [fileChanges, cwd])
  const [expanded, setExpanded] = useState(false)

  const totals = useMemo(() => {
    let add = 0
    let del = 0
    for (const fc of fileChanges) {
      add += fc.additions
      del += fc.deletions
    }
    return { add, del }
  }, [fileChanges])

  if (fileChanges.length === 0) return null

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        className="group/files flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          data-icon="inline-start"
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
        <FileCode2 className="size-3.5 shrink-0" data-icon="inline-start" />
        <span className="font-medium tabular-nums">
          {fileChanges.length} file{fileChanges.length !== 1 ? "s" : ""}
        </span>
        <LineCounts add={totals.add} del={totals.del} className="opacity-80" />
        <ChangeBar add={totals.add} del={totals.del} />
        <span
          aria-hidden
          className="pointer-events-none ml-1 h-px flex-1 bg-border/40 transition-colors group-hover/files:bg-border/70"
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="ml-1 border-l border-border/40 pl-3">
        <div className="py-0.5">
          {tree.map((node) => (
            <TreeRow
              key={node.fullPath}
              node={node}
              depth={0}
              turnIndex={turnIndex}
              canFocusFiles={canAccessHostFiles}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

// ── Tree row (recursive) ─────────────────────────────────────────────────────

const TreeRow = memo(function TreeRow({
  node,
  depth,
  turnIndex,
  canFocusFiles,
}: {
  node: TreeNode
  depth: number
  turnIndex: number
  canFocusFiles: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  const paddingLeft = depth * 16 + 8

  if (node.isFile) {
    const FileIcon = fileTypeIcon(node.name)
    const handleFileClick = () => {
      if (canFocusFiles && node.absPath) {
        window.dispatchEvent(new CustomEvent(FOCUS_FILE_EVENT, { detail: { filePath: node.absPath, turnIndex } }))
      }
    }

    return (
      <div className="flex h-7 w-full items-center gap-1.5 font-mono text-xs" style={{ paddingLeft }}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!canFocusFiles}
          className={cn(
            "h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-0 font-mono text-xs font-normal disabled:opacity-100",
            canFocusFiles && "cursor-pointer",
          )}
          onClick={handleFileClick}
          title={canFocusFiles ? "Click to focus in sidebar" : undefined}
        >
          <FileIcon className="size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
          <OpIndicator hasEdit={node.hasEdit} hasWrite={node.hasWrite} />
          <span className="truncate text-foreground/75">{node.name}</span>
        </Button>
        {node.subAgentId && <SubAgentIndicator agentId={node.subAgentId} />}
        <LineCounts add={node.additions} del={node.deletions} />
        <ChangeBar add={node.additions} del={node.deletions} />
      </div>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-7 w-full justify-start gap-1 rounded-sm font-mono text-xs font-normal"
        style={{ paddingLeft }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
        )}
        <Folder className="size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <span className="truncate text-foreground/70">{node.name}</span>
        <div className="flex-1 min-w-2" />
        {!expanded && <LineCounts add={node.additions} del={node.deletions} dimmed />}
      </Button>
      {expanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            turnIndex={turnIndex}
            canFocusFiles={canFocusFiles}
          />
        ))}
    </>
  )
})
