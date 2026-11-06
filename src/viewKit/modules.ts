/**
 * The kit modules a stored view can import, built into
 * `generated/view-kit/index.json` by `scripts/build-view-kit.ts`. A module
 * lists the import specifiers it provides; the host includes it only in views
 * that import one of them, or in every view when `always` is set. A module
 * may import what `base` provides, which every view has; it bundles anything
 * else it uses. `doc` is the module's entry in the cogpit skill's views
 * reference, written there by `bun run sync-cogpit-skill`.
 *
 * Adding a module is one entry here plus its source.
 */
export interface ViewKitModuleSpec {
  id: string
  /** Exports `modules`, mapping each provided specifier to its exports. */
  entry: string
  css?: string
  provides: readonly string[]
  always?: boolean
  doc: string
}

export const VIEW_KIT_MODULES: readonly ViewKitModuleSpec[] = [
  {
    id: "base",
    entry: "src/viewKit/base.ts",
    css: "src/viewKit/kit.css",
    provides: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "cogpit/ui", "cogpit/runtime"],
    always: true,
    doc: `**\`react\`** (\`useState\`, \`useEffect\`, \`useRef\`, …; Preact underneath)
and **\`cogpit/ui\`**, light components that look native in both themes. In
every view:

- layout: \`Stack\` (\`gap\`), \`Row\` (\`gap\`, \`align\`, \`justify\`), \`Grid\`
  (\`columns\`, or \`min\` width per column), \`Card\` (\`title\`, \`actions\`),
  \`Section\` (\`title\`, \`description\`)
- text: \`Heading\` (\`level\`), \`Text\`, \`Muted\`, \`Code\` (\`block\`)
- data: \`Stat\` (\`label\`, \`value\`, \`delta\`, \`hint\`), \`Table\` (\`rows\`,
  optional \`columns\` of names or \`{ key, label, align, format }\`; or table
  markup as children), \`Badge\` (\`tone\`: default, success, warning, danger,
  muted), \`Progress\` (\`value\`, \`max\`, \`label\`, \`tone\`)
- input: \`Button\` (\`variant\`: primary, secondary, ghost, danger; \`size\`),
  \`Slider\` (\`label\`, \`value\`, \`min\`, \`max\`, \`step\`, \`onChange(number)\`,
  \`format\`), \`Select\` (\`options\` as strings or \`{ value, label }\`), \`Toggle\`
  (\`checked\`, \`onChange(boolean)\`), \`Input\` (\`onChange(string)\`), \`Tabs\`
  (\`tabs\` of \`{ id, label, content }\`)
- helpers: \`useTheme()\` (\`mode\`, \`color\`), \`themeColor("--chart-1")\`,
  \`useAnimationFrame((ms) => …)\`, \`ask(text)\`, \`formatValue(value)\`

Every component takes \`className\` and \`style\` and renders a real element.`,
  },
  {
    id: "charts",
    entry: "src/viewKit/charts/index.ts",
    css: "src/viewKit/charts/charts.css",
    provides: ["cogpit/charts"],
    doc: `**\`cogpit/charts\`**: themed SVG charts with axes, a legend for several
series and a hover tooltip.

- \`LineChart\`, \`AreaChart\`, \`BarChart\`, \`ScatterChart\` take \`data\` (rows),
  \`x\` (the key of numbers, dates as \`Date\` or ISO strings, or categories) and
  \`y\` (a key, several keys, or \`{ key, label, color }\`). Options: \`height\`
  (240), \`stacked\` (area, bar), \`curve\` (linear, smooth, step), \`dots\`,
  \`size\` (scatter: a key sizing points), \`yDomain\`, \`xFormat\`, \`yFormat\`,
  \`colors\`, \`legend\`, \`title\`.
- For your own marks, pass a function as children: it gets
  \`{ x(value), y(number), width, height, bandwidth, data }\` in plot
  coordinates, e.g. \`{({ x, y }) => <line x1={x("Mar")} x2={x("Mar")} y2={y(0)} />}\`.
- \`PieChart\` takes \`data\`, \`label\` and \`value\` keys; \`donut\` shows the
  total in the middle.`,
  },
  {
    id: "math",
    entry: "src/viewKit/math.tsx",
    provides: ["cogpit/math", "katex"],
    doc: `**\`cogpit/math\`**: \`<Tex>{"\\\\frac{a}{b}"}</Tex>\` inline, or with \`block\` on
its own line. **\`katex\`** is KaTeX 0.19 (\`render\`, \`renderToString\`), drawn as
the browser's MathML, so it needs no stylesheet or fonts.`,
  },
  {
    id: "scene",
    entry: "src/viewKit/scene.tsx",
    css: "src/viewKit/scene.css",
    provides: ["cogpit/scene", "three", "three/addons/controls/OrbitControls.js", "three/examples/jsm/controls/OrbitControls.js"],
    doc: `**\`cogpit/scene\`**: \`<Scene3D setup={…} />\`, a Three.js canvas that sizes
itself, orbits with the mouse, pauses off screen and cleans up. \`setup\` runs
once with \`{ THREE, scene, camera, renderer, controls, color(name),
onTheme(listener) }\`; add objects and return a per-frame step
\`(timeMs, deltaMs) => …\`, or \`{ frame, cleanup }\`. Options: \`height\` (320),
\`camera\` position, \`controls\`, \`lights\`. **\`three\`** is Three.js r180, and
\`three/addons/controls/OrbitControls.js\` its orbit controls.`,
  },
  {
    id: "d3",
    entry: "src/viewKit/d3.ts",
    provides: ["d3"],
    doc: `**\`d3\`**: all of D3 7, for drawing beyond the charts. Select a ref'd
element in \`useEffect\`, and set colors with \`.style("fill", "var(--chart-1)")\`
(attributes do not read CSS variables).`,
  },
]
