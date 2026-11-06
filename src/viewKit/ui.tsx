/**
 * `cogpit/ui`: the base components of a stored view. Each is a styled real
 * element that forwards `className`, `style` and the element's own props, so
 * a view can restyle any of them or drop to plain JSX at any point.
 */
import { useId, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ")

type Space = number | string
const space = (value: Space) => (typeof value === "number" ? `${value}px` : value)

/** Numbers read the way people write them; anything else as text. */
export function formatValue(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(value)
  return value === null || value === undefined ? "" : String(value)
}

interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  gap?: Space
}

export function Stack({ gap, className, style, ...rest }: BoxProps) {
  return <div className={cx("ck-stack", className)} style={gap === undefined ? style : { gap: space(gap), ...style }} {...rest} />
}

export function Row({ gap, align, justify, className, style, ...rest }: BoxProps & { align?: CSSProperties["alignItems"]; justify?: CSSProperties["justifyContent"] }) {
  return <div className={cx("ck-row", className)} style={{ gap: gap === undefined ? undefined : space(gap), alignItems: align, justifyContent: justify, ...style }} {...rest} />
}

/** A fixed number of columns, or as many of at least `min` pixels as fit. */
export function Grid({ columns, min = 160, gap, className, style, ...rest }: BoxProps & { columns?: number; min?: number }) {
  const template = columns ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`
  return <div className={cx("ck-grid", className)} style={{ gridTemplateColumns: template, gap: gap === undefined ? undefined : space(gap), ...style }} {...rest} />
}

export function Card({ title, actions, className, children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "title"> & { title?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx("ck-card", className)} {...rest}>
      {(title || actions) && <div className="ck-card-head"><div className="ck-card-title">{title}</div>{actions}</div>}
      {children}
    </div>
  )
}

export function Section({ title, description, className, children, ...rest }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title?: ReactNode; description?: ReactNode }) {
  return (
    <section className={cx("ck-section", className)} {...rest}>
      {title && <h3>{title}</h3>}
      {description && <p className="muted">{description}</p>}
      {children}
    </section>
  )
}

export function Heading({ level = 2, ...rest }: HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2 | 3 | 4 }) {
  const Tag = `h${level}` as const
  return <Tag {...rest} />
}

export function Text(props: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} />
}

export function Muted({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("muted", className)} {...rest} />
}

export function Code({ block, children, ...rest }: HTMLAttributes<HTMLElement> & { block?: boolean }) {
  return block ? <pre {...rest}><code>{children}</code></pre> : <code {...rest}>{children}</code>
}

type Tone = "default" | "success" | "warning" | "danger" | "muted"

export function Badge({ tone = "default", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cx("ck-badge", `ck-tone-${tone}`, className)} {...rest} />
}

function deltaTone(delta: ReactNode): Tone {
  if (typeof delta === "number" && delta > 0) return "success"
  if (typeof delta === "number" && delta < 0) return "danger"
  return "muted"
}

/** A headline number. A numeric `delta` shows its sign and reads green up, red down. */
export function Stat({ label, value, delta, hint, className, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & { label: ReactNode; value: ReactNode; delta?: ReactNode; hint?: ReactNode }) {
  return (
    <div className={cx("ck-stat", className)} {...rest}>
      <div className="ck-stat-label">{label}</div>
      <div className="ck-stat-value">{typeof value === "number" ? formatValue(value) : value}</div>
      {(delta !== undefined || hint) && (
        <div className="ck-stat-foot">
          {delta !== undefined && <span className={`ck-tone-${deltaTone(delta)}`}>{typeof delta === "number" && delta > 0 ? "+" : ""}{typeof delta === "number" ? formatValue(delta) : delta}</span>}
          {hint && <span className="muted">{hint}</span>}
        </div>
      )}
    </div>
  )
}

export function Progress({ value, max = 100, label, tone = "default", className, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & { value: number; max?: number; label?: ReactNode; tone?: Tone }) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div className={cx("ck-progress", className)} {...rest}>
      {label && <div className="ck-progress-label"><span>{label}</span><span className="muted">{Math.round(share * 100)}%</span></div>}
      <div className="ck-progress-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={cx("ck-progress-bar", `ck-fill-${tone}`)} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  )
}

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return <button type={type} className={cx("ck-button", `ck-button-${variant}`, size === "sm" && "ck-button-sm", className)} {...rest} />
}

function Field({ label, aside, id, children }: { label?: ReactNode; aside?: ReactNode; id: string; children: ReactNode }) {
  if (!label && !aside) return <>{children}</>
  return (
    <div className="ck-field">
      <div className="ck-field-head">
        {label && <label htmlFor={id}>{label}</label>}
        {aside !== undefined && <span className="ck-field-aside">{aside}</span>}
      </div>
      {children}
    </div>
  )
}

export function Slider({ label, value, min = 0, max = 100, step = 1, onChange, format = formatValue, className, style }: {
  label?: ReactNode; value: number; min?: number; max?: number; step?: number
  onChange: (value: number) => void; format?: (value: number) => ReactNode; className?: string; style?: CSSProperties
}) {
  const id = useId()
  return (
    <Field label={label} aside={label ? format(value) : undefined} id={id}>
      <input
        id={id} type="range" className={cx("ck-slider", className)} style={style}
        min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </Field>
  )
}

type Option<T extends string> = T | { value: T; label: ReactNode }
const optionValue = <T extends string>(option: Option<T>) => (typeof option === "string" ? option : option.value)
const optionLabel = <T extends string>(option: Option<T>) => (typeof option === "string" ? option : option.label)

export function Select<T extends string>({ label, value, options, onChange, className, style }: {
  label?: ReactNode; value: T; options: readonly Option<T>[]; onChange: (value: T) => void; className?: string; style?: CSSProperties
}) {
  const id = useId()
  return (
    <Field label={label} id={id}>
      <select id={id} className={cx("ck-select", className)} style={style} value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
        {options.map((option) => <option key={optionValue(option)} value={optionValue(option)}>{optionLabel(option)}</option>)}
      </select>
    </Field>
  )
}

export function Input({ label, value, onChange, className, style, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  label?: ReactNode; value: string; onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <Field label={label} id={id}>
      <input id={id} className={cx("ck-input", className)} style={style} value={value} onChange={(event) => onChange(event.currentTarget.value)} {...rest} />
    </Field>
  )
}

export function Toggle({ label, checked, onChange, className, style }: {
  label?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; className?: string; style?: CSSProperties
}) {
  return (
    <label className={cx("ck-toggle", className)} style={style}>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="ck-toggle-track" aria-hidden="true" />
      {label}
    </label>
  )
}

interface Tab { id: string; label: ReactNode; content: ReactNode }

/** Controlled with `value` and `onChange`, or left to keep its own selection. */
export function Tabs({ tabs, value, defaultValue, onChange, className, style }: {
  tabs: readonly Tab[]; value?: string; defaultValue?: string; onChange?: (id: string) => void; className?: string; style?: CSSProperties
}) {
  const [own, setOwn] = useState(defaultValue ?? tabs[0]?.id)
  const active = value ?? own
  const select = (id: string) => { setOwn(id); onChange?.(id) }
  return (
    <div className={cx("ck-tabs", className)} style={style}>
      <div className="ck-tab-list" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={tab.id === active} className="ck-tab" onClick={() => select(tab.id)}>{tab.label}</button>
        ))}
      </div>
      <div role="tabpanel">{tabs.find((tab) => tab.id === active)?.content}</div>
    </div>
  )
}

type DataRow = Record<string, unknown>
interface Column { key: string; label?: ReactNode; align?: "left" | "right" | "center"; format?: (value: unknown, row: DataRow) => ReactNode }

/** Rows of data under named columns, or any table markup as children. */
export function Table({ columns, rows, className, children, ...rest }: HTMLAttributes<HTMLTableElement> & { columns?: readonly (string | Column)[]; rows?: readonly DataRow[] }) {
  const first = rows?.[0] ?? {}
  const resolved = (columns ?? Object.keys(first)).map((column) => (typeof column === "string" ? { key: column } : column))
    .map((column) => ({ ...column, align: column.align ?? (typeof first[column.key] === "number" ? "right" as const : undefined) }))
  return (
    <div className="ck-table-wrap">
      <table className={cx("ck-table", className)} {...rest}>
        {rows ? (
          <>
            <thead><tr>{resolved.map((column) => <th key={column.key} style={{ textAlign: column.align }}>{column.label ?? column.key}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {resolved.map((column) => (
                    <td key={column.key} style={{ textAlign: column.align }}>{column.format ? column.format(row[column.key], row) : formatValue(row[column.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </>
        ) : children}
      </table>
    </div>
  )
}
