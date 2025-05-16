<script setup lang="ts">
import { send, store } from '@koishijs/client'

import { SavedMessage } from '../../src/types'
import { storeWrappedReactive } from '../utils/storage'

import { useTemplateRef, ref, watch, nextTick, onDeactivated, onActivated, computed, toValue } from 'vue'
import html2canvas from 'html2canvas'
import WMessage from './message.vue'
import { useMessageStore } from '../stores/message'
import { findMinBy, minBy, sortPair } from '../../shared/utils'

const props = defineProps<{
  gid: string
  toolbarEl: HTMLElement
}>()

const { messageMap } = useMessageStore()

const guildMessages = storeWrappedReactive<SavedMessage[]>(() => `message-db/guildMessages/${props.gid}`, [])

type MessageLoadingState = 'idle' | 'loading'
const messageLoadingState = ref<MessageLoadingState>('idle')

const loadMessages = async (direction: 'before' | 'after') => {
  const { gid } = props
  if (messageLoadingState.value === 'loading') return
  messageLoadingState.value = 'loading'

  const [ platform, guildId ] = gid.split(':')
  const guildQuery = { platform, guildId }

  const messages = guildMessages.value

  let baseTimestamp = Date.now()
  if (messages.length) {
    if (direction === 'before') baseTimestamp = messages[0].timestamp
    else baseTimestamp = messages.at(- 1).timestamp
  }

  let messageSlice = await send('message-db/getMessages', {
    guildQuery,
    baseTimestamp,
    direction,
    limit: 100,
    page: 0,
  })

  messageLoadingState.value = 'idle'

  if ('error' in messageSlice) {
    return
  }

  messageSlice = messageSlice.filter(message => {
    if (messageMap.has(message.id)) return false
    messageMap.set(message.id, message)
    return true
  })
  if (! messageSlice.length) return

  if (direction === 'before') {
    messages.unshift(...messageSlice.reverse())
    nextTick(() => scrollToMessage(messageSlice.at(- 1).id))
  }
  else {
    messages.push(...messageSlice)
    nextTick(() => scrollToMessage(messageSlice[0].id))
  }
}

const messagesEl = useTemplateRef('messages')

const scrollToMessage = (messageId: string) => {
  const el = messagesEl.value?.querySelector(`[data-id="${messageId}"]`)
  if (! el) return
  el.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  })
}

const isSelecting = ref(false)
const selectedMessageIds = ref<string[]>([])
const selectedMessageIdSet = computed(() => new Set(selectedMessageIds.value))

const onMessageClick = (event: MouseEvent, baseIndex: number) => {
  if (! event.shiftKey) return
  if (! selectedMessageIds.value.length) return

  event.preventDefault()
  event.stopPropagation()

  const messages = guildMessages.value
  const messageIndexMap = new Map(messages.map((message, index) => [ message.id, index ]))
  const { index: nearestIndex } = findMinBy(
    selectedMessageIds.value.map(id => {
      const index = messageIndexMap.get(id)
      return { index, delta: Math.abs(index - baseIndex) }
    }),
    ({ delta }) => delta,
  )
  let [ startIndex, endIndex ] = sortPair(nearestIndex, baseIndex)
  while (startIndex <= endIndex) {
    const message = messages[startIndex]
    selectedMessageIdSet.value.add(message.id)
    startIndex ++
  }

  selectedMessageIds.value = [ ...selectedMessageIdSet.value.values() ]
}

watch(isSelecting, (value) => {
  if (! value) {
    selectedMessageIds.value.length = 0
    imageExportingState.value = 'idle'
  }
})

const showTime = ref(false)

const imageExportingState = ref<'idle' | 'previewing' | 'exporting'>('idle')

const exportToImage = async () => {
  if (! messagesEl.value) return
  if (! selectedMessageIds.value.length) return
  if (imageExportingState.value !== 'previewing') return
  imageExportingState.value = 'exporting'

  try {
    const { proxyUrl } = store.messageDb.config.console
    console.log(proxyUrl)
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
  }
  finally {
    imageExportingState.value = 'idle'
  }
}

const isActivated = ref(false)

onActivated(() => {
  isActivated.value = true
  nextTick(() => {
    scrollToMessage(guildMessages.value.at(- 1)?.id)  
  })
})

onDeactivated(() => {
  isActivated.value = false
  guildMessages[Symbol.dispose]()
})
</script>

<template>
  <Teleport v-if="isActivated" :to="toolbarEl">
    <div class="toolbar-select group">
      <el-checkbox v-model="showTime" border>显示时间</el-checkbox>
      <el-button @click="guildMessages.value.length = 0">清空</el-button>
      <el-checkbox v-model="isSelecting" border>多选</el-checkbox>
      <template v-if="isSelecting">
        <span>
          {{ imageExportingState === 'previewing' ? '将要导出' : '已选' }}
          {{ selectedMessageIds.length }} 条消息
        </span>
        <el-button
          v-if="imageExportingState === 'idle'"
          @click="imageExportingState = 'previewing'"
          :disabled="! selectedMessageIds.length"
        >导出图片</el-button>
        <template v-else-if="imageExportingState === 'previewing'">
          <el-button
            @click="exportToImage"
            :disabled="! selectedMessageIds.length"
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
      <el-button v-else @click="loadMessages('before')">加载更旧</el-button>
    </el-divider>
    <el-checkbox-group v-model="selectedMessageIds">
      <template
        v-for="message, index of guildMessages.value"
        :key="message.id"
      >
        <label
          v-if="imageExportingState === 'idle' || selectedMessageIdSet.has(message.id)"
          :data-id="message.id"
          class="message-wrapper"
          @click.capture="event => onMessageClick(event, index)"
        >
          <el-checkbox
            v-if="isSelecting && imageExportingState === 'idle'"
            :value="message.id"
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
      <el-button v-else @click="loadMessages('after')">加载更新</el-button>
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