<script setup lang="ts">
import { send, store } from '@koishijs/client'

import {
  GetMessageOption, GetMessagesResult, MdbRemoteError,
  MessageFilter, MessageType, SavedMessage,
} from '../../src/types'
import { normalizeRemoteError } from '../utils/remote-error'
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
  membersLoading?: boolean
}>()

const { messageMap, guildMembers } = useMessageStore()

type TimeRange = [Date, Date]
interface FilterDraft {
  userIds: string[]
  timeRange: TimeRange | null
  keyword: string
  keywordMode: 'plain' | 'regex'
  types: MessageType[]
}

const createFilterDraft = (): FilterDraft => ({
  userIds: [],
  timeRange: null,
  keyword: '',
  keywordMode: 'plain',
  types: [],
})

const filterDraft = reactive(createFilterDraft())
const activeFilter = ref<MessageFilter>({})
const filterError = ref('')
const messageLoadError = ref('')
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

const MESSAGE_LOAD_ERROR_TEXT = {
  internal: '加载消息失败：服务器内部错误。',
  network: '加载消息失败：网络连接异常，请稍后重试。',
  'authentication-required': '加载消息失败：请先登录 Koishi 控制台。',
  'platform-binding-required': '加载消息失败：当前控制台账号尚未绑定此平台账号。',
  'bot-not-available': '加载消息失败：此群组的管理机器人当前不可用。',
  'migration-pending': '消息数据库正在迁移，请稍后再试。',
  'require-guild-member': '加载消息失败：无法验证当前账号的群成员身份，请确认已加入该群。',
} satisfies Record<MdbRemoteError['error'], string>

// Bump the cache namespace when persisted message content is rewritten.
const cachedGuildMessages = storeWrappedReactive<SavedMessage[]>(() => `message-db/guildMessages/v2/${props.gid}`, [])
const filteredMessages = ref<SavedMessage[]>([])
const contextMessages = ref<SavedMessage[]>([])
const contextTargetKey = ref<string>()
const contextLoadingKey = ref<string>()
let contextReturnPagination = { before: true, after: true }
const isContextView = computed(() => contextTargetKey.value !== undefined)
const isFilterView = computed(() => isFilterActive.value && ! isContextView.value)
const guildMessages = computed(() => {
  if (isContextView.value) return contextMessages.value
  return isFilterActive.value ? filteredMessages.value : cachedGuildMessages.value
})
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
  messageLoadError.value = ''
  contextLoadingKey.value = undefined
}

type MessageLoadingState = 'idle' | 'loading'
const messageLoadingState = ref<MessageLoadingState>('idle')
const isSelecting = ref(false)
const selectedMessageKeys = ref<string[]>([])
const selectedMessageKeySet = computed(() => new Set(selectedMessageKeys.value))

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
    filter.startTime = filterDraft.timeRange[0].getTime()
    filter.endTime = filterDraft.timeRange[1].getTime()
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

const resetPagination = () => {
  isSelecting.value = false
  selectedMessageKeys.value = []
  rebuildLoadedMessageKeys()
  hasMore.value = { before: true, after: true }
}

const applyFilter = () => {
  const filter = normalizeFilter()
  if (! filter) return
  if (JSON.stringify(filter) === JSON.stringify(activeFilter.value)) {
    isFilterPanelVisible.value = false
    if (isContextView.value) returnToFilter()
    return
  }

  queryVersion ++
  activeRequestId ++
  messageLoadingState.value = 'idle'
  messageLoadError.value = ''
  contextLoadingKey.value = undefined
  contextTargetKey.value = undefined
  contextMessages.value = []
  activeFilter.value = filter
  if (isFilterActive.value) filteredMessages.value = []
  resetPagination()
  isFilterPanelVisible.value = false
  if (isFilterActive.value) void loadMessages('before')
}

const resetFilter = () => {
  Object.assign(filterDraft, createFilterDraft())
  applyFilter()
}

const toggleKeywordMode = () => {
  filterDraft.keywordMode = filterDraft.keywordMode === 'plain' ? 'regex' : 'plain'
  if (filterDraft.keywordMode === 'plain') filterError.value = ''
}

const getGuildQuery = () => {
  const [ platform, guildId ] = props.gid.split(':')
  return { platform, guildId }
}

const isCurrentRequest = (version: number, requestId: number) =>
  version === queryVersion && requestId === activeRequestId

const requestMessages = async (
  options: GetMessageOption,
  version: number,
  requestId: number,
): Promise<GetMessagesResult | undefined> => {
  let result: GetMessagesResult | MdbRemoteError | undefined
  try {
    result = await send('message-db/getMessages', options)
  }
  catch (error) {
    if (isCurrentRequest(version, requestId))
      messageLoadError.value = MESSAGE_LOAD_ERROR_TEXT[normalizeRemoteError(error).error]
    return
  }

  if (! isCurrentRequest(version, requestId)) return
  if (! result) {
    messageLoadError.value = '加载消息失败，请检查网络连接后重试。'
    return
  }
  if ('error' in result) {
    messageLoadError.value = MESSAGE_LOAD_ERROR_TEXT[result.error]
    return
  }
  return result
}

const registerMessages = (messages: SavedMessage[]) => {
  for (const message of messages) messageMap.set(message.key, message)
}

const loadMessages = async (direction: 'before' | 'after') => {
  if (messageLoadingState.value === 'loading') return
  if (direction === 'before' && ! hasMore.value.before) return
  const version = queryVersion
  const requestId = ++ activeRequestId
  messageLoadingState.value = 'loading'
  messageLoadError.value = ''

  const messages = guildMessages.value
  let baseTimestamp = Math.min(
    Date.now(),
    isContextView.value ? Date.now() : activeFilter.value.endTime ?? Date.now(),
  ) + 1
  let baseId: string | undefined
  if (messages.length) {
    const base = direction === 'before' ? messages[0] : messages.at(- 1)
    baseTimestamp = base.timestamp
    baseId = base.id
  }

  try {
    const hadMessages = messages.length > 0
    const result = await requestMessages({
      guildQuery: getGuildQuery(),
      filter: isContextView.value ? {} : activeFilter.value,
      baseTimestamp,
      baseId,
      direction,
      limit: 100,
    }, version, requestId)
    if (! result) return

    hasMore.value[direction] = result.hasMore
    if (direction === 'before' && ! hadMessages) hasMore.value.after = false
    const messageSlice = result.data.filter(message => ! loadedMessageKeys.has(message.key))
    if (! messageSlice.length) return

    registerMessages(messageSlice)
    for (const message of messageSlice) loadedMessageKeys.add(message.key)

    if (direction === 'before') {
      const anchor = messagesEl.value?.querySelector<HTMLElement>(
        `[data-key="${CSS.escape(messages[0]?.key ?? '')}"]`,
      )
      const anchorTop = anchor?.getBoundingClientRect().top
      messages.unshift(...messageSlice.reverse())
      await nextTick()
      if (anchor && anchorTop !== undefined) {
        const offset = anchor.getBoundingClientRect().top - anchorTop
        findScrollContainer(anchor).scrollTop += offset
      }
      else {
        scrollToMessage(messageSlice.at(- 1)?.key, 'end')
      }
    }
    else {
      messages.push(...messageSlice)
      await nextTick()
      scrollToMessage(messageSlice[0].key)
    }
  }
  finally {
    if (isCurrentRequest(version, requestId))
      messageLoadingState.value = 'idle'
  }
}

const loadLatestMessages = async () => {
  if (messageLoadingState.value === 'loading' || isContextView.value) return
  const version = ++ queryVersion
  const requestId = ++ activeRequestId
  messageLoadingState.value = 'loading'
  messageLoadError.value = ''

  try {
    const result = await requestMessages({
      guildQuery: getGuildQuery(),
      filter: activeFilter.value,
      baseTimestamp: Math.min(
        Date.now(),
        activeFilter.value.endTime ?? Date.now(),
      ) + 1,
      direction: 'before',
      limit: 100,
    }, version, requestId)
    if (! result) return

    const messages = guildMessages.value
    const latestMessages = result.data.reverse()
    messages.splice(0, messages.length, ...latestMessages)
    registerMessages(latestMessages)
    rebuildLoadedMessageKeys()
    hasMore.value = { before: result.hasMore, after: false }
    await nextTick()
    scrollToMessage(latestMessages.at(- 1)?.key, 'end')
  }
  finally {
    if (isCurrentRequest(version, requestId))
      messageLoadingState.value = 'idle'
  }
}

const messagesEl = useTemplateRef('messages')

const findScrollContainer = (element: HTMLElement): HTMLElement => {
  let current = element.parentElement
  while (current) {
    const { overflowY } = getComputedStyle(current)
    if (/(auto|scroll|overlay)/.test(overflowY)) return current
    current = current.parentElement
  }
  return document.scrollingElement as HTMLElement ?? document.documentElement
}

const scrollToMessage = (messageKey?: string, block: ScrollLogicalPosition = 'nearest') => {
  if (! messageKey) return
  const el = messagesEl.value?.querySelector(`[data-key="${CSS.escape(messageKey)}"]`)
  if (! el) return
  el.scrollIntoView({
    behavior: 'auto',
    block,
  })
}

const openMessageContext = async (target: SavedMessage) => {
  if (messageLoadingState.value === 'loading') return
  const version = ++ queryVersion
  const requestId = ++ activeRequestId
  messageLoadingState.value = 'loading'
  messageLoadError.value = ''
  contextLoadingKey.value = target.key

  try {
    const common = {
      guildQuery: getGuildQuery(),
      filter: {},
      baseTimestamp: target.timestamp,
      baseId: target.id,
      limit: 50,
    }
    const [ before, after ] = await Promise.all([
      requestMessages({ ...common, direction: 'before' }, version, requestId),
      requestMessages({ ...common, direction: 'after' }, version, requestId),
    ])
    if (! before || ! after || ! isCurrentRequest(version, requestId)) return

    const messages = [ ...before.data.reverse(), target, ...after.data ]
    contextReturnPagination = { ...hasMore.value }
    contextMessages.value = messages.filter((message, index) =>
      messages.findIndex(candidate => candidate.key === message.key) === index
    )
    contextTargetKey.value = target.key
    registerMessages(contextMessages.value)
    resetPagination()
    hasMore.value = { before: before.hasMore, after: after.hasMore }
    await nextTick()
    scrollToMessage(target.key, 'center')
  }
  finally {
    if (isCurrentRequest(version, requestId)) {
      messageLoadingState.value = 'idle'
      contextLoadingKey.value = undefined
    }
  }
}

const returnToFilter = () => {
  if (! isContextView.value) return
  const targetKey = contextTargetKey.value
  queryVersion ++
  activeRequestId ++
  messageLoadingState.value = 'idle'
  contextTargetKey.value = undefined
  contextMessages.value = []
  resetPagination()
  hasMore.value = contextReturnPagination
  nextTick(() => scrollToMessage(targetKey, 'center'))
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
let hasActivated = false

onActivated(() => {
  isActivated.value = true
  if (! hasActivated) {
    hasActivated = true
    nextTick(() => scrollToMessage(guildMessages.value.at(- 1)?.key, 'end'))
  }
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
              :teleported="false"
              :loading="membersLoading"
              :placeholder="membersLoading ? '成员加载中……' : '全部成员'"
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
              :placeholder="filterDraft.keywordMode === 'regex' ? '输入正则表达式' : '输入关键词'"
            >
              <template #suffix>
                <button
                  type="button"
                  class="keyword-mode-toggle"
                  :class="{ active: filterDraft.keywordMode === 'regex' }"
                  :aria-pressed="filterDraft.keywordMode === 'regex'"
                  title="切换正则表达式模式"
                  @click="toggleKeywordMode"
                >正则</button>
              </template>
            </el-input>
          </label>
          <label>
            <span>类型</span>
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
    <div
      v-if="isContextView && imageExportingState === 'idle'"
      class="context-toolbar"
    >
      <span>正在查看筛选结果所在位置</span>
      <el-button size="small" @click="returnToFilter">返回筛选结果</el-button>
    </div>
    <el-alert
      v-if="messageLoadError && imageExportingState === 'idle'"
      class="message-load-error"
      type="error"
      show-icon
      :closable="false"
      :title="messageLoadError"
    />
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
        v-for="message, index of guildMessages"
        :key="message.key"
      >
        <label
          v-if="imageExportingState === 'idle' || selectedMessageKeySet.has(message.key)"
          :data-key="message.key"
          class="message-wrapper"
          :class="{
            'context-target': isContextView && message.key === contextTargetKey,
          }"
          @click.capture="event => onMessageClick(event, index)"
        >
          <el-checkbox
            v-if="isSelecting && imageExportingState === 'idle'"
            :value="message.key"
            class="message-selector"
          />
          <w-message
            :message="message"
            :show-time="showTime"
            :highlight-keyword="isFilterActive ? activeFilter.keyword : undefined"
            :highlight-mode="activeFilter.keywordMode"
          >
            <template v-if="isFilterView && ! isSelecting" #author-action>
              <el-button
                class="message-context-button"
                :class="{ loading: contextLoadingKey === message.key }"
                link
                :loading="contextLoadingKey === message.key"
                :disabled="messageLoadingState === 'loading'"
                @click.prevent.stop="openMessageContext(message)"
              >点击查看上下文</el-button>
            </template>
          </w-message>
        </label>
      </template>
    </el-checkbox-group>
    <el-divider
      v-if="guildMessages.length && imageExportingState === 'idle'"
      class="load-button"
    >
      <template v-if="messageLoadingState === 'loading'">加载中</template>
      <el-button
        v-else
        @click="loadMessages('after')"
        title="加载当前最后一条消息之后的消息"
      >{{ hasMore.after ? '加载后续' : '检查后续' }}</el-button>
      <el-button
        v-if="! isContextView"
        @click="loadLatestMessages"
        title="舍弃当前分页位置并直接加载最新一页"
      >跳至最新</el-button>
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
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.filter-panel :deep(.el-date-editor) {
  --el-date-editor-datetimerange-width: 100%;
}

.filter-panel :deep(.el-select__selection .el-tag) {
  --el-tag-bg-color: var(--bg2);
  --el-tag-border-color: var(--fg1);
  --el-tag-text-color: var(--fg0);
}

.keyword-mode-toggle {
  border: 1px solid transparent;
  border-radius: .25rem;
  padding: .1rem .35rem;
  color: var(--fg1);
  background: transparent;
  font: inherit;
  font-size: .75rem;
  line-height: 1.25;
  cursor: pointer;
}

.keyword-mode-toggle:hover {
  color: var(--fg0);
  background: var(--bg2);
}

.keyword-mode-toggle.active {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
  background: var(--bg2);
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

.context-toolbar {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: .75rem;
  margin: 0 auto 1rem;
  padding: .5rem;
  color: var(--fg1);
  background: var(--k-page-bg);
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
  padding: .5rem;
  transition: background-color .2s;
}

.message-wrapper.context-target {
  background-color: var(--el-color-info-dark-2);
}

.message-context-button {
  height: auto;
  padding: 0;
  font-size: inherit;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.message-wrapper:hover .message-context-button,
.message-wrapper:focus-within .message-context-button,
.message-context-button.loading {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.load-button {
  margin: 1rem 0;
}

.message-load-error {
  margin: 1rem 0;
}

.load-button :deep(.el-divider__text) {
  display: flex;
  gap: .5rem;
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
