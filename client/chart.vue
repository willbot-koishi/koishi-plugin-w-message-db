<script setup lang="ts">
import VChart from 'vue-echarts'
import { MdbChart } from '../src/types'
import { computed } from 'vue'
import { TitleOption } from 'echarts/types/dist/shared'
import { stripUndefined } from '../shared/utils'

const props = defineProps<{
  chart: MdbChart | undefined
  defaultTitle: string
  width: number
  height: number
}>()

const title = computed(() => {
  if (! props.chart) return props.defaultTitle
  return (props.chart.option.title as TitleOption).text
})

const sizeStyle = computed(() => ({
  width: props.width + 'px',
  height: props.height + 'px',
}))
</script>

<template>
  <k-card :title="title" class="w-chart">
    <slot></slot>
    <div class="w-chart-inner" :style="sizeStyle">
      <v-chart
        :option="stripUndefined({
          ...chart?.option,
          title: undefined,
        })"
      />
    </div>
  </k-card>
</template>

<style scoped>
.w-chart-inner {
  display: flex;
  justify-content: center;
} 
</style>