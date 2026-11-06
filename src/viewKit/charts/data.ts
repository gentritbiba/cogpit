/** Reading chart data: which keys are series, what kind of values the x key holds. */
import { formatValue } from "../ui"

export type Datum = Record<string, unknown>
export type XKind = "number" | "time" | "category"

export interface SeriesSpec {
  key: string
  label?: string
  color?: string
}

export interface Series {
  key: string
  label: string
  color: string
}

/** One key, a spec, or several; colors run through `--chart-1` to `--chart-5` unless given. */
export type SeriesInput = string | SeriesSpec | readonly (string | SeriesSpec)[]

export function chartColor(index: number, colors?: readonly string[]): string {
  return colors?.[index] ?? `var(--chart-${(index % 5) + 1})`
}

export function resolveSeries(input: SeriesInput, colors?: readonly string[]): Series[] {
  const list = (Array.isArray(input) ? input : [input]) as readonly (string | SeriesSpec)[]
  return list.map((item, index) => {
    const spec = typeof item === "string" ? { key: item } : item
    return { key: spec.key, label: spec.label ?? spec.key, color: spec.color ?? chartColor(index, colors) }
  })
}

/** A finite number from a number or numeric string, else null. */
export function numberOf(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null
}

const ISO_DATE = /^\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

const DAY = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/

/** A Date; a bare day or month (`2026-03-01`, `2026-03`) is local midnight, as people mean it, not UTC. */
export function dateOf(value: unknown): Date {
  if (value instanceof Date) return value
  const day = DAY.exec(String(value))
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3] ?? 1)) : new Date(String(value))
}

export function xKindOf(values: readonly unknown[]): XKind {
  const present = values.filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return "category"
  if (present.every((value) => typeof value === "number" && Number.isFinite(value))) return "number"
  if (present.every((value) => value instanceof Date || (typeof value === "string" && ISO_DATE.test(value)))) return "time"
  return "category"
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

/** Axis numbers: compact from ten thousand up (12K, 3.4M). */
export function formatAxisNumber(value: number): string {
  return Math.abs(value) >= 10_000 ? compact.format(value) : formatValue(value)
}

export function formatX(value: unknown, kind: XKind): string {
  if (kind === "time") return dateOf(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
  return formatValue(value)
}
