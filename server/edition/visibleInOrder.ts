import { mapWithConcurrency } from "../lib/mapWithConcurrency"
import type { VisibilityCheck, VisibilityPick, VisibleSession, WithAccess } from "./types"

/** Items checked, or annotated, at once; a first listing may read that many transcript heads. */
const CHECK_BATCH = 16

/** A list item the caller may see, with the session that annotates it. */
export interface VisibleItem<T> {
  item: T
  session: VisibleSession
}

/**
 * Each item with what `check` answered for it, in the order given. Checked a
 * batch at a time and yielded as answered, so a reader that stops early stops
 * checking too.
 */
async function* checkedInOrder<T, R>(items: readonly T[], check: (item: T) => Promise<R>): AsyncGenerator<[T, R]> {
  for (let start = 0; start < items.length; start += CHECK_BATCH) {
    const batch = items.slice(start, start + CHECK_BATCH)
    const answers = await Promise.all(batch.map((item) => check(item)))
    for (const [index, answer] of answers.entries()) yield [batch[index], answer]
  }
}

/**
 * The first `limit` entries `keep` accepts, in order, reading no further once
 * there are that many. A limit that is not a positive number (NaN included)
 * takes nothing, as a slice to it would.
 */
async function takeFirst<E>(
  entries: AsyncIterable<E> | Iterable<E>,
  limit: number,
  keep: (entry: E) => boolean,
): Promise<E[]> {
  const taken: E[] = []
  if (!(limit > 0)) return taken
  for await (const entry of entries) {
    if (!keep(entry)) continue
    taken.push(entry)
    if (taken.length >= limit) break
  }
  return taken
}

/** The items `check` lets the caller see, in the order given, checked no further than the reader reads. */
export async function* visibleInOrder<T>(
  items: readonly T[],
  check: VisibilityCheck,
  pick: (item: T) => VisibilityPick,
): AsyncGenerator<VisibleItem<T>> {
  const checked = checkedInOrder(items, (item) => {
    const { sessionId, hint } = pick(item)
    return check(sessionId, hint)
  })
  for await (const [item, session] of checked) {
    if (session !== "hidden") yield { item, session }
  }
}

/** The first `limit` visible items that `keep` accepts, reading no further once there are that many. */
export function takeVisible<T>(
  visible: AsyncIterable<VisibleItem<T>> | Iterable<VisibleItem<T>>,
  limit: number,
  keep: (item: T) => boolean = () => true,
): Promise<Array<VisibleItem<T>>> {
  return takeFirst(visible, limit, (entry) => keep(entry.item))
}

/** The first `limit` items that pass `test`, in order, checking no further batch once there are that many. */
export async function takeInOrder<T>(
  items: readonly T[],
  test: (item: T) => Promise<boolean>,
  limit: number,
): Promise<T[]> {
  const taken = await takeFirst(checkedInOrder(items, test), limit, ([, passes]) => passes)
  return taken.map(([item]) => item)
}

/** Every item `check` lets the caller see, in the order given. */
export async function allVisible<T>(
  items: readonly T[],
  check: VisibilityCheck,
  pick: (item: T) => VisibilityPick,
): Promise<Array<VisibleItem<T>>> {
  const visible: Array<VisibleItem<T>> = []
  for await (const entry of visibleInOrder(items, check, pick)) visible.push(entry)
  return visible
}

/** Each item as its session annotates it, without those whose access went away since their check. */
export async function annotateAll<T extends object>(visible: ReadonlyArray<VisibleItem<T>>): Promise<Array<WithAccess<T>>> {
  const annotated = await mapWithConcurrency(visible, CHECK_BATCH, ({ item, session }) => session.annotate(item))
  return annotated.filter((item) => item !== null)
}
