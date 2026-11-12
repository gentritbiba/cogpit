import { useEffect, useState } from "react"
import { CheckCircle, Loader2, Sparkles, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { useMemoryEmbeddings } from "@/hooks/useMemoryEmbeddings"
import {
  sameEmbeddingOrigin,
  suggestedQueryPrefix,
  type EmbeddingSettingsInput,
  type EmbeddingSettingsReport,
  type EmbeddingSettingsView,
  type EmbeddingTestResult,
} from "../../../shared/contracts/memoryEmbeddings"
import { SectionTrigger } from "./SectionTrigger"

/** How often the progress line is read again while session text is still being indexed. */
const PROGRESS_POLL_MS = 5_000

function isBehind(report: EmbeddingSettingsReport | null): boolean {
  return !!report?.settings && !!report.progress && report.progress.embedded < report.progress.passages
}

function summarize(report: EmbeddingSettingsReport | null): string {
  if (!report) return "Unavailable"
  if (report.error) return "Not working"
  if (!report.settings) return "Off"
  const { progress } = report
  if (progress && progress.embedded < progress.passages) return `Indexing ${Math.floor((progress.embedded / progress.passages) * 100)}%`
  return "On"
}

/** Server messages start lower-case because the CLI prints them after a label. */
function sentence(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1)
}

function ProgressLine({ progress }: { progress: NonNullable<EmbeddingSettingsReport["progress"]> }) {
  const { passages, embedded } = progress
  if (passages === 0) return <p className="text-xs text-muted-foreground">No session text is stored yet.</p>
  const label = `${embedded.toLocaleString()} of ${passages.toLocaleString()} passages indexed`
  if (embedded >= passages) return <p className="text-xs text-muted-foreground">{label}</p>
  return (
    <Progress value={(embedded / passages) * 100} aria-label="Passages indexed">
      <p className="text-xs text-muted-foreground">{label}</p>
    </Progress>
  )
}

function TestLine({ result }: { result: EmbeddingTestResult }) {
  return result.ok ? (
    <p className="flex items-center gap-2 text-xs text-success" role="status">
      <CheckCircle className="size-3.5 shrink-0" />
      The endpoint answered in {result.ms.toLocaleString()} ms
    </p>
  ) : (
    <p className="flex items-start gap-2 text-xs text-destructive" role="alert">
      <XCircle className="mt-0.5 size-3.5 shrink-0" />
      {sentence(result.error)}
    </p>
  )
}

interface EndpointFormProps {
  saved: EmbeddingSettingsView | null
  defaults: EmbeddingSettingsReport["defaults"]
  disabled: boolean
  busy: "save" | "test" | null
  onSave: (settings: EmbeddingSettingsInput) => void
  onTest: (settings: EmbeddingSettingsInput) => Promise<EmbeddingTestResult>
  onTurnOff: () => void
}

function EndpointForm({ saved, defaults, disabled, busy, onSave, onTest, onTurnOff }: EndpointFormProps) {
  const [url, setUrl] = useState(saved?.url ?? "")
  const [model, setModel] = useState(saved?.model ?? "")
  const [apiKey, setApiKey] = useState("")
  const [dimensions, setDimensions] = useState(String(saved?.dimensions ?? defaults.dimensions))
  const [queryPrefix, setQueryPrefix] = useState(saved?.queryPrefix ?? "")
  // Until someone writes an instruction, the model's suggested one follows the model name.
  const [prefixIsOwn, setPrefixIsOwn] = useState(saved !== null)
  const [minScore, setMinScore] = useState(String(saved?.minScore ?? defaults.minScore))
  const [advanced, setAdvanced] = useState(false)
  const [testResult, setTestResult] = useState<EmbeddingTestResult | null>(null)

  const keepsKey = !!saved?.hasApiKey && sameEmbeddingOrigin(saved.url, url.trim())
  const dimensionCount = Number(dimensions)
  const score = Number(minScore)
  const valid =
    /^https?:\/\/\S+$/.test(url.trim())
    && model.trim().length > 0
    && Number.isInteger(dimensionCount) && dimensionCount >= 8 && dimensionCount <= 8192
    && minScore.trim() !== "" && score >= 0 && score <= 1
  const changed =
    saved === null
    || url.trim() !== saved.url
    || model.trim() !== saved.model
    || apiKey !== ""
    || dimensionCount !== saved.dimensions
    || queryPrefix !== saved.queryPrefix
    || score !== saved.minScore

  const settings = (): EmbeddingSettingsInput => ({
    url: url.trim(),
    model: model.trim(),
    ...(apiKey ? { apiKey } : {}),
    dimensions: dimensionCount,
    queryPrefix,
    minScore: score,
  })

  const changeModel = (value: string) => {
    setModel(value)
    if (!prefixIsOwn) setQueryPrefix(suggestedQueryPrefix(value))
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && changed && !disabled) onSave(settings())
      }}
    >
      <Field>
        <FieldLabel htmlFor="embedding-url">Endpoint address</FieldLabel>
        <Input id="embedding-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/v1/embeddings" disabled={disabled} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="embedding-model">Model</FieldLabel>
        <Input id="embedding-model" value={model} onChange={(event) => changeModel(event.target.value)} placeholder="Qwen3-Embedding-0.6B" disabled={disabled} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="embedding-api-key">API key</FieldLabel>
        <Input
          id="embedding-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={keepsKey ? "Saved. Leave blank to keep it." : "Leave blank if the endpoint needs none"}
          disabled={disabled}
          autoComplete="off"
        />
        {saved?.hasApiKey && !keepsKey && (
          <FieldDescription>The saved key belongs to the old address, so it will not be sent to this one.</FieldDescription>
        )}
      </Field>

      <Button type="button" variant="link" size="sm" className="h-auto self-start px-0" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        {advanced ? "Hide advanced settings" : "Advanced settings"}
      </Button>
      {advanced && (
        <>
          <Field>
            <FieldLabel htmlFor="embedding-dimensions">Dimensions kept</FieldLabel>
            <FieldDescription>How much of each vector is stored. Changing this or the model indexes everything again.</FieldDescription>
            <Input id="embedding-dimensions" type="number" min={8} max={8192} step={1} value={dimensions} onChange={(event) => setDimensions(event.target.value)} disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel htmlFor="embedding-query-prefix">Query instruction</FieldLabel>
            <FieldDescription>Text put in front of each search, for models that expect an instruction. Leave blank for the rest.</FieldDescription>
            <Textarea
              id="embedding-query-prefix"
              value={queryPrefix}
              onChange={(event) => {
                setQueryPrefix(event.target.value)
                setPrefixIsOwn(true)
              }}
              disabled={disabled}
              className="font-mono text-xs md:text-xs"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="embedding-min-score">Minimum similarity</FieldLabel>
            <FieldDescription>From 0 to 1. Raise it if unrelated sessions show up, lower it if too few do.</FieldDescription>
            <Input id="embedding-min-score" type="number" min={0} max={1} step={0.01} value={minScore} onChange={(event) => setMinScore(event.target.value)} disabled={disabled} />
          </Field>
        </>
      )}

      {testResult && <TestLine result={testResult} />}

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!valid || !changed || busy !== null}>
            {busy === "save" && <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" />}
            Save endpoint
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!valid || busy !== null}
            onClick={async () => {
              setTestResult(null)
              setTestResult(await onTest(settings()))
            }}
          >
            {busy === "test" && <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" />}
            Test
          </Button>
          {saved && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={busy !== null} onClick={onTurnOff}>
              Turn off
            </Button>
          )}
        </div>
      )}
    </form>
  )
}

interface SearchSectionProps {
  disabled: boolean
}

/**
 * The embedding endpoint that lets session search match by meaning. The key is
 * write-only: the server keeps it and never sends it back.
 */
export function SearchSection({ disabled }: SearchSectionProps) {
  const { state, busy, error, refresh, save, turnOff, test } = useMemoryEmbeddings()
  const [open, setOpen] = useState(false)
  // A saved change remounts the form, so it starts again from what the server kept.
  const [formVersion, setFormVersion] = useState(0)

  const report = state.status === "ok" ? state.report : null
  const polling = open && isBehind(report)
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => void refresh(), PROGRESS_POLL_MS)
    return () => clearInterval(timer)
  }, [polling, refresh])

  // Someone who is not a host administrator has nothing to see here.
  if (state.status === "loading" || (state.status === "error" && state.httpStatus === 403)) return null

  const saved = async (change: Promise<boolean>) => {
    if (await change) setFormVersion((version) => version + 1)
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <SectionTrigger icon={Sparkles} title="Search by meaning" summary={summarize(report)} open={open} />

      <CollapsibleContent>
        <div className="flex flex-col gap-3">
          <FieldDescription>
            Finds sessions that mean what you searched for, even when they use other words. Cogpit sends session
            text to this address to index it, so use a server you trust. Any OpenAI-compatible embeddings endpoint works.
          </FieldDescription>

          {state.status === "error" && <p className="text-xs text-destructive" role="alert">{state.error}</p>}

          {report && (
            <>
              {report.settings && report.progress && <ProgressLine progress={report.progress} />}
              {report.error && <p className="text-xs text-destructive" role="alert">{sentence(report.error)}</p>}
              <EndpointForm
                key={formVersion}
                saved={report.settings}
                defaults={report.defaults}
                disabled={disabled}
                busy={busy}
                onSave={(settings) => void saved(save(settings))}
                onTest={test}
                onTurnOff={() => void saved(turnOff())}
              />
            </>
          )}

          {error && <p className="text-xs text-destructive" role="alert">{sentence(error)}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
