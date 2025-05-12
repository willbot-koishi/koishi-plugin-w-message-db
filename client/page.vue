<script setup lang="ts">
import { ref } from 'vue'

import TabStats from './components/tabs/stats.vue'
import TabMessages from './components/tabs/messages.vue'

const tab = ref<'stats' | 'messages'>('stats')
</script>

<template>
  <k-layout class="page">
    <template #header>
      消息数据库
    </template>

    <template #left>
      <k-tab-group
        v-model="tab"
        :data="{
          stats: { name: '统计数据' },
          messages: { name: '消息' },
        }"
        #="{ name }"
      >
        {{ name }}
      </k-tab-group>
    </template>

    <template #default>
      <keep-alive>
        <tab-stats v-if="tab === 'stats'" />
        <tab-messages v-else-if="tab === 'messages'" />
      </keep-alive>
    </template>
  </k-layout>
</template>

<style scoped>
.page :deep(.k-content) {
  max-width: unset;
  width: 100%;
  padding: 0;
}

.page :deep(.k-button) {
  white-space: nowrap;
}

.page :deep(.layout-left) {
  --aside-width: 8rem;
}

.page :deep(.k-tab-item) {
  padding: 0 .5rem 0 1rem;
}

.page :deep(.group) {
  display: flex;
  gap: 1rem;
}
</style>