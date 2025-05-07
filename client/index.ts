import { Context } from '@koishijs/client'
import {} from '@koishijs/plugin-console'

import { initECharts } from './echarts'
import Page from './page.vue'

export default (ctx: Context) => {
  initECharts()

  ctx.page({
    name: '消息数据库',
    path: '/message-db',
    fields: [ 'messageDb' ],
    component: Page,
  })
}