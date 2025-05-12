<script setup lang="ts">
import { h } from '@satorijs/core'

import { SavedMessage } from '../../src/types'
import { getGid } from '../../shared/utils'

import { computed, inject } from 'vue'

import { kGuildMembers } from './tabs/messages.vue'

const props = defineProps<{
  message: SavedMessage
}>()

const guildMembers = inject(kGuildMembers)
const members = computed(() => guildMembers?.[getGid(props.message)])

const elements = computed(() => h.parse(props.message.content))

const getUserName = (userId: string) => {
  const member = members.value?.[userId]
  return member?.nick || member?.user.name || userId
}

const lastIndex = computed(() => elements.value.length - 1)
</script>

<template>
  <div class="message">
    <div class="message-avatar">
      <img :src="members[message.userId]?.user.avatar" />
    </div>
    <div class="message-right">
      <div class="message-author">
        {{ message.username }}
      </div>
      <div
        class="message-content"
        :class="{
          'img-only': elements.length === 1 && (elements[0].type === 'image' || elements[0].type === 'img'),
        }"
      >
        <template v-for="element, index of elements">
          <template v-if="element.type === 'text'">
            <pre>{{ h.unescape(element.toString()) }}</pre>
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'image' || element.type === 'img'">
            <img :src="element.attrs.src" />
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'video'">
            <video :src="element.attrs.src" />
            <br v-if="index < lastIndex" />
          </template>
          <template v-else-if="element.type === 'audio'">
            <audio :src="element.attrs.src" />
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
  padding: 1rem;
  max-width: calc(100% - 1rem);
}

.message-avatar img {
  width: 2rem;
  height: 2rem;
  border-radius: 1rem;
}

.message-content {
  padding: .5rem;
  background-color: var(--k-side-bg);
  border-radius: 0.5rem;
}

.message-content img {
  max-width: 10rem;
  max-height: 16.18rem;
}

.message-content pre {
  display: inline;
  font-family: inherit;
  margin: 0;
  white-space: break-spaces;
}

.message-content.img-only {
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
</style>