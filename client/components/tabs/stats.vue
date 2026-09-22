<script setup lang="ts">
import { send } from '@koishijs/client'

import { MdbStats, MdbRemoteError, MdbChart, GuildQuery } from '../../../src/types'
import { formatSize } from '../../../shared/utils'
import { normalizeRemoteError } from '../../utils/remote-error'

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
const statsLoading = ref(true)
const statsGuildsChartLoading = ref(true)
const statsMemberChartLoading = ref(false)
const statsTimeChartLoading = ref(true)

const loadStats = async () => {
  statsLoading.value = true
  try {
    stats.value = await send('message-db/stats')
  }
  catch (error) {
    stats.value = normalizeRemoteError(error)
  }
  finally {
    statsLoading.value = false
  }
}

const loadStatsGuildsChart = async () => {
  statsGuildsChartLoading.value = true
  try {
    statsGuildsChart.value = await send('message-db/statsGuildsChart', {})
  }
  catch (error) {
    statsGuildsChart.value = normalizeRemoteError(error)
  }
  finally {
    statsGuildsChartLoading.value = false
  }
}

onMounted(() => {
  void loadStats()
  void loadStatsGuildsChart()
  void fetchStatsTimeChart(statsTimeChartGid.value)
})

const loadStatsMembersChart = async () => {
  const gid = statsMemberChartGid.value
  if (! gid || statsMemberChartLoading.value) return
  statsMemberChartLoading.value = true
  const [ platform, guildId ] = gid.split(':')
  try {
    statsMemberCharts[gid] = await send('message-db/statsMembersChart', {
      guildQuery: { platform, guildId },
    })
  }
  catch (error) {
    statsMemberCharts[gid] = normalizeRemoteError(error)
  }
  finally {
    statsMemberChartLoading.value = false
  }
}

const fetchStatsTimeChart = async (gid: string) => {
  statsTimeChartLoading.value = true
  let guildQuery: GuildQuery
  if (gid !== 'global') {
    const [ platform, guildId ] = gid.split(':')
    guildQuery = { platform, guildId }
  }
  try {
    statsTimeCharts[gid] = await send('message-db/statsTimeChart', { guildQuery })
  }
  catch (error) {
    statsTimeCharts[gid] = normalizeRemoteError(error)
  }
  finally {
    statsTimeChartLoading.value = false
  }
}

const loadStatsTimeChart = () => {
  if (statsTimeChartLoading.value) return
  void fetchStatsTimeChart(statsTimeChartGid.value)
}
</script>

<template>
  <k-content>
  <div class="tab-stats">
    <k-card title="概览">
      <el-skeleton v-if="statsLoading" :rows="4" animated />
      <catch-error v-else-if="stats" :data="stats" #="{ data: stats }">
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
      :loading="statsTimeChartLoading"
    >
      <div class="group">
        <select-guild
          v-model="statsTimeChartGid"
          :with-global="true"
          :disabled="statsTimeChartLoading"
        />
        <el-button
          :loading="statsTimeChartLoading"
          @click="loadStatsTimeChart"
        >加载</el-button>
      </div>
    </w-chart>

    <w-chart
      default-title="群组消息数量"
      :chart="statsGuildsChart"
      :loading="statsGuildsChartLoading"
      width="37.5rem"
      height="28.125rem"
    />

    <w-chart
      default-title="成员消息数量"
      width="37.5rem"
      height="28.125rem"
      :chart="statsMemberCharts[statsMemberChartGid]"
      :loading="statsMemberChartLoading"
    >
      <div class="group">
        <select-guild
          v-model="statsMemberChartGid"
          :disabled="statsMemberChartLoading"
        />
        <el-button
          :disabled="! statsMemberChartGid"
          :loading="statsMemberChartLoading"
          @click="loadStatsMembersChart"
        >加载</el-button>
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
