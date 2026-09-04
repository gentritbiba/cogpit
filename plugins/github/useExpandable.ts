import { useState } from "react"
import type { GitHubErrorResponse } from "../../shared/contracts/github"
import { toErrorResponse } from "./githubStore"

export interface LazyResourceState<T> {
  data: T | null
  error: GitHubErrorResponse | null
  loading: boolean
}

const EMPTY_STATE: LazyResourceState<never> = { data: null, error: null, loading: false }

/**
 * Detail behind a collapsible row: fetched the first time it opens, and again
 * on every open while `stale` says the row is still moving.
 */
export function useExpandable<T>(
  fetchDetail: () => Promise<T>,
  fallbackError: string,
  stale = false,
): {
  open: boolean
  state: LazyResourceState<T>
  onOpenChange: (next: boolean) => void
} {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LazyResourceState<T>>(EMPTY_STATE)

  async function load(): Promise<void> {
    if (state.loading) return
    setState((current) => ({ ...current, error: null, loading: true }))
    try {
      setState({ data: await fetchDetail(), error: null, loading: false })
    } catch (error) {
      setState({ data: null, error: toErrorResponse(error, fallbackError), loading: false })
    }
  }

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (next && (!state.data || stale)) void load()
  }

  return { open, state, onOpenChange }
}
