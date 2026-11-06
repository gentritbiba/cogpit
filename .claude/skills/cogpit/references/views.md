# Interactive views

Cogpit can show a live page inside your reply: sliders that reshape a curve,
an algorithm the user steps through, a simulation, a chart of numbers you
computed, a dashboard, a formula, a 3D shape to turn, a quiz. Reach for one
whenever seeing or touching an idea explains it better than prose. Keep
writing around it: the view shows, your sentences say what it means.

A view is a small React app you keep as files on this machine. Cogpit builds
it into one finished page, and your reply names the version to show. To change
a view after the user sees it, edit its files and build again.

## Make one

```bash
cogpit-session view new sales-funnel --title "Sales funnel"   # prints the view's folder
# write App.tsx (and any other files) in that folder with your usual tools
cogpit-session view build sales-funnel                        # prints problems, or the reply block
```

`build` checks every file and import first. A problem comes back as
`App.tsx:12:5: …`; fix it and build again. A good build stores the next
version and prints the block to put in your reply:

````markdown
```cogpit-view
sales-funnel@1
```
````

`App.tsx` default-exports the component to show. Kit components and your own
mix freely:

```tsx
import { useState } from "react"
import { Card, Grid, Slider, Stack, Stat } from "cogpit/ui"
import { BarChart } from "cogpit/charts"
import data from "./data.json"

function Target({ goal }: { goal: number }) {
  return <p className="muted">Goal: {goal.toLocaleString()} paid users</p>
}

export default function App() {
  const [rate, setRate] = useState(12)
  const rows = data.channels.map((c) => ({ ...c, paid: Math.round(c.visits * (rate / 100) * 0.13) }))
  const paid = rows.reduce((sum, row) => sum + row.paid, 0)
  return (
    <Stack>
      <Grid columns={2}>
        <Stat label="Signup rate" value={`${rate}%`} />
        <Stat label="Paid" value={paid} delta={paid - data.paidLastWeek} hint="vs last week" />
      </Grid>
      <Slider label="Signup rate" min={1} max={40} value={rate} onChange={setRate} format={(v) => `${v}%`} />
      <Card title="Paid by channel">
        <BarChart data={rows} x="channel" y="paid" height={200} />
      </Card>
      <Target goal={1000} />
    </Stack>
  )
}
```

## Updating a view

Edit the files in the view's folder and run `view build` again, then put the new
block (`sales-funnel@2`) in your reply. Earlier replies keep showing the
version they named and offer the newer one. `cogpit-session view list` shows
this project's views, and `view show ID` shows a view's folder and versions.
The user also finds every view in the sidebar's Views list, where they can
open it in the Views panel beside the chat, pick any version, pin, rename or
delete it.

A view belongs to the session that made it: whoever may see that session may
see the view, including a guest of a shared session, and whoever may work in
it may rebuild it.

## What a view can use

The page has no network: `fetch`, CDN scripts and npm packages do not load.
Put the data in the view's files. Your own files are `.tsx`, `.ts`, `.jsx`,
`.js`, `.css` and `.json`, in folders if you like, imported by relative path
(`./components/Funnel`, `./data.json`, `./styles.css`); up to 40 files.

Beyond those, a view imports from the kit. A module that is not imported is
not sent, so import only what the view uses:

<!-- view-kit:start -->
<!-- Generated from src/viewKit/modules.ts by scripts/sync-cogpit-skill.ts. -->

**`react`** (`useState`, `useEffect`, `useRef`, …; Preact underneath)
and **`cogpit/ui`**, light components that look native in both themes. In
every view:

- layout: `Stack` (`gap`), `Row` (`gap`, `align`, `justify`), `Grid`
  (`columns`, or `min` width per column), `Card` (`title`, `actions`),
  `Section` (`title`, `description`)
- text: `Heading` (`level`), `Text`, `Muted`, `Code` (`block`)
- data: `Stat` (`label`, `value`, `delta`, `hint`), `Table` (`rows`,
  optional `columns` of names or `{ key, label, align, format }`; or table
  markup as children), `Badge` (`tone`: default, success, warning, danger,
  muted), `Progress` (`value`, `max`, `label`, `tone`)
- input: `Button` (`variant`: primary, secondary, ghost, danger; `size`),
  `Slider` (`label`, `value`, `min`, `max`, `step`, `onChange(number)`,
  `format`), `Select` (`options` as strings or `{ value, label }`), `Toggle`
  (`checked`, `onChange(boolean)`), `Input` (`onChange(string)`), `Tabs`
  (`tabs` of `{ id, label, content }`)
- helpers: `useTheme()` (`mode`, `color`), `themeColor("--chart-1")`,
  `useAnimationFrame((ms) => …)`, `ask(text)`, `formatValue(value)`

Every component takes `className` and `style` and renders a real element.

**`cogpit/charts`**: themed SVG charts with axes, a legend for several
series and a hover tooltip.

- `LineChart`, `AreaChart`, `BarChart`, `ScatterChart` take `data` (rows),
  `x` (the key of numbers, dates as `Date` or ISO strings, or categories) and
  `y` (a key, several keys, or `{ key, label, color }`). Options: `height`
  (240), `stacked` (area, bar), `curve` (linear, smooth, step), `dots`,
  `size` (scatter: a key sizing points), `yDomain`, `xFormat`, `yFormat`,
  `colors`, `legend`, `title`.
- For your own marks, pass a function as children: it gets
  `{ x(value), y(number), width, height, bandwidth, data }` in plot
  coordinates, e.g. `{({ x, y }) => <line x1={x("Mar")} x2={x("Mar")} y2={y(0)} />}`.
- `PieChart` takes `data`, `label` and `value` keys; `donut` shows the
  total in the middle.

**`cogpit/math`**: `<Tex>{"\\frac{a}{b}"}</Tex>` inline, or with `block` on
its own line. **`katex`** is KaTeX 0.19 (`render`, `renderToString`), drawn as
the browser's MathML, so it needs no stylesheet or fonts.

**`cogpit/scene`**: `<Scene3D setup={…} />`, a Three.js canvas that sizes
itself, orbits with the mouse, pauses off screen and cleans up. `setup` runs
once with `{ THREE, scene, camera, renderer, controls, color(name),
onTheme(listener) }`; add objects and return a per-frame step
`(timeMs, deltaMs) => …`, or `{ frame, cleanup }`. Options: `height` (320),
`camera` position, `controls`, `lights`. **`three`** is Three.js r180, and
`three/addons/controls/OrbitControls.js` its orbit controls.

**`d3`**: all of D3 7, for drawing beyond the charts. Select a ref'd
element in `useEffect`, and set colors with `.style("fill", "var(--chart-1)")`
(attributes do not read CSS variables).

<!-- view-kit:end -->

The kit is there to be quick, not to limit you. When nothing in it fits, write
the component yourself in the view's files, with SVG, canvas, WebGL, CSS
animation or anything else the browser draws, and mix it with kit components.

## Theme and the user

- Plain HTML already looks native. Theme colors are CSS variables:
  `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`,
  `--primary`, `--primary-foreground`, `--accent`, `--destructive`,
  `--success`, `--warning`, `--chart-1` to `--chart-5`, `--radius`,
  `--font-sans` and `--font-mono`. `<html>` has the `dark` class in dark mode.
  Use `themeColor` where a CSS variable cannot go, such as canvas; the view
  re-renders when the user switches between light and dark.
- `ask(text)` puts `text` in the user's composer to send to you, for a button
  such as "Explain this step". It never sends on its own and works only from a
  click inside the view.
- Links open in the user's browser when they click them.
- A runtime error shows under the card with its file and line, and a button
  the user can press to send it to you.

## Getting it right

- Size by content: give canvases and SVG an explicit height, never
  `height: 100%` or `100vh` on the page. The card grows to fit, up to 1600px,
  and the user can expand it.
- Redraw on `resize` if your own drawing depends on the width; the charts do.
- Animate with `useAnimationFrame` or `requestAnimationFrame`.
- State lasts while the card stays open. Reloading or reopening starts over.
- One idea per view, kept compact, and one or two views in a reply.
- Not every Cogpit client runs views, so the prose around one must still make
  sense without it.

If you are not running in a Cogpit session, so `cogpit-session view` cannot
reach one, write the page's HTML, CSS and JavaScript straight into a
`cogpit-view` block instead. It runs the same way, with
`<script src="cogpit:lib/d3"></script>`, `<script src="cogpit:lib/katex"></script>`
and `import … from "three"` in a module script available, but it cannot be
updated.
