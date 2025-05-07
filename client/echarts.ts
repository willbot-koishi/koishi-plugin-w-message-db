import { use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { GridComponent, TitleComponent, VisualMapComponent } from 'echarts/components'
import { HeatmapChart, PieChart } from 'echarts/charts'

export const initECharts = () => {
  use([
    SVGRenderer,
    GridComponent, VisualMapComponent, TitleComponent,
    PieChart, HeatmapChart,
  ])
}