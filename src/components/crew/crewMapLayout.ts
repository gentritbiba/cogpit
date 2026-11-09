/**
 * The Crew map: which sessions it draws under the All / Active filter, which
 * branches the user folded, and where each card and connector sits. Kept free
 * of React so the rules are tested on their own.
 */

import type { CrewMember, SessionCrew } from "../../../shared/contracts/crew"
import { memberCellState } from "./crewView"

export type CrewMapFilter = "all" | "active"

export const CARD_WIDTH = 196
export const CARD_HEIGHT = 86
/** Room between a card and its children, where the connectors and the fold toggle sit. */
export const COLUMN_GAP = 40
export const ROW_GAP = 12
/** Extra room between separate trees, for members whose parent the caller cannot see. */
const TREE_GAP = 28
const CORNER = 6
/** This many childless siblings or more share a grid in the expanded view, rather than a column a screen tall. */
export const GROUP_MIN = 8
/** Room between a grid's frame and its cards. */
export const GROUP_INSET = 10
const GROUP_MAX_COLUMNS = 6
/** Stacked, how far a card sits in from the one that started it; its connector runs down the middle of that step. */
export const INDENT = 28
/** Stacked, the room to the right of a card for its fold toggle. */
export const FOLD_ROOM = 36

/** Working, or waiting on the user: what the Active filter keeps. */
export function isActiveMember(member: CrewMember): boolean {
  const state = memberCellState(member)
  return state === "working" || state === "needs-you"
}

export interface HiddenWork {
  /** Members a folded branch hides. */
  count: number
  working: number
  needsYou: number
}

export interface CrewMapNode {
  member: CrewMember
  depth: number
  x: number
  y: number
  /** Members it started that the current filter shows. */
  childCount: number
  collapsed: boolean
  /** What its fold hides; zero when it is open. */
  hidden: HiddenWork
  /** Drawn under Active only because something it started is active. */
  context: boolean
  /** Sits in its parent's grid of childless sessions. */
  grouped: boolean
}

/** A frame around a parent's childless sessions, laid out as a grid. */
export interface CrewMapGroup {
  parentId: string
  x: number
  y: number
  width: number
  height: number
}

export interface CrewMapEdge {
  parentId: string
  /** One path for the trunk and every branch, so a translucent stroke does not darken where they overlap. */
  path: string
}

/**
 * Across reads left to right by depth, for the expanded view and a panel wide
 * enough for it; stacked puts every card on its own row, stepped in under its
 * parent, so a deep crew reads at full size in a narrow panel.
 */
export type CrewMapOrientation = "across" | "stacked"

export interface CrewMapLayout {
  orientation: CrewMapOrientation
  /** Every card's width; stacked cards widen to the room the panel has. */
  cardWidth: number
  nodes: CrewMapNode[]
  edges: CrewMapEdge[]
  groups: CrewMapGroup[]
  width: number
  height: number
}

export interface CrewMapCounts {
  /** Every session the crew shows, the root included. */
  all: number
  /** Sessions working or waiting on the user, the root included. */
  active: number
  working: number
  needsYou: number
}

export function crewMapCounts(crew: SessionCrew): CrewMapCounts {
  const counts: CrewMapCounts = { all: crew.members.length, active: 0, working: 0, needsYou: 0 }
  for (const member of crew.members) {
    const state = memberCellState(member)
    if (state === "working") counts.working++
    else if (state === "needs-you") counts.needsYou++
  }
  counts.active = counts.working + counts.needsYou
  return counts
}

interface Forest {
  roots: CrewMember[]
  childrenOf: Map<string, CrewMember[]>
}

const byStart = (a: CrewMember, b: CrewMember) =>
  (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId)

/** The crew as parent and children, rooted at its root, plus a tree for each member whose parent is not in the crew. */
function forestOf(crew: SessionCrew): Forest {
  const byId = new Map(crew.members.map((member) => [member.sessionId, member]))
  const childrenOf = new Map<string, CrewMember[]>()
  const roots: CrewMember[] = []
  for (const member of crew.members) {
    const parent = member.parentId && member.sessionId !== crew.rootId ? byId.get(member.parentId) : undefined
    if (!parent) {
      roots.push(member)
      continue
    }
    const siblings = childrenOf.get(parent.sessionId)
    if (siblings) siblings.push(member)
    else childrenOf.set(parent.sessionId, [member])
  }
  for (const siblings of childrenOf.values()) siblings.sort(byStart)
  roots.sort((a, b) => Number(b.sessionId === crew.rootId) - Number(a.sessionId === crew.rootId) || byStart(a, b))
  return { roots, childrenOf }
}

/**
 * The sessions a filter shows. Active keeps every working or waiting member
 * and each of its ancestors up to the root, so a busy branch is never cut off
 * from where it started; nothing else.
 */
export function shownMembers(crew: SessionCrew, filter: CrewMapFilter): Set<string> {
  if (filter === "all") return new Set(crew.members.map((member) => member.sessionId))
  const byId = new Map(crew.members.map((member) => [member.sessionId, member]))
  const shown = new Set<string>()
  for (const member of crew.members) {
    if (!isActiveMember(member)) continue
    let at: CrewMember | undefined = member
    while (at && !shown.has(at.sessionId)) {
      shown.add(at.sessionId)
      at = at.sessionId === crew.rootId || !at.parentId ? undefined : byId.get(at.parentId)
    }
  }
  return shown
}

/** How many levels sit under the root, for the whole crew whatever the filter, so a filter or a fold never changes the orientation. */
export function crewDepth(crew: SessionCrew): number {
  const { roots, childrenOf } = forestOf(crew)
  const seen = new Set<string>()
  let deepest = 0
  const stack = roots.map((member) => ({ member, depth: 0 }))
  while (stack.length > 0) {
    const { member, depth } = stack.pop()!
    if (seen.has(member.sessionId)) continue
    seen.add(member.sessionId)
    deepest = Math.max(deepest, depth)
    for (const child of childrenOf.get(member.sessionId) ?? []) stack.push({ member: child, depth: depth + 1 })
  }
  return deepest
}

/** How wide the across layout of a crew this deep is, without grids. */
export function acrossWidth(depth: number): number {
  return (depth + 1) * CARD_WIDTH + depth * COLUMN_GAP
}

export interface LayoutOptions {
  /** Across, gather a parent's many childless sessions into one framed grid after its other children. */
  group?: boolean
  /** Lay the crew out stacked, with cards this wide. */
  stacked?: { cardWidth: number }
}

/**
 * Across: cards in columns by depth, one row per card that has no shown
 * children, a parent level with its first child so the eye reads down the
 * crew the way the list does; with `group`, a wide, shallow crew fits a
 * screen. Stacked: one row per card, each stepped in under its parent.
 */
export function layoutCrewMap(
  crew: SessionCrew,
  filter: CrewMapFilter,
  collapsed: ReadonlySet<string>,
  { group = false, stacked }: LayoutOptions = {},
): CrewMapLayout {
  const { roots, childrenOf } = forestOf(crew)
  const shown = shownMembers(crew, filter)
  const visibleChildren = (id: string) => (childrenOf.get(id) ?? []).filter((child) => shown.has(child.sessionId))
  const cardWidth = stacked?.cardWidth ?? CARD_WIDTH
  const nodes: CrewMapNode[] = []
  const edges: CrewMapEdge[] = []
  const groups: CrewMapGroup[] = []
  const placed = new Set<string>()
  let cursor = 0
  let right = 0

  const hiddenUnder = (id: string): HiddenWork => {
    const work: HiddenWork = { count: 0, working: 0, needsYou: 0 }
    const counted = new Set<string>()
    const stack = [...visibleChildren(id)]
    while (stack.length > 0) {
      const member = stack.pop()!
      if (placed.has(member.sessionId) || counted.has(member.sessionId)) continue
      counted.add(member.sessionId)
      work.count++
      const state = memberCellState(member)
      if (state === "working") work.working++
      else if (state === "needs-you") work.needsYou++
      stack.push(...visibleChildren(member.sessionId))
    }
    return work
  }
  const unplacedChildren = (id: string) => visibleChildren(id).filter((child) => !placed.has(child.sessionId))
  const drawsNothingUnder = (member: CrewMember) => unplacedChildren(member.sessionId).length === 0 || collapsed.has(member.sessionId)

  /** Places a member and what it started, returning the top of its card. A grid cell is placed at `cell` and takes no row of its own. */
  const place = (member: CrewMember, depth: number, cell?: { x: number; y: number }): number => {
    placed.add(member.sessionId)
    const children = unplacedChildren(member.sessionId)
    const folded = children.length > 0 && collapsed.has(member.sessionId)
    const open = folded ? [] : children
    const leaves = group && !stacked && open.length >= GROUP_MIN ? open.filter(drawsNothingUnder) : []
    const grid = leaves.length >= GROUP_MIN ? leaves : []
    const inGrid = new Set(grid)
    const branches = open.filter((child) => !inGrid.has(child))
    const node: CrewMapNode = {
      member,
      depth,
      x: cell?.x ?? depth * (stacked ? INDENT : CARD_WIDTH + COLUMN_GAP),
      // A parent whose first child is a grid sits level with the grid's first row.
      y: cell?.y ?? cursor + (branches.length === 0 && grid.length > 0 ? GROUP_INSET : 0),
      childCount: children.length,
      collapsed: folded,
      hidden: folded ? hiddenUnder(member.sessionId) : { count: 0, working: 0, needsYou: 0 },
      context: filter === "active" && !isActiveMember(member),
      grouped: Boolean(cell),
    }
    nodes.push(node)
    right = Math.max(right, node.x + cardWidth + (stacked && children.length > 0 ? FOLD_ROOM : 0))
    if (stacked) {
      cursor += CARD_HEIGHT + ROW_GAP
      const childYs = open.map((child) => place(child, depth + 1))
      if (childYs.length > 0) edges.push({ parentId: member.sessionId, path: stackedConnector(node.x, node.y, childYs) })
      return node.y
    }
    if (folded) {
      const y = node.y + CARD_HEIGHT / 2
      edges.push({ parentId: member.sessionId, path: `M${node.x + CARD_WIDTH} ${y}H${node.x + CARD_WIDTH + COLUMN_GAP / 2}` })
    }
    if (cell) return node.y
    if (open.length === 0) {
      cursor += CARD_HEIGHT + ROW_GAP
      return node.y
    }
    const childYs = branches.map((child) => place(child, depth + 1))
    if (grid.length > 0) childYs.push(placeGrid(member.sessionId, grid, depth + 1) + GROUP_INSET)
    edges.push({ parentId: member.sessionId, path: acrossConnector(node.x + CARD_WIDTH, node.y, childYs) })
    return node.y
  }

  /** Lays childless siblings out in a framed grid at the next row, returning the top of the frame. */
  const placeGrid = (parentId: string, members: readonly CrewMember[], depth: number): number => {
    const columns = Math.min(GROUP_MAX_COLUMNS, Math.max(2, Math.ceil(Math.sqrt(members.length / 1.5))))
    const rows = Math.ceil(members.length / columns)
    const frame: CrewMapGroup = {
      parentId,
      x: depth * (CARD_WIDTH + COLUMN_GAP),
      y: cursor,
      width: columns * CARD_WIDTH + (columns - 1) * COLUMN_GAP + 2 * GROUP_INSET,
      height: rows * CARD_HEIGHT + (rows - 1) * ROW_GAP + 2 * GROUP_INSET,
    }
    groups.push(frame)
    members.forEach((member, index) => place(member, depth, {
      x: frame.x + GROUP_INSET + (index % columns) * (CARD_WIDTH + COLUMN_GAP),
      y: frame.y + GROUP_INSET + Math.floor(index / columns) * (CARD_HEIGHT + ROW_GAP),
    }))
    right = Math.max(right, frame.x + frame.width)
    cursor += frame.height + ROW_GAP
    return frame.y
  }

  for (const root of roots) {
    if (!shown.has(root.sessionId) || placed.has(root.sessionId)) continue
    if (nodes.length > 0) cursor += TREE_GAP
    place(root, 0)
  }
  return {
    orientation: stacked ? "stacked" : "across",
    cardWidth,
    nodes,
    edges,
    groups,
    width: right,
    height: Math.max(0, cursor - ROW_GAP),
  }
}

/** From the parent's right edge, along a trunk, into each child's left edge with a rounded elbow. */
function acrossConnector(fromX: number, parentY: number, childYs: readonly number[]): string {
  const startY = parentY + CARD_HEIGHT / 2
  const segments = [`M${fromX} ${startY}H${fromX + COLUMN_GAP}`]
  for (const childY of childYs) {
    if (childY !== parentY) segments.push(acrossBranch(fromX, startY, childY + CARD_HEIGHT / 2))
  }
  return segments.join("")
}

function acrossBranch(fromX: number, startY: number, y: number): string {
  const trunkX = fromX + COLUMN_GAP / 2
  return `M${trunkX} ${startY}V${y - CORNER}Q${trunkX} ${y} ${trunkX + CORNER} ${y}H${fromX + COLUMN_GAP}`
}

/** From under the parent's card, down its step, into each child's left edge with a rounded elbow. */
function stackedConnector(parentX: number, parentY: number, childYs: readonly number[]): string {
  return childYs.map((childY) => stackedBranch(parentX, parentY, childY)).join("")
}

function stackedBranch(parentX: number, parentY: number, childY: number): string {
  const railX = parentX + INDENT / 2
  const y = childY + CARD_HEIGHT / 2
  return `M${railX} ${parentY + CARD_HEIGHT}V${y - CORNER}Q${railX} ${y} ${railX + CORNER} ${y}H${parentX + INDENT}`
}

/** The connectors from the root to a session, drawn over the others so the user can see where they are. */
export function trailTo(layout: CrewMapLayout, sessionId: string | null): string | null {
  const nodes = new Map(layout.nodes.map((node) => [node.member.sessionId, node]))
  const frames = new Map(layout.groups.map((frame) => [frame.parentId, frame]))
  let at = sessionId ? nodes.get(sessionId) : undefined
  const segments: string[] = []
  while (at?.member.parentId) {
    const parentId = at.member.parentId
    const parent = nodes.get(parentId)
    if (!parent || parent.depth !== at.depth - 1) break
    if (layout.orientation === "stacked") {
      segments.unshift(stackedBranch(parent.x, parent.y, at.y))
      at = parent
      continue
    }
    const fromX = parent.x + CARD_WIDTH
    const startY = parent.y + CARD_HEIGHT / 2
    // A card in a grid is reached through its frame, whose first row the connector enters.
    const frame = at.grouped ? frames.get(parentId) : undefined
    const y = (frame ? frame.y + GROUP_INSET : at.y) + CARD_HEIGHT / 2
    segments.unshift(y === startY ? `M${fromX} ${startY}H${fromX + COLUMN_GAP}` : `M${fromX} ${startY}H${fromX + COLUMN_GAP / 2}${acrossBranch(fromX, startY, y)}`)
    at = parent
  }
  return segments.length > 0 ? segments.join("") : null
}
