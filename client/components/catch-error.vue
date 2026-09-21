<script setup lang="ts" generic="T extends object">
import { MdbRemoteError } from '../../src/types'

type Data = Exclude<T, MdbRemoteError>

const props = defineProps<{
  data: T
}>()

const ERROR_TEXT = {
  internal: '加载失败：服务器内部错误。',
  'bot-not-available': '加载失败：此群组的管理机器人当前不可用。',
  'migration-pending': '消息数据库正在迁移，请稍后再试。',
  'require-guild-member': '加载失败：仅群成员可以查看。',
} satisfies Record<MdbRemoteError['error'], string>
</script>

<template>
  <slot
    v-if="'error' in data"
    name="error"
    :error="(data as MdbRemoteError)"
  >
    <p class="remote-error">{{ ERROR_TEXT[(props.data as MdbRemoteError).error] }}</p>
  </slot>
  <slot
    v-else
    :data="(data as Data)"
  ></slot>
</template>

<style scoped>
.remote-error {
  color: var(--k-color-danger, #f56c6c);
}
</style>
