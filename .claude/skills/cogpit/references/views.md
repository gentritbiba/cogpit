# Interactive views

Cogpit runs a `cogpit-view` block in your reply as a live page: your HTML, CSS
and JavaScript, drawn as a card inside the chat. Reach for one whenever seeing
or touching an idea explains it better than prose: a slider that reshapes a
curve, an algorithm the user can step through, a simulation, a chart of data
you computed, a 3D shape to turn, a calculator, a quiz. Keep writing around
it: the view shows, your sentences say what it means.

````markdown
```cogpit-view
<title>Compound growth</title>
<label>Rate <input id="rate" type="range" min="0" max="15" step="0.5" value="5"> <b id="shown"></b></label>
<svg id="chart" width="100%" height="200"></svg>
<p class="muted">After 30 years: <b id="total"></b></p>
<script src="cogpit:lib/d3"></script>
<script>
  const svg = d3.select("#chart"), width = svg.node().clientWidth, height = 200
  const x = d3.scaleLinear([0, 30], [30, width - 10])
  const draw = () => {
    const rate = +document.querySelector("#rate").value / 100
    const points = d3.range(31).map((year) => [year, 1000 * (1 + rate) ** year])
    const y = d3.scaleLinear([0, d3.max(points, (p) => p[1])], [height - 20, 10])
    svg.selectAll("*").remove()
    svg.append("path").attr("d", d3.line(([a]) => x(a), ([, b]) => y(b))(points))
      .style("fill", "none").style("stroke", "var(--chart-1)").style("stroke-width", 2)
    svg.append("g").attr("transform", `translate(0,${height - 20})`).call(d3.axisBottom(x))
    document.querySelector("#shown").textContent = `${(rate * 100).toFixed(1)}%`
    document.querySelector("#total").textContent = d3.format("$,.0f")(points[30][1])
  }
  document.querySelector("#rate").addEventListener("input", draw)
  draw()
</script>
```
````

## What the page gets

- Your markup becomes the page body: any elements, `<style>` and `<script>`,
  including `<script type="module">`. `<title>` names the card.
- Cogpit's theme as CSS variables: `--foreground`, `--card`, `--muted`,
  `--muted-foreground`, `--border`, `--primary`, `--primary-foreground`,
  `--accent`, `--destructive`, `--success`, `--warning`, `--chart-1` to
  `--chart-5`, `--radius`, `--font-sans` and `--font-mono`. `<html>` has the
  `dark` class in dark mode. Text, headings, buttons, inputs, sliders, tables
  and code already look native, so style only what is particular to the view.
  `<button class="primary">` is the filled button and `.muted` the secondary
  text color.
- `cogpit.color("--chart-2")` returns a theme color as hex for canvas, D3 or
  Three.js. `cogpit.onTheme(redraw)` calls `redraw` when the user switches
  between light and dark.
- `cogpit.ask(text)` puts `text` in the user's composer to send to you, for a
  button such as "Explain this step" or "Use these settings". It never sends on
  its own, and works only from a click inside the view.
- The card grows to fit the page, up to 1600px. The user can expand it to
  nearly the full window, reload it, or read its source.

## Libraries

The page has no network: CDN scripts, `fetch` and remote images do not load.
Put the data the view needs in the block. These libraries are built in:

| Library | Load | Then |
| --- | --- | --- |
| D3 7 | `<script src="cogpit:lib/d3"></script>` | global `d3` |
| KaTeX 0.16 | `<script src="cogpit:lib/katex"></script>` | `katex.render(tex, element)`; `renderMathInElement(element)` typesets `\(…\)`, `\[…\]` and `$$…$$`. It draws native MathML: no stylesheet or fonts to add |
| Three.js r180 | `import * as THREE from "three"` in a module script | `import { OrbitControls } from "three/addons/controls/OrbitControls.js"` |

Anything else, write directly: SVG, canvas, WebGL, CSS animation and Web
Workers from blob URLs all work.

## Getting it right

- Size by content. Do not set `height: 100%` or `100vh` on `html`, `body` or a
  wrapper; give canvases, SVG and Three.js renderers an explicit height.
- The width is laid out when your script runs, and changes when the user
  resizes the window: redraw on `resize` if the drawing depends on it. Expanding
  opens a fresh copy of the view at the larger size.
- Animate with `requestAnimationFrame`; it slows or stops while the card is off
  screen. State lasts while the card stays open; reloading, expanding or
  reopening the session starts the view from its initial state.
- Chat Markdown does not render TeX. Typeset formulas inside a view, or write
  them in prose with Unicode.
- In D3, set colors with `.style("fill", "var(--chart-1)")`, not `.attr`:
  attributes do not read CSS variables. Use `cogpit.color` for scales.
- Links open in the user's browser when they click them.
- A script error shows under the card with a button the user can press to ask
  you to fix it.
- One idea per view, kept compact: usually well under 200 lines, and one or two
  views in a reply. Build on an earlier view by writing a new block, not by
  asking the user to edit one.
- Not every Cogpit client runs views, so the prose around one must still make
  sense without it.
