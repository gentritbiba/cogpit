/**
 * Line, area, bar and scatter charts share one frame: scales chosen from the
 * data, axes and grid in the theme's colors, a legend for several series, a
 * hover guide with a tooltip, and a render prop for custom marks.
 */
import { useId, useState, type CSSProperties, type ReactNode } from "react"
import { extent } from "d3-array"
import { scaleBand, scaleLinear, scalePoint, scaleSqrt, scaleTime } from "d3-scale"
import { area, curveLinear, curveMonotoneX, curveStepAfter, line, stack, type CurveFactory, type Series as StackLayer, type SeriesPoint } from "d3-shape"
import { formatValue } from "../ui"
import { dateOf, formatAxisNumber, formatX, numberOf, resolveSeries, xKindOf, type Datum, type Series, type SeriesInput, type XKind } from "./data"
import { useWidth } from "./useWidth"

type Kind = "line" | "area" | "bar" | "scatter"

/** What a chart's render prop gets to draw its own marks in plot coordinates. */
export interface Plot {
  width: number
  height: number
  /** The x position of a value; the middle of its band for bars. */
  x: (value: unknown) => number
  y: (value: number) => number
  bandwidth: number
  data: readonly Datum[]
  series: Series[]
}

export interface CartesianChartProps {
  data: readonly Datum[]
  /** The key holding each row's x value: numbers, dates (Date or ISO strings) or categories. */
  x: string
  /** The key or keys to plot, or `{ key, label, color }` specs. */
  y: SeriesInput
  height?: number
  colors?: readonly string[]
  stacked?: boolean
  yDomain?: [number, number]
  xFormat?: (value: unknown) => string
  yFormat?: (value: number) => string
  legend?: boolean
  curve?: "linear" | "smooth" | "step"
  /** Points on lines and areas. */
  dots?: boolean
  /** Scatter only: a key sizing each point. */
  size?: string
  title?: string
  children?: (plot: Plot) => ReactNode
  className?: string
  style?: CSSProperties
}

const CURVES: Record<NonNullable<CartesianChartProps["curve"]>, CurveFactory> = { linear: curveLinear, smooth: curveMonotoneX, step: curveStepAfter }
const MARGIN = { top: 8, right: 12, bottom: 24 }

function Cartesian({
  kind, data, x, y, height = 240, colors, stacked = false, yDomain, xFormat, yFormat = formatAxisNumber,
  legend, curve = "linear", dots = false, size, title, children, className, style,
}: CartesianChartProps & { kind: Kind }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const clip = useId()
  const series = resolveSeries(y, colors)
  const xKind: XKind = kind === "bar" ? "category" : xKindOf(data.map((row) => row[x]))
  const rows = xKind === "category" ? data : [...data].sort((a, b) => xNumber(a[x], xKind) - xNumber(b[x], xKind))

  const layers: StackLayer<Datum, string>[] | null = stacked && series.length > 1
    ? stack<Datum>().keys(series.map((item) => item.key)).value((row, key) => numberOf(row[key]) ?? 0)(rows)
    : null
  const values = layers
    ? layers.flatMap((layer) => layer.flatMap(([low, high]) => [low, high]))
    : rows.flatMap((row) => series.map((item) => numberOf(row[item.key]))).filter((value): value is number => value !== null)
  let [low, high] = extent(values) as [number | undefined, number | undefined]
  low ??= 0
  high ??= 1
  if (kind === "bar" || kind === "area") {
    low = Math.min(0, low)
    high = Math.max(0, high)
  }
  if (low === high) {
    low -= 1
    high += 1
  }

  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom)
  const yScale = scaleLinear(yDomain ?? [low, high], [innerHeight, 0])
  if (!yDomain) yScale.nice()
  const yTicks = yScale.ticks(Math.max(2, Math.round(innerHeight / 45)))
  const left = 10 + Math.max(...yTicks.map((tick) => yFormat(tick).length)) * 6.5
  const innerWidth = Math.max(0, width - left - MARGIN.right)

  const categories = [...new Set(rows.map((row) => String(row[x])))]
  const band = scaleBand(categories, [0, innerWidth]).padding(0.2)
  const point = scalePoint(categories, [0, innerWidth]).padding(0.5)
  const continuous = xKind === "time"
    ? scaleTime(extent(rows, (row) => dateOf(row[x])) as [Date, Date], [0, innerWidth])
    : scaleLinear(extent(rows, (row) => numberOf(row[x])) as [number, number], [0, innerWidth])
  if (kind === "scatter") continuous.nice()
  const xOf = (value: unknown): number => {
    if (kind === "bar") return (band(String(value)) ?? 0) + band.bandwidth() / 2
    if (xKind === "category") return point(String(value)) ?? 0
    return continuous(xKind === "time" ? dateOf(value) : (numberOf(value) ?? 0) as never) ?? 0
  }
  const positions = rows.map((row) => xOf(row[x]))

  const labelOf = (value: unknown) => (xFormat ? xFormat(value) : formatX(value, xKind))
  const continuousLabel = (tick: number | Date): string => {
    if (xFormat) return xFormat(tick)
    if (xKind === "time") return (continuous as ReturnType<typeof scaleTime>).tickFormat()(tick as Date)
    return formatAxisNumber(tick as number)
  }
  const xTicks = xKind === "category"
    ? categories.filter((_, index) => index % Math.max(1, Math.ceil((categories.length * 64) / Math.max(1, innerWidth))) === 0)
      .map((category) => ({ key: category, at: xOf(category), label: xFormat ? xFormat(category) : category }))
    : continuous.ticks(Math.max(2, Math.round(innerWidth / 90))).map((tick) => ({
      key: String(+tick), at: continuous(tick as never) ?? 0, label: continuousLabel(tick),
    }))

  const plot: Plot = { width: innerWidth, height: innerHeight, x: xOf, y: (value) => yScale(value), bandwidth: kind === "bar" ? band.bandwidth() : 0, data: rows, series }
  const yAt = (row: Datum, key: string) => {
    const value = numberOf(row[key])
    return value === null ? null : yScale(value)
  }

  const nearest = (offsetX: number) => {
    let best = -1
    let distance = Infinity
    positions.forEach((position, index) => {
      const gap = Math.abs(position - offsetX)
      if (gap < distance) { best = index; distance = gap }
    })
    return best === -1 ? null : best
  }

  const marks = (() => {
    const shape = CURVES[curve]
    if (kind === "bar") {
      const inner = scaleBand(series.map((item) => item.key), [0, band.bandwidth()]).padding(0.08)
      return rows.flatMap((row, index) => series.map((item, order) => {
        const start = band(String(row[x])) ?? 0
        if (layers) {
          const [from, to] = layers[order]![index]!
          return <rect key={`${index}-${item.key}`} x={start} width={band.bandwidth()} y={yScale(Math.max(from, to))} height={Math.abs(yScale(from) - yScale(to))} rx={2} style={{ fill: item.color }} />
        }
        const value = numberOf(row[item.key])
        if (value === null) return null
        return (
          <rect
            key={`${index}-${item.key}`} x={start + (inner(item.key) ?? 0)} width={inner.bandwidth()}
            y={yScale(Math.max(0, value))} height={Math.abs(yScale(value) - yScale(0))} rx={3} style={{ fill: item.color }}
          />
        )
      }))
    }
    if (kind === "scatter") {
      const sizes = size ? scaleSqrt(extent(rows, (row) => numberOf(row[size]) ?? 0) as [number, number], [3, 14]) : null
      return rows.flatMap((row, index) => series.map((item) => {
        const at = yAt(row, item.key)
        if (at === null) return null
        const radius = sizes ? sizes(numberOf(row[size!]) ?? 0) : 4
        return <circle key={`${index}-${item.key}`} cx={positions[index]} cy={at} r={radius} style={{ fill: item.color, fillOpacity: 0.75 }} />
      }))
    }
    return series.map((item, order) => {
      const defined = (row: Datum) => numberOf(row[item.key]) !== null
      const strokePath = layers
        ? line<SeriesPoint<Datum>>().x((_, index) => positions[index]!).y(([, top]) => yScale(top)).curve(shape)(layers[order]!)
        : line<Datum>().defined(defined).x((row) => xOf(row[x])).y((row) => yScale(numberOf(row[item.key])!)).curve(shape)(rows)
      let fillPath: string | null = null
      if (kind === "area") {
        fillPath = layers
          ? area<SeriesPoint<Datum>>().x((_, index) => positions[index]!).y0(([bottom]) => yScale(bottom)).y1(([, top]) => yScale(top)).curve(shape)(layers[order]!)
          : area<Datum>().defined(defined).x((row) => xOf(row[x])).y0(yScale(Math.max(low!, 0))).y1((row) => yScale(numberOf(row[item.key])!)).curve(shape)(rows)
      }
      return (
        <g key={item.key}>
          {fillPath && <path d={fillPath} style={{ fill: item.color, fillOpacity: layers ? 0.55 : 0.18 }} />}
          {strokePath && <path d={strokePath} style={{ fill: "none", stroke: item.color, strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }} />}
          {dots && rows.map((row, index) => {
            const at = layers ? yScale(layers[order]![index]![1]) : yAt(row, item.key)
            return at === null ? null : <circle key={index} cx={positions[index]} cy={at} r={3} style={{ fill: item.color }} />
          })}
        </g>
      )
    })
  })()

  const hovered = hover === null ? null : rows[hover]
  const hoverX = hover === null ? 0 : positions[hover]!
  const tooltipLeft = left + hoverX + 14
  const flip = tooltipLeft + 170 > width
  const showLegend = legend ?? series.length > 1

  return (
    <div ref={ref} className={["ck-chart", className].filter(Boolean).join(" ")} style={style}>
      {showLegend && <Legend items={series} />}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={title}>
          <g transform={`translate(${left},${MARGIN.top})`}>
            <g className="ck-axis">
              {yTicks.map((tick) => (
                <g key={tick} transform={`translate(0,${yScale(tick)})`}>
                  <line className={tick === 0 ? "ck-zero-line" : "ck-grid-line"} x2={innerWidth} />
                  <text x={-8} dy="0.32em" textAnchor="end">{yFormat(tick)}</text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text key={tick.key} x={tick.at} y={innerHeight + 16} textAnchor="middle">{tick.label}</text>
              ))}
            </g>
            {hovered && kind === "bar" && <rect className="ck-hover-band" x={(band(String(hovered[x])) ?? 0) - band.step() * band.paddingInner() / 2} width={band.step()} height={innerHeight} />}
            <clipPath id={clip}><rect x={-14} y={-14} width={innerWidth + 28} height={innerHeight + 28} /></clipPath>
            <g clipPath={`url(#${CSS.escape(clip)})`}>
              {marks}
              {children?.(plot)}
            </g>
            {hovered && kind !== "bar" && (
              <g pointerEvents="none">
                <line className="ck-hover-line" x1={hoverX} x2={hoverX} y2={innerHeight} />
                {series.map((item, order) => {
                  const at = layers ? yScale(layers[order]![hover!]![1]) : yAt(hovered, item.key)
                  return at === null ? null : <circle key={item.key} cx={hoverX} cy={at} r={4.5} className="ck-hover-dot" style={{ fill: item.color }} />
                })}
              </g>
            )}
            <rect
              width={innerWidth} height={innerHeight} fill="transparent"
              onPointerMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                setHover(nearest(event.clientX - box.left))
              }}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>
      )}
      {hovered && (
        <div className="ck-tooltip" style={{ top: MARGIN.top + (showLegend ? 26 : 0), left: flip ? undefined : tooltipLeft, right: flip ? width - left - hoverX + 14 : undefined }}>
          <div className="ck-tooltip-title">{labelOf(hovered[x])}</div>
          {series.map((item) => (
            <div key={item.key} className="ck-tooltip-row">
              <span><span className="ck-swatch" style={{ background: item.color }} />{item.label}</span>
              <span>{formatValue(numberOf(hovered[item.key]) ?? hovered[item.key])}</span>
            </div>
          ))}
          {size && <div className="ck-tooltip-row"><span>{size}</span><span>{formatValue(hovered[size])}</span></div>}
        </div>
      )}
    </div>
  )
}

function xNumber(value: unknown, kind: XKind): number {
  return kind === "time" ? dateOf(value).getTime() : (numberOf(value) ?? 0)
}

export function Legend({ items }: { items: readonly { key: string; label: ReactNode; color: string }[] }) {
  return (
    <div className="ck-legend">
      {items.map((item) => <span key={item.key}><span className="ck-swatch" style={{ background: item.color }} />{item.label}</span>)}
    </div>
  )
}

export function LineChart(props: CartesianChartProps) {
  return <Cartesian kind="line" {...props} />
}

export function AreaChart(props: CartesianChartProps) {
  return <Cartesian kind="area" {...props} />
}

export function BarChart(props: CartesianChartProps) {
  return <Cartesian kind="bar" {...props} />
}

export function ScatterChart(props: CartesianChartProps) {
  return <Cartesian kind="scatter" {...props} />
}
