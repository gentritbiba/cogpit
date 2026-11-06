import { useState, type CSSProperties } from "react"
import { arc, pie, type PieArcDatum } from "d3-shape"
import { formatValue } from "../ui"
import { chartColor, numberOf, type Datum } from "./data"

export interface PieChartProps {
  data: readonly Datum[]
  /** The key naming each slice. */
  label: string
  /** The key holding each slice's size. */
  value: string
  height?: number
  colors?: readonly string[]
  /** A ring with the total in the middle. */
  donut?: boolean
  format?: (value: number) => string
  title?: string
  className?: string
  style?: CSSProperties
}

/** Slices in data order, with a legend showing each value and share; hovering either highlights both. */
export function PieChart({ data, label, value, height = 220, colors, donut = false, format = formatValue, title, className, style }: PieChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const slices = pie<Datum>().value((row) => Math.max(0, numberOf(row[value]) ?? 0)).sort(null)([...data])
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const radius = height / 2 - 6
  const shape = (grow: number) => arc<PieArcDatum<Datum>>().innerRadius(donut ? radius * 0.62 : 0).outerRadius(radius - 4 + grow).padAngle(0.012).cornerRadius(3)
  return (
    <div className={["ck-chart", "ck-pie", className].filter(Boolean).join(" ")} style={style}>
      <svg width={height} height={height} viewBox={`${-height / 2} ${-height / 2} ${height} ${height}`} role="img" aria-label={title}>
        {slices.map((slice, index) => (
          <path
            key={index} d={shape(hover === index ? 4 : 0)(slice) ?? ""} style={{ fill: chartColor(index, colors), opacity: hover === null || hover === index ? 1 : 0.55 }}
            onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}
          />
        ))}
        {donut && (
          <text textAnchor="middle" dy="0.35em" className="ck-pie-total">
            {format(hover === null ? total : slices[hover]!.value)}
          </text>
        )}
      </svg>
      <div className="ck-pie-legend">
        {slices.map((slice, index) => (
          <div key={index} className="ck-pie-row" data-active={hover === index || undefined} onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}>
            <span><span className="ck-swatch" style={{ background: chartColor(index, colors) }} />{formatValue(slice.data[label])}</span>
            <span className="ck-pie-value">{format(slice.value)}</span>
            <span className="muted">{total > 0 ? `${Math.round((slice.value / total) * 100)}%` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
