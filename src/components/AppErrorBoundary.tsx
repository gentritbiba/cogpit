import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

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
      <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
        <Card className="w-full max-w-lg text-center">
          <CardHeader className="justify-items-center">
            <AlertTriangle aria-hidden="true" className="mb-2 size-8 text-destructive" />
            <CardTitle><h1>Cogpit hit a render error</h1></CardTitle>
            <CardDescription>
              Reload the app to recover. Your sessions and project files are unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-40 w-full overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs whitespace-pre-wrap">
              {message}
            </pre>
          </CardContent>
          <CardFooter className="justify-center">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw data-icon="inline-start" />
              Reload Cogpit
            </Button>
          </CardFooter>
        </Card>
      </main>
    )
  }
}
