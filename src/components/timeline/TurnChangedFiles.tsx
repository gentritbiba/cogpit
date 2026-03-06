import { useMemo, useState, useEffect, memo } from "react"
import { ChevronDown, ChevronRight, Folder, ChevronsDownUp, ChevronsUpDown, FileCode2 } from "lucide-react"
import { diffLineCount } from "@/lib/diffUtils"
import { cn } from "@/lib/utils"
import type { Turn, ToolCall } from "@/lib/types"

// ── Data types ────────────────────────────────────────────────────────────────

interface FileChangeInfo {
  filePath: string
  additions: number
  deletions: number
}

interface TreeNode {
  name: string
  fullPath: string
  isFile: boolean
  additions: number
  deletions: number
  children: TreeNode[]
}

// ── Compute per-turn file changes (aggregated by file path) ───────────────────

function computeTurnFileChanges(turn: Turn): FileChangeInfo[] {
  const fileMap = new Map<string, { add: number; del: number }>()

  const process = (tc: ToolCall) => {
    if (tc.name !== "Edit" && tc.name !== "Write") return
    const fp = String(tc.input.file_path ?? tc.input.path ?? "")
    if (!fp) return
    const isEdit = tc.name === "Edit"
    const oldStr = isEdit ? String(tc.input.old_string ?? "") : ""
    const newStr = isEdit
      ? String(tc.input.new_string ?? "")
      : String(tc.input.content ?? "")
    const d = diffLineCount(oldStr, newStr)
    const existing = fileMap.get(fp) ?? { add: 0, del: 0 }
    existing.add += d.add
    existing.del += d.del
    fileMap.set(fp, existing)
  }

  turn.toolCalls.forEach(process)
  turn.subAgentActivity.forEach((msg) => msg.toolCalls.forEach(process))

  return [...fileMap.entries()].map(([filePath, { add, del }]) => ({
    filePath,
    additions: add,
    deletions: del,
  }))
}

// ── Build collapsible file tree from flat file changes ────────────────────────

interface TrieNode {
  children: Map<string, TrieNode>
  isFile: boolean
  additions: number
  deletions: number
}

function buildFileTree(changes: FileChangeInfo[], cwd: string): TreeNode[] {
  if (changes.length === 0) return []

  const normalizedCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd
  const root: TrieNode = { children: new Map(), isFile: false, additions: 0, deletions: 0 }

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
        child = { children: new Map(), isFile: false, additions: 0, deletions: 0 }
        node.children.set(segs[i], child)
      }
      if (i === segs.length - 1) {
        child.isFile = true
        child.additions += c.additions
        child.deletions += c.deletions
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
          isFile: true,
          additions: child.additions,
          deletions: child.deletions,
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

      // Sum additions/deletions from children (each child already includes its own subtree total)
      let totalAdd = 0
      let totalDel = 0
      for (const ch of children) {
        totalAdd += ch.additions
        totalDel += ch.deletions
      }
      // Include own file data if this node is also a file (edge case)
      if (c.isFile) {
        totalAdd += c.additions
        totalDel += c.deletions
      }

      return {
        name: cName,
        fullPath: cPath,
        isFile: false,
        additions: totalAdd,
        deletions: totalDel,
        children,
      }
    })
  }

  return toTree(root, "")
}

// ── Change bar (GitHub-style colored blocks) ────────────────────────────────

const CHANGE_BAR_BLOCKS = 5

function ChangeBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  if (total === 0) return null

  const addBlocks = Math.round((add / total) * CHANGE_BAR_BLOCKS)
  const delBlocks = CHANGE_BAR_BLOCKS - addBlocks

  return (
    <span className="flex items-center gap-[1px] shrink-0 ml-1">
      {Array.from({ length: addBlocks }, (_, i) => (
        <span key={`a${i}`} className="inline-block w-[6px] h-[6px] rounded-[1px] bg-green-500/70" />
      ))}
      {Array.from({ length: delBlocks }, (_, i) => (
        <span key={`d${i}`} className="inline-block w-[6px] h-[6px] rounded-[1px] bg-red-400/70" />
      ))}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface TurnChangedFilesProps {
  turn: Turn
  cwd: string
}

export const TurnChangedFiles = memo(function TurnChangedFiles({ turn, cwd }: TurnChangedFilesProps) {
  const fileChanges = useMemo(() => computeTurnFileChanges(turn), [turn])
  const tree = useMemo(() => buildFileTree(fileChanges, cwd), [fileChanges, cwd])

  const totals = useMemo(() => {
    let add = 0
    let del = 0
    for (const fc of fileChanges) {
      add += fc.additions
      del += fc.deletions
    }
    return { add, del }
  }, [fileChanges])

  const [allExpanded, setAllExpanded] = useState(true)

  if (fileChanges.length === 0) return null

  return (
    <div className="rounded-lg border border-border/30 overflow-hidden bg-elevation-1/30">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20">
        <FileCode2 className="size-3.5 text-muted-foreground/50" />
        <span className="text-[11px] font-medium text-muted-foreground/70">
          {fileChanges.length} file{fileChanges.length !== 1 ? "s" : ""} changed
        </span>
        <span className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
          <span className="text-green-500/80">+{totals.add}</span>
          <span className="text-red-400/80">-{totals.del}</span>
        </span>
        <ChangeBar add={totals.add} del={totals.del} />
        <div className="flex-1" />
        <button
          onClick={() => setAllExpanded(!allExpanded)}
          className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
          title={allExpanded ? "Collapse all" : "Expand all"}
        >
          {allExpanded
            ? <ChevronsDownUp className="size-3" />
            : <ChevronsUpDown className="size-3" />}
        </button>
      </div>

      {/* Tree */}
      <div className="px-2 py-1">
        {tree.map((node) => (
          <TreeRow key={node.fullPath} node={node} depth={0} allExpanded={allExpanded} />
        ))}
      </div>
    </div>
  )
})

// ── Tree row (recursive) ─────────────────────────────────────────────────────

function TreeRow({
  node,
  depth,
  allExpanded,
}: {
  node: TreeNode
  depth: number
  allExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  // Sync with global expand/collapse toggle
  useEffect(() => {
    setExpanded(allExpanded)
  }, [allExpanded])

  const paddingLeft = depth * 16 + 8

  if (node.isFile) {
    return (
      <div
        className="flex items-center gap-1.5 py-[3px] text-[11px] font-mono rounded-sm hover:bg-white/[0.02] transition-colors"
        style={{ paddingLeft }}
      >
        <FileTypeIndicator name={node.name} />
        <span className="text-foreground/75 truncate">{node.name}</span>
        <div className="flex-1 min-w-2" />
        <LineCounts add={node.additions} del={node.deletions} />
        <ChangeBar add={node.additions} del={node.deletions} />
      </div>
    )
  }

  return (
    <>
      <div
        className="flex items-center gap-1 py-[3px] text-[11px] font-mono cursor-pointer hover:bg-white/[0.03] rounded-sm select-none transition-colors"
        style={{ paddingLeft }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground/40 shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/40 shrink-0" />
        )}
        <Folder className="size-3 text-blue-400/40 shrink-0" />
        <span className="text-foreground/40">{node.name}</span>
        <div className="flex-1 min-w-2" />
        {!expanded && <LineCounts add={node.additions} del={node.deletions} dimmed />}
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            allExpanded={allExpanded}
          />
        ))}
    </>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function LineCounts({ add, del, dimmed }: { add: number; del: number; dimmed?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 shrink-0 text-[10px] font-mono tabular-nums",
        dimmed && "opacity-40",
      )}
    >
      {add > 0 && <span className="text-green-500">+{add}</span>}
      {del > 0 && <span className="text-red-400">-{del}</span>}
    </span>
  )
}

const EXT_COLORS: Record<string, string> = {
  tsx: "bg-blue-400/70",
  jsx: "bg-blue-400/70",
  ts: "bg-yellow-400/70",
  js: "bg-yellow-400/70",
  mjs: "bg-yellow-400/70",
  cjs: "bg-yellow-400/70",
  css: "bg-purple-400/70",
  scss: "bg-purple-400/70",
  less: "bg-purple-400/70",
  json: "bg-amber-400/70",
  yaml: "bg-amber-400/70",
  yml: "bg-amber-400/70",
  toml: "bg-amber-400/70",
  md: "bg-blue-300/70",
  mdx: "bg-blue-300/70",
  html: "bg-orange-400/70",
  htm: "bg-orange-400/70",
  py: "bg-green-400/70",
  rs: "bg-orange-500/70",
  go: "bg-cyan-400/70",
}

function FileTypeIndicator({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  const color = EXT_COLORS[ext] ?? "bg-muted-foreground/40"
  return <div className={cn("size-2 rounded-[2px] shrink-0", color)} />
}
