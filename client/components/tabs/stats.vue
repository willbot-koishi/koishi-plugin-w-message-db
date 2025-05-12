<script setup lang="ts">
import { send } from '@koishijs/client'

import { MdbStats, MdbRemoteError, MdbChart, GuildQuery } from '../../../src/types'
import { formatSize } from '../../../shared/utils'

import { ref, Ref, Reactive, reactive, onMounted } from 'vue'

import WChart from '../chart.vue'
import SelectGuild from '../select-guild.vue'
import CatchError from '../catch-error.vue'

const stats = ref<MdbStats | MdbRemoteError>(null)
const statsGuildsChart: Ref<MdbChart | MdbRemoteError> = ref(null)
const statsMemberCharts: Reactive<Record<string, MdbChart | MdbRemoteError>> = reactive({})
const statsTimeCharts: Reactive<Record<string, MdbChart | MdbRemoteError>> = reactive({})

const statsMemberChartGid: Ref<string> = ref(null)
const statsTimeChartGid: Ref<string> = ref('global')

onMounted(async () => {
  [
    stats.value,
    statsGuildsChart.value,
    statsTimeCharts.global
  ] = await Promise.all([
    send('message-db/stats'),
    send('message-db/statsGuildsChart', {}),
    send('message-db/statsTimeChart', {}),
  ])
})

const loadStatsMembersChart = async () => {
  if (! statsMemberChartGid.value) return
  const [ platform, guildId ] = statsMemberChartGid.value.split(':')
  const chart = await send('message-db/statsMembersChart', { guildQuery: { platform, guildId } })
  statsMemberCharts[statsMemberChartGid.value] = chart
}

const loadStatsTimeChart = async () => {
  const gid = statsTimeChartGid.value
  let guildQuery: GuildQuery
  if (gid !== 'global') {
    const [ platform, guildId ] = gid.split(':')
    guildQuery = { platform, guildId }
  }
  const chart = await send('message-db/statsTimeChart', { guildQuery })
  statsTimeCharts[statsTimeChartGid.value] = chart
}
</script>

<template>
  <k-content>
  <div class="tab-stats">
    <k-card title="概览">
      <catch-error v-if="stats" :data="stats" #="{ data: stats }">
        总消息数：{{ stats.messageCount }}<br />
        总群组数：{{ stats.guildCount }}<br />
        追踪的群组数：{{ stats.trackedGuildCount }}<br />
        数据库大小：{{ formatSize(stats.tableSize) }}<br />
      </catch-error>
    </k-card>

    <w-chart
      default-title="时段消息数量"
      width="37.5rem"
      height="16.5rem"
      :chart="statsTimeCharts[statsTimeChartGid]"
    >
      <div class="group">
        <select-guild v-model="statsTimeChartGid" :with-global="true" />
        <k-button @click="loadStatsTimeChart">加载</k-button>
      </div>
    </w-chart>

    <w-chart
      default-title="群组消息数量"
      :chart="statsGuildsChart"
      width="37.5rem"
      height="28.125rem"
    />

    <w-chart
      default-title="成员消息数量"
      width="37.5rem"
      height="28.125rem"
      :chart="statsMemberCharts[statsMemberChartGid]"
    >
      <div class="group">
        <select-guild v-model="statsMemberChartGid" />
        <k-button @click="loadStatsMembersChart">加载</k-button>
      </div>
    </w-chart>
  </div>
  </k-content>
</template>

<style scoped>
.tab-stats {
  display: grid;
  margin: 2rem;
  gap: 2rem;
  grid-template-columns: repeat(auto-fit, minmax(38rem, 1fr));
}
</style>