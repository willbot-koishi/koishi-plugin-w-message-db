<script setup lang="ts">
import { onMounted, reactive, Reactive, Ref, ref } from 'vue'

import { send, store } from '@koishijs/client'
import type { MessageDbStats, MessageDbChart, MessageDbProvider } from '../src/types'
import { formatSize } from '../shared/utils'
import Chart from './chart.vue'

const stats = ref<MessageDbStats>(null)
const statsGuildsChart: Ref<MessageDbChart> = ref(null)
const statsMemberCharts: Reactive<Record<string, MessageDbChart>> = reactive({})
const statsMemberGid: Ref<string> = ref(null)

onMounted(async () => {
  stats.value = await send('message-db/stats')
  statsGuildsChart.value = await send('message-db/stats/guilds/chart', [ 'zh-CN' ])
  console.info(statsGuildsChart.value)
})

const loadStatsMembersChart = async () => {
  if (! statsMemberGid.value) return
  const [ platform, guildId ] = statsMemberGid.value.split(':')
  const chart = await send('message-db/stats/members/chart', [ 'zh-CN' ], { guildQuery: { platform, guildId } })
  statsMemberCharts[statsMemberGid.value] = chart
}
</script>

<template>
  <k-layout>
    <template #header>
      消息数据库
    </template>
    <k-content #default>
      <div class="grid">
        <k-card title="概览">
          <template v-if="stats">
            总消息数：{{ stats.messageTotal }}<br />
            总群组数：{{ stats.guildTotal }}<br />
            追踪的群组数：{{ stats.trackedGuildsCount }}<br />
            数据库大小：{{ formatSize(stats.tableSize) }}<br />
          </template>
        </k-card>

        <Chart
          :chart="statsGuildsChart"
          :width="600"
          :height="450"
        />

        <Chart
          :chart="statsMemberGid ? statsMemberCharts[statsMemberGid] : null"
          :width="600"
          :height="450"
        >
          <div class="flex">
            <el-select
              v-model="statsMemberGid"
              placeholder="选择群"
            >
              <el-option
                v-for="guild of store.messageDb.config.trackedGuilds"
                :key="`${guild.platform}:${guild.id}`"
                :value="`${guild.platform}:${guild.id}`"
              />
            </el-select>

            <k-button @click="loadStatsMembersChart">OK</k-button>
          </div>
        </Chart>
      </div>
    </k-content>
  </k-layout>
</template>

<style scoped>
.grid {
  display: grid;
  margin: 2rem;
  gap: 2rem;
}

.flex {
  display: flex;
  gap: 1rem;
}
</style>