<script setup lang="ts">
import { stripUndefined } from '../../shared/utils'
import { MdbChart, MdbRemoteError } from '../../src/types'

import { computed } from 'vue'
import VChart from 'vue-echarts'
import { TitleOption } from 'echarts/types/dist/shared'

import CatchError from './catch-error.vue'

const props = defineProps<{
  chart: MdbChart | MdbRemoteError | undefined
  defaultTitle: string
  width: string
  height: string
  loading?: boolean
}>()

const title = computed(() => {
  if (! props.chart || 'error' in props.chart) return props.defaultTitle
  return (props.chart.option.title as TitleOption).text
})
</script>

<template>
  <k-card :title="title" class="w-chart">
    <slot></slot>
    <div
      v-loading="loading"
      element-loading-text="加载中"
      class="w-chart-inner"
      :style="{ width, height }"
    >
      <catch-error
        v-if="chart && ! loading"
        :data="chart"
        #="{ data: chart }"
      >
        <v-chart
          :option="stripUndefined({
            ...chart?.option,
            title: undefined,
          })"
        />
      </catch-error>
      <span v-else-if="! loading" class="w-chart-empty">尚未加载</span>
    </div>
  </k-card>
</template>

<style scoped>
.w-chart-inner {
  display: flex;
  justify-content: center;
  align-items: center;
} 

.w-chart-empty {
  color: var(--fg2);
}
</style>
