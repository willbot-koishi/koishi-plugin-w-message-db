<script setup lang="ts">
import { send, store } from '@koishijs/client'

import {
  GetMessagesResult, MdbRemoteError, MessageFilter, MessageType, SavedMessage,
} from '../../src/types'
import { storeWrappedReactive } from '../utils/storage'

import {
  useTemplateRef, ref, reactive, watch, nextTick,
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

const { messageMap, guildMembers } = useMessageStore()

type TimeValue = Date | number | string
interface FilterDraft {
  userIds: string[]
  timeRange: TimeValue[] | null
  keyword: string
  keywordMode: 'plain' | 'regex'
  types: MessageType[]
}

const createFilterDraft = (): FilterDraft => ({
  userIds: [],
  timeRange: [],
  keyword: '',
  keywordMode: 'plain',
  types: [],
})

const filterDraft = reactive(createFilterDraft())
const activeFilter = ref<MessageFilter>({})
const filterError = ref('')
const isFilterPanelVisible = ref(false)
const isFilterActive = computed(() => Object.keys(activeFilter.value).length > 0)
const activeFilterCount = computed(() => [
  activeFilter.value.userIds?.length,
  activeFilter.value.startTime !== undefined || activeFilter.value.endTime !== undefined,
  activeFilter.value.keyword,
  activeFilter.value.types?.length,
].filter(Boolean).length)

const memberOptions = computed(() => Object
  .values(guildMembers[props.gid] ?? {})
  .map(member => ({
    id: member.user.id,
    name: member.nick || member.user.name || member.user.id,
  }))
  .sort((a, b) => a.name.localeCompare(b.name)))

const MESSAGE_TYPE_OPTIONS: Array<{ value: MessageType, label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' },
  { value: 'file', label: '文件' },
]

const cachedGuildMessages = storeWrappedReactive<SavedMessage[]>(() => `message-db/guildMessages/${props.gid}`, [])
const filteredMessages = ref<SavedMessage[]>([])
const guildMessages = computed(() => isFilterActive.value
  ? filteredMessages.value
  : cachedGuildMessages.value)
const loadedMessageKeys = new Set<string>()
for (const message of cachedGuildMessages.value) {
  // Cached v1 messages predate the composite key.
  message.key ??= createMessageKey(message)
  messageMap.set(message.key, message)
  loadedMessageKeys.add(message.key)
}

const hasMore = ref({ before: true, after: true })
let queryVersion = 0
let activeRequestId = 0

const clearMessages = () => {
  queryVersion ++
  activeRequestId ++
  messageLoadingState.value = 'idle'
  guildMessages.value.length = 0
  isSelecting.value = false
  selectedMessageKeys.value = []
  loadedMessageKeys.clear()
  hasMore.value = { before: true, after: true }
}

type MessageLoadingState = 'idle' | 'loading'
const messageLoadingState = ref<MessageLoadingState>('idle')
const isSelecting = ref(false)
const selectedMessageKeys = ref<string[]>([])
const selectedMessageKeySet = computed(() => new Set(selectedMessageKeys.value))

const getTimestamp = (value: TimeValue) => value instanceof Date
  ? value.getTime()
  : Number(value)

const normalizeFilter = (): MessageFilter | null => {
  const keyword = filterDraft.keyword.trim()
  if (keyword && filterDraft.keywordMode === 'regex') {
    try {
      new RegExp(keyword)
    }
    catch {
      filterError.value = '正则表达式无效。'
      return null
    }
  }

  filterError.value = ''
  const filter: MessageFilter = {}
  if (filterDraft.userIds.length)
    filter.userIds = [...new Set(filterDraft.userIds)].sort()
  if (filterDraft.timeRange?.length === 2) {
    filter.startTime = getTimestamp(filterDraft.timeRange[0])
    filter.endTime = getTimestamp(filterDraft.timeRange[1])
  }
  if (keyword) {
    filter.keyword = keyword
    filter.keywordMode = filterDraft.keywordMode
  }
  if (filterDraft.types.length)
    filter.types = [...new Set(filterDraft.types)].sort()
  return filter
}

const rebuildLoadedMessageKeys = () => {
  loadedMessageKeys.clear()
  for (const message of guildMessages.value) loadedMessageKeys.add(message.key)
}

const applyFilter = () => {
  const filter = normalizeFilter()
  if (! filter) return
  if (JSON.stringify(filter) === JSON.stringify(activeFilter.value)) {
    isFilterPanelVisible.value = false
    return
  }

  queryVersion ++
  activeRequestId ++
  messageLoadingState.value = 'idle'
  activeFilter.value = filter
  isSelecting.value = false
  selectedMessageKeys.value = []
  if (isFilterActive.value) filteredMessages.value = []
  rebuildLoadedMessageKeys()
  hasMore.value = { before: true, after: true }
  isFilterPanelVisible.value = false
  if (isFilterActive.value) void loadMessages('before')
}

const resetFilter = () => {
  Object.assign(filterDraft, createFilterDraft())
  applyFilter()
}

const loadMessages = async (direction: 'before' | 'after') => {
  const { gid } = props
  if (
    messageLoadingState.value === 'loading' ||
    direction === 'before' && ! hasMore.value.before
  ) return
  const version = queryVersion
  const requestId = ++ activeRequestId
  messageLoadingState.value = 'loading'

  const [ platform, guildId ] = gid.split(':')
  const guildQuery = { platform, guildId }

  const messages = guildMessages.value

  let baseTimestamp = Math.min(
    Date.now(),
    activeFilter.value.endTime ?? Date.now(),
  ) + 1
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
      filter: activeFilter.value,
      baseTimestamp,
      baseId,
      direction,
      limit: 100,
    })
  }
  finally {
    if (requestId === activeRequestId)
      messageLoadingState.value = 'idle'
  }

  if (version !== queryVersion) return
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
  cachedGuildMessages[Symbol.dispose]()
})
</script>

<template>
  <Teleport v-if="isActivated" :to="toolbarEl">
    <div class="toolbar-select group">
      <el-popover
        v-model:visible="isFilterPanelVisible"
        placement="bottom-start"
        :width="420"
        trigger="click"
      >
        <template #reference>
          <el-button :type="isFilterActive ? 'primary' : 'default'">
            筛选{{ activeFilterCount ? ` (${activeFilterCount})` : '' }}
          </el-button>
        </template>
        <div class="filter-panel">
          <label>
            <span>成员</span>
            <el-select
              v-model="filterDraft.userIds"
              multiple
              filterable
              clearable
              collapse-tags
              placeholder="全部成员"
            >
              <el-option
                v-for="member of memberOptions"
                :key="member.id"
                :value="member.id"
                :label="member.name"
              />
            </el-select>
          </label>
          <label>
            <span>时间范围</span>
            <el-date-picker
              v-model="filterDraft.timeRange"
              type="datetimerange"
              start-placeholder="开始时间"
              end-placeholder="结束时间"
              range-separator="至"
              clearable
            />
          </label>
          <label>
            <span>内容</span>
            <el-input
              v-model="filterDraft.keyword"
              clearable
              maxlength="256"
              placeholder="输入关键词或正则表达式"
            />
          </label>
          <el-radio-group v-model="filterDraft.keywordMode" size="small">
            <el-radio-button value="plain">普通包含</el-radio-button>
            <el-radio-button value="regex">正则表达式</el-radio-button>
          </el-radio-group>
          <label>
            <span>类型（任一）</span>
            <el-checkbox-group v-model="filterDraft.types" class="filter-types">
              <el-checkbox
                v-for="type of MESSAGE_TYPE_OPTIONS"
                :key="type.value"
                :value="type.value"
              >{{ type.label }}</el-checkbox>
            </el-checkbox-group>
          </label>
          <span v-if="filterError" class="filter-error">{{ filterError }}</span>
          <div class="filter-actions">
            <el-button @click="resetFilter">重置</el-button>
            <el-button type="primary" @click="applyFilter">应用</el-button>
          </div>
        </div>
      </el-popover>
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
      >{{ hasMore.after ? '加载更新' : '检查更新' }}</el-button>
    </el-divider>
  </div>
</template>

<style scoped>
.toolbar-select span {
  text-wrap: nowrap;
}

.filter-panel {
  display: flex;
  flex-direction: column;
  gap: .75rem;
}

.filter-panel > label {
  display: grid;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  align-items: center;
  gap: .75rem;
}

.filter-panel :deep(.el-date-editor),
.filter-panel :deep(.el-select) {
  width: 100%;
}

.filter-types {
  display: flex;
  flex-wrap: wrap;
  gap: 0 .75rem;
}

.filter-error {
  color: var(--k-color-danger, #f56c6c);
}

.filter-actions {
  display: flex;
  justify-content: flex-end;
  gap: .5rem;
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
