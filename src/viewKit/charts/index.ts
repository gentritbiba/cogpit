/** The `cogpit/charts` kit module: themed SVG charts on d3 scales, included only in views that import it. */
import { AreaChart, BarChart, Legend, LineChart, ScatterChart } from "./cartesian"
import { PieChart } from "./pie"

export const modules = {
  "cogpit/charts": { LineChart, AreaChart, BarChart, ScatterChart, PieChart, Legend },
}
