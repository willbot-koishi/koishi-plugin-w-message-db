<script setup lang="ts">
import { onMounted, reactive, Reactive, Ref, ref } from 'vue'

import { send } from '@koishijs/client'
import type { MdbStats, MdbChart } from '../src/types'
import { formatSize } from '../shared/utils'
import WChart from './chart.vue'
import SelectGuild from './select-guild.vue'

const stats = ref<MdbStats>(null)
const statsGuildsChart: Ref<MdbChart> = ref(null)
const statsMemberCharts: Reactive<Record<string, MdbChart>> = reactive({})
const statsTimeCharts: Reactive<Record<string, MdbChart>> = reactive({})

const statsMemberChartGid: Ref<string> = ref(null)
const statsTimeChartGid: Ref<string> = ref('global')

onMounted(async () => {
  stats.value = await send('message-db/stats')
  statsGuildsChart.value = await send('message-db/stats/guilds/chart', [ 'zh-CN' ])
  statsTimeCharts.global = await send('message-db/stats/time/chart', [ 'zh-CN' ], {})
})

const loadStatsMembersChart = async () => {
  if (! statsMemberChartGid.value) return
  const [ platform, guildId ] = statsMemberChartGid.value.split(':')
  const chart = await send('message-db/stats/members/chart', [ 'zh-CN' ], { guildQuery: { platform, guildId } })
  statsMemberCharts[statsMemberChartGid.value] = chart
}

const loadStatsTimeChart = async () => {
  const gid = statsTimeChartGid.value
  let guildQuery
  if (gid !== 'global') {
    const [ platform, guildId ] = gid.split(':')
    guildQuery = { platform, guildId }
  }
  const chart = await send('message-db/stats/time/chart', [ 'zh-CN' ], { guildQuery })
  statsTimeCharts[statsTimeChartGid.value] = chart
}
</script>

<template>
  <k-layout class="page">
    <template #header>
      消息数据库
    </template>
    <k-content #default>
      <div class="cards">
        <k-card title="概览">
          <template v-if="stats">
            总消息数：{{ stats.messageCount }}<br />
            总群组数：{{ stats.guildCount }}<br />
            追踪的群组数：{{ stats.trackedGuildCount }}<br />
            数据库大小：{{ formatSize(stats.tableSize) }}<br />
          </template>
        </k-card>

        <w-chart
          default-title="时段消息数量"
          :chart="statsTimeCharts[statsTimeChartGid]"
          :width="(24 * 30 + 100) * .8"
          :height="(7 * 30 + 120) * .8"
        >
          <div class="group">
            <select-guild v-model="statsTimeChartGid" :with-global="true" />
            <k-button @click="loadStatsTimeChart">加载</k-button>
          </div>
        </w-chart>

        <w-chart
          default-title="群组消息数量"
          :chart="statsGuildsChart"
          :width="600"
          :height="450"
        />

        <w-chart
          default-title="成员消息数量"
          :chart="statsMemberCharts[statsMemberChartGid]"
          :width="600"
          :height="450"
        >
          <div class="group">
            <select-guild v-model="statsMemberChartGid" />
            <k-button @click="loadStatsMembersChart">加载</k-button>
          </div>
        </w-chart>
      </div>
    </k-content>
  </k-layout>
</template>

<style scoped>
.cards {
  display: grid;
  margin: 2rem;
  gap: 2rem;
  grid-template-columns: repeat(auto-fit, minmax(640px, 1fr));
}

.group {
  display: flex;
  gap: 1rem;
}

.page :deep(.k-content) {
  max-width: unset;
  width: 100%;
}

.page :deep(.k-button) {
  white-space: nowrap;
}
</style>