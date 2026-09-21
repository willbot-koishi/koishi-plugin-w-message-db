<script setup lang="ts">
import { h } from '@satorijs/core'

import { SavedMessage } from '../../src/types'
import { getGid } from '../../shared/utils'

import { computed, ref } from 'vue'
import { useMessageStore } from '../stores/message'

const props = defineProps<{
  message: SavedMessage
  showTime?: boolean
  highlightKeyword?: string
  highlightMode?: 'plain' | 'regex'
}>()

const { guildMembers } = useMessageStore()
const members = computed(() => guildMembers?.[getGid(props.message)] ?? {})

const elements = computed(() => h.parse(props.message.content))
const lastIndex = computed(() => elements.value.length - 1)

const getUserName = (userId: string) => {
  const member = members.value?.[userId]
  return member?.nick || member?.user.name || userId
}

const RESOURCE_ELEMENT_TYPES = [ 'image', 'img', 'video', 'audio' ]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const splitHighlightedText = (text: string) => {
  if (! props.highlightKeyword) return [{ text, highlighted: false }]

  const pattern = props.highlightMode === 'regex'
    ? props.highlightKeyword
    : escapeRegExp(props.highlightKeyword)
  const regex = new RegExp(pattern, 'g')
  const parts: Array<{ text: string, highlighted: boolean }> = []
  let cursor = 0
  let match: RegExpExecArray
  while ((match = regex.exec(text)) !== null) {
    if (match[0]) {
      if (match.index > cursor) {
        parts.push({ text: text.slice(cursor, match.index), highlighted: false })
      }
      parts.push({ text: match[0], highlighted: true })
      cursor = match.index + match[0].length
    }
    else {
      // Empty regex matches have no visible text to highlight and must advance.
      regex.lastIndex = match.index + 1
    }
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false })
  return parts
}

const isActive = ref(false)
</script>

<template>
  <div
    class="message"
    :class="{ active: isActive }"
  >
    <div class="message-avatar">
      <img :src="members[message.userId]?.user.avatar" />
    </div>
    <div class="message-right">
      <div class="message-author">
        <span>{{ message.username }}</span>
        <span v-if="showTime" class="message-time">
          {{ new Date(message.timestamp).toLocaleString() }}
        </span>
        <slot name="author-action"></slot>
      </div>
      <div
        class="message-content"
        :class="{
          'resource-only': elements.length === 1 && RESOURCE_ELEMENT_TYPES.includes(elements[0].type),
        }"
      >
        <template v-for="element, index of elements">
          <template v-if="element.type === 'text'">
            <pre><template
              v-for="part, partIndex of splitHighlightedText(h.unescape(element.toString()))"
              :key="partIndex"
            ><mark v-if="part.highlighted">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'image' || element.type === 'img'">
            <img class="message-resource" :src="element.attrs.src" />
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'video'">
            <video class="message-resource" :src="element.attrs.src" controls />
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'audio'">
            <audio class="message-resource" :src="element.attrs.src" />
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'at'">
            <span class="message-at">@{{ getUserName(element.attrs.id) }}</span>
          </template>
          <template v-else>
            [{{ element.type }}]
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: .5rem;
  max-width: calc(100% - 1rem);
}

.message-avatar img {
  width: 2rem;
  height: 2rem;
  border-radius: 1rem;
}

.message-content {
  padding: .3rem .5rem .4rem .5rem;
  background-color: var(--k-side-bg);
  border-radius: 0.5rem;
}

.message-resource {
  max-width: 10rem;
  max-height: 16.18rem;
}

.message.active .message-resource {
  max-width: 100%;
  max-height: 100%;
}

.message-content pre {
  display: inline;
  font-family: inherit;
  margin: 0;
  white-space: break-spaces;
}

.message-content mark {
  border-radius: .15em;
  padding: 0 .05em;
  color: inherit;
  background: var(--el-color-warning-light-3);
}

.message-content.resource-only {
  line-height: 0;
  padding: 0;
  overflow: hidden;
}

.message-right {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: .2rem;
  width: 100%;
}

.message-at {
  color: var(--active);
}

.message-author {
  display: flex;
  align-items: center;
  gap: .35rem;
  font-size: .8rem;
  padding-left: .1rem;
}

.message-time {
  color: var(--fg2);
  margin-left: .2rem;
}
</style>
