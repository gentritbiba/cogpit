import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { AreaChart, BarChart, LineChart, ScatterChart } from "../charts/cartesian"
import { PieChart } from "../charts/pie"
import { dateOf, resolveSeries, xKindOf } from "../charts/data"
import { Tex } from "../math"

// jsdom lays nothing out; charts draw once their box has a width.
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 }) })
afterAll(() => { delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth })
afterEach(cleanup)

const sales = [
  { month: "2026-03-01", revenue: 1800, cost: 1100 },
  { month: "2026-01-01", revenue: 1200, cost: 900 },
  { month: "2026-02-01", revenue: 1500, cost: null },
]
const channels = [{ channel: "Search", visits: 21000, signups: 2730 }, { channel: "Social", visits: 14200, signups: 1278 }]

/** The chart's hover surface: the last rect in its plot. */
const surface = (container: HTMLElement) => [...container.querySelectorAll("svg > g > rect")].at(-1)!

describe("chart data", () => {
  it("tells numbers, dates and categories apart", () => {
    expect(xKindOf([1, 2.5, null])).toBe("number")
    expect(xKindOf(["2026-01", "2026-02-03", new Date()])).toBe("time")
    expect(xKindOf(["Search", "2026-01"])).toBe("category")
  })

  it("reads a bare day as local midnight", () => {
    expect([dateOf("2026-03-01").getFullYear(), dateOf("2026-03-01").getMonth(), dateOf("2026-03-01").getHours()]).toEqual([2026, 2, 0])
    expect(dateOf("2026-03").getDate()).toBe(1)
  })

  it("names and colors series", () => {
    expect(resolveSeries(["a", { key: "b", label: "B", color: "red" }])).toEqual([
      { key: "a", label: "a", color: "var(--chart-1)" },
      { key: "b", label: "B", color: "red" },
    ])
    expect(resolveSeries("a", ["#111"])).toEqual([{ key: "a", label: "a", color: "#111" }])
  })
})

describe("cartesian charts", () => {
  it("draws a line per series in date order, with a legend and a tooltip", () => {
    const { container } = render(<LineChart data={sales} x="month" y={["revenue", { key: "cost", label: "Cost" }]} title="Sales" />)
    expect(screen.getByRole("img", { name: "Sales" })).toBeInTheDocument()
    expect(container.querySelector(".ck-legend")).toHaveTextContent("revenueCost")
    const [revenue] = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d")!)
    const xs = [...revenue!.matchAll(/[ML]([\d.]+),/g)].map((match) => Number(match[1]))
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    fireEvent.pointerMove(surface(container), { clientX: 0 })
    expect(container.querySelector(".ck-tooltip")).toHaveTextContent(/Jan 1, 2026.*revenue1,200.*Cost900/)
    fireEvent.pointerLeave(surface(container))
    expect(container.querySelector(".ck-tooltip")).toBeNull()
  })

  it("leaves a gap where a value is missing", () => {
    const { container } = render(<LineChart data={sales} x="month" y="cost" />)
    expect(container.querySelector("path")!.getAttribute("d")!.match(/M/g)).toHaveLength(2)
  })

  it("groups bars per category and stacks them on request", () => {
    const grouped = render(<BarChart data={channels} x="channel" y={["visits", "signups"]} />)
    expect(grouped.container.querySelectorAll("rect[rx]")).toHaveLength(4)
    expect(grouped.container.querySelector(".ck-axis")).toHaveTextContent(/SearchSocial/)
    grouped.unmount()
    const stacked = render(<BarChart data={channels} x="channel" y={["visits", "signups"]} stacked />)
    const bars = [...stacked.container.querySelectorAll("rect[rx]")]
    expect(new Set(bars.map((bar) => bar.getAttribute("x"))).size).toBe(2)
  })

  it("gives custom marks the plot's scales", () => {
    const { container } = render(
      <AreaChart data={channels} x="channel" y="visits">
        {({ x, y, width, height }) => <circle data-testid="mark" cx={x("Social")} cy={y(14200)} r={width > 0 && height > 0 ? 3 : 0} />}
      </AreaChart>,
    )
    const mark = screen.getByTestId("mark")
    expect(Number(mark.getAttribute("cx"))).toBeGreaterThan(0)
    expect(mark.getAttribute("r")).toBe("3")
    expect(mark.closest("g[clip-path]")).not.toBeNull()
    expect(container.querySelector("clipPath")).not.toBeNull()
  })

  it("sizes scatter points by a key", () => {
    const { container } = render(<ScatterChart data={[{ x: 1, y: 2, w: 1 }, { x: 2, y: 3, w: 100 }]} x="x" y="y" size="w" />)
    const radii = [...container.querySelectorAll("circle")].map((circle) => Number(circle.getAttribute("r")))
    expect(radii).toEqual([3, 14])
  })
})

describe("pie chart", () => {
  it("shows each slice's value and share, and the total in a donut", () => {
    const { container } = render(<PieChart data={channels} label="channel" value="visits" donut />)
    expect(container.querySelectorAll("path")).toHaveLength(2)
    expect(container.querySelector(".ck-pie-legend")).toHaveTextContent(/Search21,00060%.*Social14,20040%/)
    expect(container.querySelector(".ck-pie-total")).toHaveTextContent("35,200")
    fireEvent.pointerEnter(container.querySelectorAll("path")[1]!)
    expect(container.querySelector(".ck-pie-total")).toHaveTextContent("14,200")
  })
})

describe("Tex", () => {
  it("draws TeX as MathML, inline or as a block", () => {
    const { container } = render(<p><Tex>{"x^2"}</Tex><Tex block tex={"\\frac{1}{2}"} /></p>)
    expect(container.querySelectorAll("math")).toHaveLength(2)
    expect(container.querySelector("div.ck-tex-block math")).not.toBeNull()
    expect(container.querySelector(".katex-html")).toBeNull()
  })
})
