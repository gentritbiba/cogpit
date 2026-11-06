/** Mounts a stored view's root component, keeping a failure readable inside the view. */
import { Component, type ComponentType, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { useTheme } from "./hooks"

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    reportError(error)
  }
  render() {
    return this.state.error ? <ViewError error={this.state.error} /> : this.props.children
  }
}

function ViewError({ error }: { error: unknown }) {
  return (
    <div className="ck-error" role="alert">
      <strong>This view stopped with an error.</strong>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </div>
  )
}

/** Re-renders the whole app when the theme changes, so colors read in render follow it; state is kept. */
function ThemedApp({ App }: { App: ComponentType }) {
  useTheme()
  return <App />
}

/** `loadApp` returns the entry module's exports; a throw while loading it shows as the view's error. */
export function mount(loadApp: () => { default?: unknown }): void {
  const root = createRoot(document.getElementById("root")!)
  let App: ComponentType
  try {
    const entry = loadApp().default
    if (typeof entry !== "function") throw new Error("App.tsx must export a default component")
    App = entry as ComponentType
  } catch (error) {
    root.render(<ViewError error={error} />)
    reportError(error)
    return
  }
  root.render(<ErrorBoundary><ThemedApp App={App} /></ErrorBoundary>)
}
