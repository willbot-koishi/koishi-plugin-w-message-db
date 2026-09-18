<script setup lang="ts">
import { store } from '@koishijs/client'
import { computed, ref } from 'vue'

import TabStats from './components/tabs/stats.vue'
import TabMessages from './components/tabs/messages.vue'

const tab = ref<'stats' | 'messages'>('stats')
const migration = computed(() => store.messageDb.migration)
const migrationReady = computed(() => migration.value.status === 'ready')
const progress = computed(() => {
  if (! migration.value.total) return 0
  return Math.min(100, migration.value.processed / migration.value.total * 100)
})
const stage = computed(() => ({
  messages: '迁移消息和分词记录',
  'message-types': '建立消息类型索引',
})[migration.value.stage] ?? '准备迁移')
const formatCount = (value: number) => new Intl.NumberFormat().format(value)
</script>

<template>
  <k-layout class="page">
    <template #header>
      消息数据库
    </template>

    <template v-if="migrationReady" #left>
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
      <div v-if="!migrationReady" class="migration">
        <k-card title="正在准备消息数据库">
          <template v-if="migration.status === 'error'">
            <p>迁移失败。修复问题并重启插件后，将从最近的检查点继续。</p>
            <pre>{{ migration.error }}</pre>
          </template>
          <template v-else>
            <p>{{ stage }}</p>
            <div
              class="progress"
              role="progressbar"
              :aria-valuenow="progress"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${progress}%` }"></span>
            </div>
            <p v-if="migration.total" class="progress-text">
              {{ formatCount(migration.processed) }} / {{ formatCount(migration.total) }}
              （{{ progress.toFixed(1) }}%）
            </p>
            <p v-else class="progress-text">正在统计待处理记录……</p>
            <p class="hint">迁移期间消息查询暂不可用；此页面会自动更新。</p>
          </template>
        </k-card>
      </div>
      <KeepAlive v-else>
        <tab-stats v-if="tab === 'stats'" />
        <tab-messages v-else-if="tab === 'messages'" />
      </KeepAlive>
    </template>
  </k-layout>
</template>

<style scoped>
.page :deep(.k-content) {
  max-width: unset;
  width: 100%;
  padding: 0;
}

.page :deep(.el-button) {
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
  align-items: center;
  gap: 1rem;
}
.page :deep(.group *) {
  margin: 0;
}

.page :deep(.el-button) {
  --el-button-font-weight: normal;
}

.page :deep(.el-checkbox.is-bordered) {
  height: 32px;
  padding: 0 9px;
}

.migration {
  max-width: 42rem;
  margin: 4rem auto;
  padding: 0 1rem;
}

.migration p {
  margin: .75rem 0;
}

.migration pre {
  overflow: auto;
  padding: 1rem;
  border-radius: .4rem;
  background: var(--k-page-bg);
  white-space: pre-wrap;
}

.progress {
  height: .6rem;
  overflow: hidden;
  border-radius: .3rem;
  background: var(--k-color-border);
}

.progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--k-color-primary);
  transition: width .3s ease;
}

.progress-text,
.hint {
  color: var(--k-text-light);
}
</style>
