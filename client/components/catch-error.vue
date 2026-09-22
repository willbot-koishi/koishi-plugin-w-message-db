<script setup lang="ts" generic="T extends object">
import { MdbRemoteError } from '../../src/types'

type Data = Exclude<T, MdbRemoteError>

const props = defineProps<{
  data: T
}>()

const ERROR_TEXT = {
  internal: '加载失败：服务器内部错误。',
  network: '加载失败：网络连接异常，请稍后重试。',
  'authentication-required': '加载失败：请先登录 Koishi 控制台。',
  'platform-binding-required': '加载失败：当前控制台账号尚未绑定此平台账号。',
  'bot-not-available': '加载失败：此群组的管理机器人当前不可用。',
  'migration-pending': '消息数据库正在迁移，请稍后再试。',
  'require-guild-member': '加载失败：无法验证当前账号的群成员身份，请确认已加入该群。',
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
