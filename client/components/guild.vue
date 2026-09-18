<script setup lang="ts">
import { send, store } from '@koishijs/client'

import { GetMessagesResult, MdbRemoteError, SavedMessage } from '../../src/types'
import { storeWrappedReactive } from '../utils/storage'

import {
  useTemplateRef, ref, watch, nextTick,
  onBeforeUnmount, onActivated, onDeactivated, computed,
} from 'vue'
import html2canvas from 'html2canvas'
import WMessage from './message.vue'
import { useMessageStore } from '../stores/message'
import { createMessageKey, findMinBy, minBy, sortPair } from '../../shared/utils'

const props = defineProps<{
  gid: string
  toolbarEl: HTMLElement
}>()

const { messageMap } = useMessageStore()

const guildMessages = storeWrappedReactive<SavedMessage[]>(() => `message-db/guildMessages/${props.gid}`, [])
const loadedMessageKeys = new Set<string>()
for (const message of guildMessages.value) {
  // Cached v1 messages predate the composite key.
  message.key ??= createMessageKey(message)
  messageMap.set(message.key, message)
  loadedMessageKeys.add(message.key)
}

const hasMore = ref({ before: true, after: true })

const clearMessages = () => {
  for (const message of guildMessages.value) {
    messageMap.delete(message.key)
  }
  guildMessages.value.length = 0
  loadedMessageKeys.clear()
  hasMore.value = { before: true, after: true }
}

type MessageLoadingState = 'idle' | 'loading'
const messageLoadingState = ref<MessageLoadingState>('idle')

const loadMessages = async (direction: 'before' | 'after') => {
  const { gid } = props
  if (messageLoadingState.value === 'loading') return
  messageLoadingState.value = 'loading'

  const [ platform, guildId ] = gid.split(':')
  const guildQuery = { platform, guildId }

  const messages = guildMessages.value

  let baseTimestamp = Date.now() + 1
  let baseId: string | undefined
  if (messages.length) {
    const base = direction === 'before' ? messages[0] : messages.at(- 1)
    baseTimestamp = base.timestamp
    baseId = base.id
  }

  let result: GetMessagesResult | MdbRemoteError
  try {
    result = await send('message-db/getMessages', {
      guildQuery,
      baseTimestamp,
      baseId,
      direction,
      limit: 100,
    })
  }
  finally {
    messageLoadingState.value = 'idle'
  }

  if ('error' in result) {
    return
  }
  hasMore.value[direction] = result.hasMore

  const messageSlice = result.data.filter(message => {
    if (loadedMessageKeys.has(message.key)) return false
    loadedMessageKeys.add(message.key)
    messageMap.set(message.key, message)
    return true
  })
  if (! messageSlice.length) return

  if (direction === 'before') {
    messages.unshift(...messageSlice.reverse())
    nextTick(() => scrollToMessage(messageSlice.at(- 1).key))
  }
  else {
    messages.push(...messageSlice)
    nextTick(() => scrollToMessage(messageSlice[0].key))
  }
}

const messagesEl = useTemplateRef('messages')

const scrollToMessage = (messageKey: string) => {
  const el = messagesEl.value?.querySelector(`[data-key="${CSS.escape(messageKey)}"]`)
  if (! el) return
  el.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  })
}

const isSelecting = ref(false)
const selectedMessageKeys = ref<string[]>([])
const selectedMessageKeySet = computed(() => new Set(selectedMessageKeys.value))

const onMessageClick = (event: MouseEvent, baseIndex: number) => {
  if (! event.shiftKey) return
  if (! selectedMessageKeys.value.length) return

  event.preventDefault()
  event.stopPropagation()

  const messages = guildMessages.value
  const messageIndexMap = new Map(messages.map((message, index) => [ message.key, index ]))
  const { index: nearestIndex } = findMinBy(
    selectedMessageKeys.value.map(key => {
      const index = messageIndexMap.get(key)
      return { index, delta: Math.abs(index - baseIndex) }
    }),
    ({ delta }) => delta,
  )
  let [ startIndex, endIndex ] = sortPair(nearestIndex, baseIndex)
  while (startIndex <= endIndex) {
    const message = messages[startIndex]
    selectedMessageKeySet.value.add(message.key)
    startIndex ++
  }

  selectedMessageKeys.value = [ ...selectedMessageKeySet.value.values() ]
}

watch(isSelecting, (value) => {
  if (! value) {
    selectedMessageKeys.value.length = 0
    imageExportingState.value = 'idle'
  }
})

const showTime = ref(false)

const imageExportingState = ref<'idle' | 'previewing' | 'exporting'>('idle')

const exportToImage = async () => {
  if (! messagesEl.value) return
  if (! selectedMessageKeys.value.length) return
  if (imageExportingState.value !== 'previewing') return
  imageExportingState.value = 'exporting'

  try {
    const { proxyUrl } = store.messageDb.config.console
    const canvas = await html2canvas(messagesEl.value, {
      backgroundColor: null,
      useCORS: ! proxyUrl,
      proxy: proxyUrl,
    })

    const blob = await new Promise<Blob>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (! blob) return

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `messages-${props.gid}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url))
  }
  finally {
    imageExportingState.value = 'idle'
  }
}

const isActivated = ref(false)

onActivated(() => {
  isActivated.value = true
  nextTick(() => {
    scrollToMessage(guildMessages.value.at(- 1)?.key)
  })
})

onDeactivated(() => {
  isActivated.value = false
})

onBeforeUnmount(() => {
  guildMessages[Symbol.dispose]()
})
</script>

<template>
  <Teleport v-if="isActivated" :to="toolbarEl">
    <div class="toolbar-select group">
      <el-checkbox v-model="showTime" border>显示时间</el-checkbox>
      <el-button @click="clearMessages">清空</el-button>
      <el-checkbox v-model="isSelecting" border>多选</el-checkbox>
      <template v-if="isSelecting">
        <span>
          {{ imageExportingState === 'previewing' ? '将要导出' : '已选' }}
          {{ selectedMessageKeys.length }} 条消息
        </span>
        <el-button
          v-if="imageExportingState === 'idle'"
          @click="imageExportingState = 'previewing'"
          :disabled="! selectedMessageKeys.length"
        >导出图片</el-button>
        <template v-else-if="imageExportingState === 'previewing'">
          <el-button
            @click="exportToImage"
            :disabled="! selectedMessageKeys.length"
          >开始导出</el-button>
          <el-button
            @click="imageExportingState = 'idle'"
          >退出预览</el-button>
        </template>
        <template v-else>
          <el-button :disabled="true">导出中……</el-button>
        </template>
      </template>
    </div>
  </Teleport>
  <div
    ref="messages"
    class="messages"
    :class="{
      selecting: isSelecting,
      exporting: imageExportingState !== 'idle',
    }"
  >
    <el-divider
      v-if="imageExportingState === 'idle'"
      class="load-button"
    >
      <template v-if="messageLoadingState === 'loading'">加载中</template>
      <el-button
        v-else
        @click="loadMessages('before')"
        :disabled="! hasMore.before"
      >{{ hasMore.before ? '加载更旧' : '没有更旧的消息' }}</el-button>
    </el-divider>
    <el-checkbox-group v-model="selectedMessageKeys">
      <template
        v-for="message, index of guildMessages.value"
        :key="message.key"
      >
        <label
          v-if="imageExportingState === 'idle' || selectedMessageKeySet.has(message.key)"
          :data-key="message.key"
          class="message-wrapper"
          @click.capture="event => onMessageClick(event, index)"
        >
          <el-checkbox
            v-if="isSelecting && imageExportingState === 'idle'"
            :value="message.key"
            class="message-selector"
          />
          <w-message :message="message" :show-time="showTime" />
        </label>
      </template>
    </el-checkbox-group>
    <el-divider
      v-if="guildMessages.value.length && imageExportingState === 'idle'"
      class="load-button"
    >
      <template v-if="messageLoadingState === 'loading'">加载中</template>
      <el-button
        v-else
        @click="loadMessages('after')"
        :disabled="! hasMore.after"
      >{{ hasMore.after ? '加载更新' : '没有更新的消息' }}</el-button>
    </el-divider>
  </div>
</template>

<style scoped>
.toolbar-select span {
  text-wrap: nowrap;
}

.messages.selecting:not(.exporting) .message-wrapper:hover {
  background-color: var(--bg2);
}

.messages.selecting {
  user-select: none;
}

.messages.exporting {
  max-width: 35rem;
  margin: auto;
  padding: 1rem;
}

.messages.exporting {
  border: 1px solid var(--fg1);
  border-radius: .5rem;
}

.message.exporting :deep(.message-resource) {
  max-width: 100%;
}

.message-wrapper {
  display: flex;
  gap: .1rem;
  margin: .1rem;
  padding: .4rem;
  transition: background-color .2s;
}

.load-button {
  margin: 1rem 0;
}

.load-button :deep(.el-divider__text) {
  background: unset;
}

.load-button .el-button {
  background-color: var(--k-page-bg);
  padding: .1rem .4rem;
  height: 1.5rem;
}

.message-selector {
  margin: .5rem 0;
  --el-checkbox-height: 1rem;
  --el-checkbox-input-border: 1px solid var(--fg1);
}

.el-checkbox-group {
  font-size: unset;
  line-height: unset;
}

.messages .el-checkbox {
  --el-checkbox-input-width: 1rem;
  --el-checkbox-input-height: 1rem;
}

.messages :deep(.el-checkbox__input .el-checkbox__inner) {
  border-radius: 50%;
}

.messages :deep(.el-checkbox__input.is-checked .el-checkbox__inner::after) {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(1.2) rotate(45deg);
}
</style>
