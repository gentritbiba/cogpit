import { createContext, useContext, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode } from "react"
import { BlockWindow, WINDOW_MIN_ITEMS, type BlockWindowHost, type WindowPlan } from "@/lib/timelineScroll/blockWindow"
import { useDisclosureKey, useScopeTurnKey } from "./disclosure"

/** The scroll engine, for lists inside rows that window their items. Absent outside the timeline list. */
export const BlockWindowHostContext = createContext<BlockWindowHost | null>(null)

export interface WindowItem {
  key: string
  /** Called only for the items that mount. */
  render: () => ReactNode
  /** The turn's content blocks this item renders, first and last index; find scopes its matches with them. */
  blocks?: readonly [number, number]
}

const NO_KEYS: readonly string[] = []
const NO_ITEMS: readonly WindowItem[] = []
const noSubscription = () => () => {}
const noPlan = () => null

/**
 * Renders `items` in order. In the timeline, a list longer than
 * `WINDOW_MIN_ITEMS` mounts only the items near the viewport and stands in
 * spacers for the rest; `pinned` items stay mounted wherever they are.
 */
export function WindowedItems({ id, items, pinned = NO_KEYS, className }: {
  /** Unique within the turn; keys the measured heights. */
  id: string
  items: readonly WindowItem[]
  pinned?: readonly string[]
  className?: string
}) {
  const host = useContext(BlockWindowHostContext)
  const rowKey = useScopeTurnKey()
  const windowId = useDisclosureKey(id)
  const long = items.length > WINDOW_MIN_ITEMS
  // The items mounted while the list rendered whole, which a window taking it over keeps until it measures.
  const mountedWhole = useRef<readonly WindowItem[]>(NO_ITEMS)
  const active = useMemo(
    () => (long && host && rowKey !== null && windowId !== null
      ? new BlockWindow(host, windowId, rowKey, mountedWhole.current.map((item) => item.key))
      : null),
    [long, host, rowKey, windowId],
  )
  if (active) active.setItems(items.map((item) => item.key), pinned)
  const plan = useSyncExternalStore(active ? active.subscribe : noSubscription, active ? active.getPlan : noPlan)
  const containerRef = useRef<HTMLDivElement>(null)
  const [, forceRender] = useReducer((count: number) => count + 1, 0)

  useLayoutEffect(() => {
    if (!active || !containerRef.current) return
    const detach = active.attach(containerRef.current)
    // The store subscription starts after paint; render a range planned on attach now.
    if (active.getPlan() !== plan) forceRender()
    return detach
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attaching once per window and container
  }, [active])

  useLayoutEffect(() => {
    if (active && plan) active.rendered(plan)
    mountedWhole.current = active ? NO_ITEMS : items
  })

  if (items.length === 0) return null
  return (
    <div ref={containerRef} className={className}>
      {active && plan ? renderPlan(plan, items, active) : items.map((item) => <Item key={item.key} item={item} />)}
    </div>
  )
}

function renderPlan(plan: WindowPlan, items: readonly WindowItem[], blockWindow: BlockWindow): ReactNode[] {
  const children: ReactNode[] = []
  plan.runs.forEach((run, i) => {
    if (plan.before[i] > 0) children.push(<Spacer key={`before:${items[run.start].key}`} height={plan.before[i]} />)
    for (let index = run.start; index < run.end; index++) {
      const item = items[index]
      children.push(<Item key={item.key} item={item} itemRef={blockWindow.itemRef(item.key)} />)
    }
  })
  if (plan.after > 0) children.push(<Spacer key="after" height={plan.after} />)
  return children
}

function Spacer({ height }: { height: number }) {
  return <div aria-hidden data-window-spacer="" style={{ height }} />
}

function Item({ item, itemRef }: { item: WindowItem; itemRef?: (el: HTMLElement | null) => () => void }) {
  return (
    <div
      ref={itemRef}
      data-block-key={item.key}
      data-blocks={item.blocks ? `${item.blocks[0]}-${item.blocks[1]}` : undefined}
      className="min-w-0"
    >
      {item.render()}
    </div>
  )
}
