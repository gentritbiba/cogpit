import type { QuoteSource } from "../../../shared/session/composerContext"

export type OpenSearchQuote = (source: QuoteSource, text: string, turn?: number | null) => Promise<boolean>
