<script setup lang="ts">
import VChart from 'vue-echarts'
import { MessageDbChart } from '../src/types'
import { computed } from 'vue'
import { TitleOption } from 'echarts/types/dist/shared'

const props = defineProps<{
  chart: MessageDbChart
  width: number
  height: number
}>()

const title = computed(() => {
  if (! props.chart) return ''
  return (props.chart.option.title as TitleOption).text
})
</script>

<template>
  <k-card :title="title">
    <slot></slot>
    <v-chart
      v-if="chart"
      :style="{
        width: props.width + 'px',
        height: props.height + 'px',
      }"
      :option="{
        ...chart.option,
        title: undefined,
      }"
    />
  </k-card>
</template>