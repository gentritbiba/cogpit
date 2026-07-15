import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Cogpit] Unhandled render error", error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const message = this.state.error.message || "An unexpected render error occurred."
    return (
      <main className="flex h-dvh items-center justify-center bg-elevation-0 p-6 text-foreground">
        <section className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border border-border bg-elevation-1 p-6 text-center">
          <AlertTriangle aria-hidden="true" className="size-8 text-destructive" />
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold">Cogpit hit a render error</h1>
            <p className="text-sm text-muted-foreground">
              Reload the app to recover. Your sessions and project files are unchanged.
            </p>
          </div>
          <pre className="max-h-40 w-full overflow-auto rounded-lg bg-muted p-3 text-left font-mono text-xs whitespace-pre-wrap">
            {message}
          </pre>
          <Button onClick={() => window.location.reload()}>
            <RefreshCw data-icon="inline-start" />
            Reload Cogpit
          </Button>
        </section>
      </main>
    )
  }
}
