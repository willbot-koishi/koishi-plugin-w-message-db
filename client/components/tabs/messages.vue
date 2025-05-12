<script lang="ts">
type MessageLoadingState = 'idle' | 'loading'

type GuildMembers = Record<string, Record<string, GuildMember>>
export const kGuildMembers = Symbol('guildMembers') as InjectionKey<GuildMembers>
</script>

<script setup lang="ts">
import { send, store } from '@koishijs/client'
import type { GuildMember } from '@satorijs/protocol'

import type { SavedMessage, DurationQuery } from '../../../src/types'
import { getGid } from '../../../shared/utils'
import { storeReactive } from '../../utils/storage'

import {
  reactive, ref, useTemplateRef, nextTick, provide,
  onMounted, onUnmounted, watch,
  type InjectionKey, 
} from 'vue'

import SelectGuild from '../select-guild.vue'
import WMessage from '../message.vue'

const gid = ref<string>(null)

const guildMessages = storeReactive<Record<string, SavedMessage[]>>('message-db/guildMessages', {})
const messageMap = new Map<string, SavedMessage>()

const guildMembers = storeReactive<GuildMembers>('message-db/guildMembers', {})
provide(kGuildMembers, guildMembers)

const messageLoadingState = reactive<Record<string, MessageLoadingState>>({})

const messagesEl = useTemplateRef('messagesEl')

const loadMessages = async (mode: 'old' | 'new') => {
  const gid_ = gid.value
  if (! gid_) return
  if (messageLoadingState[gid_] === 'loading') return
  messageLoadingState[gid_] = 'loading'

  const [ platform, guildId ] = gid.value.split(':')
  const guildQuery = { platform, guildId }

  guildMessages[gid_] ??= []
  const messages = guildMessages[gid_]

  const durationQuery: DurationQuery = { timestamp: {} }
  if (messages.length) {
    if (mode === 'new') durationQuery.timestamp.$gte = messages.at(- 1).timestamp
    else if (mode === 'old') durationQuery.timestamp.$lte = messages[0].timestamp
  }

  let messageSlice = await send('message-db/getMessages', {
    guildQuery,
    durationQuery,
    limit: 100,
    page: 0,
  })

  messageLoadingState[gid_] = 'idle'

  if ('error' in messageSlice) {
    return
  }

  messageSlice = messageSlice.filter(message => {
    if (messageMap.has(message.id)) return false
    messageMap.set(message.id, message)
    return true
  })
  messageSlice.reverse()

  if (mode === 'new') {
    messages.push(...messageSlice)
    nextTick(() => scrollToMessage(messageSlice.at(- 1).id))
  }
  else if (mode === 'old') {
    messages.unshift(...messageSlice)
    nextTick(() => scrollToMessage(messageSlice[0].id))
  }
}

const scrollToMessage = (messageId: string) => {
  const el = messagesEl.value?.querySelector(`[data-id="${messageId}"]`)
  if (! el) return
  el.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
  })
}

onMounted(async () => {
  await Promise.all(store.messageDb.savedGuilds.map(async guild => {
    const gid = getGid(guild)
    if (guildMembers[gid]) return
    const members = await send('message-db/getGuildMembers', {
      guildQuery: {
        platform: guild.platform,
        guildId: guild.guildId,
      }
    })
    if ('error' in members) return
    guildMembers[gid] = Object.fromEntries(members.map(member => [ member.user.id, member ]))
  }))
})

onUnmounted(() => {
  guildMessages[Symbol.dispose]()
})

watch(gid, gid_ => {
  nextTick(() => {
    const message = guildMessages[gid_]?.at(- 1)
    if (message) scrollToMessage(message.id)
  })
})
</script>

<template>
  <div class="tab-messages">
    <div class="toolbar">
      <div class="group select-guild">
        <select-guild v-model="gid" />
      </div>
    </div>

    <k-content>
      <div
        v-if="gid"
        ref="messagesEl"
        class="messages"
      >
        <el-divider v-if="guildMessages[gid]?.length" class="load-button">
          <template v-if="messageLoadingState[gid] === 'loading'">加载中</template>
          <k-button v-else @click="loadMessages('old')">加载更旧</k-button>
        </el-divider>
        <w-message
          v-for="message of guildMessages[gid] ?? []"
          :data-id="message.id"
          :key="message.id"
          :message="message"
        />
        <el-divider class="load-button">
          <template v-if="messageLoadingState[gid] === 'loading'">加载中</template>
          <k-button v-else @click="loadMessages('new')">加载更新</k-button>
        </el-divider>
      </div>
    </k-content>
  </div>
</template>

<style scoped>
.tab-messages {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.select-guild {
  max-width: 25rem;
  max-height: 40.45rem;
}

.toolbar {
  padding: 1rem;
}

.load-button {
  margin: 1rem 0;
}

.load-button :deep(.el-divider__text) {
  background: unset;
}

.load-button .k-button {
  background-color: var(--k-page-bg);
  padding: .1rem .4rem;
}
</style>