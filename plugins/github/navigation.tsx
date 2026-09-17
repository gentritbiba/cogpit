import { createContext, useContext } from "react"
import { Description as PublicDescription } from "@cogpit/plugin-ui"

export const GitHubNavigation = createContext<((url: string) => void) | undefined>(undefined)
export const useGitHubNavigation = () => useContext(GitHubNavigation)
export function Description({ body }: { body: string }) {
  return <PublicDescription body={body} openExternal={useGitHubNavigation()} />
}
