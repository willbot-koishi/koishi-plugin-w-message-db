import { use } from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { SVGRenderer } from 'echarts/renderers'

export const initECharts = () => {
  use([ SVGRenderer, PieChart ])
}