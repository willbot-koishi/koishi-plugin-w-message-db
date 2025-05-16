<script setup lang="ts">
import { h } from '@satorijs/core'

import { SavedMessage } from '../../src/types'
import { getGid } from '../../shared/utils'

import { computed, ref } from 'vue'
import { useMessageStore } from '../stores/message'

const props = defineProps<{
  message: SavedMessage
  showTime?: boolean
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
        {{ message.username }}
        <span v-if="showTime" class="message-time">
          {{ new Date(message.timestamp).toLocaleString() }}
        </span>
      </div>
      <div
        class="message-content"
        :class="{
          'resource-only': elements.length === 1 && RESOURCE_ELEMENT_TYPES.includes(elements[0].type),
        }"
      >
        <template v-for="element, index of elements">
          <template v-if="element.type === 'text'">
            <pre>{{ h.unescape(element.toString()) }}</pre>
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
  font-size: .8rem;
  padding-left: .1rem;
}

.message-time {
  color: var(--fg2);
  margin-left: .2rem;
}
</style>