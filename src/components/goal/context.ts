import { createContext, useContext, type ReactNode } from "react"

export interface GoalControls {
  /** The full-width goal row — the live goal or its editor. Null when neither applies. */
  section: ReactNode
  /** True while no goal exists yet and the agent supports creating one. */
  canCreate: boolean
  beginEditing: () => void
}

const NO_GOAL_SUPPORT: GoalControls = {
  section: null,
  canCreate: false,
  beginEditing: () => {},
}

export const GoalContext = createContext<GoalControls>(NO_GOAL_SUPPORT)

export function useGoalControls(): GoalControls {
  return useContext(GoalContext)
}
