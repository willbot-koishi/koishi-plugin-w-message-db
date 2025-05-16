import { GuildMember } from '@satorijs/protocol'

import { SavedMessage } from '../../src/types'
import { storeReactive } from '../utils/storage'
import { defineStore } from '.'

export type GuildMembers = Record<string, Record<string, GuildMember>>

export const useMessageStore = defineStore('message', () => {
  const messageMap = new Map<string, SavedMessage>()
  const guildMembers = storeReactive<GuildMembers>('message-db/guildMembers', {})

  return {
    messageMap, guildMembers,
  }
})

