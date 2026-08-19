import { Component, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  fallbackMessage?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("ErrorBoundary caught:", error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex justify-center p-8">
          <Alert variant="destructive" className="max-w-md has-data-[slot=alert-action]:pr-2.5">
            <AlertTriangle />
            <AlertTitle>
              <h3>
                {this.props.fallbackMessage || "Something went wrong"}
              </h3>
            </AlertTitle>
            {this.state.error && (
              <AlertDescription className="font-mono text-xs">
                {this.state.error.message}
              </AlertDescription>
            )}
            <AlertAction className="static col-start-2 mt-2">
              <Button variant="outline" size="sm" onClick={this.handleRetry}>
                <RefreshCw data-icon="inline-start" />
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )
    }

    return this.props.children
  }
}
