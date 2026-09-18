import { Context } from 'koishi'

import {
  LegacySavedMessage,
  LegacySavedMessageWord,
  MessageMigration,
  SavedGuild,
  SavedMessage,
  SavedMessageWord,
} from './types'
import { createMessageKey } from '../shared/utils'
import { getMessageTypeMask } from './query'

export const MESSAGE_MIGRATION_ID = 'v2'
export const MESSAGE_TYPE_MIGRATION_ID = 'v3-message-types'
const MIGRATION_BATCH_SIZE = 500

declare module 'koishi' {
  interface Tables {
    'w-message': LegacySavedMessage
    'w-message-word': LegacySavedMessageWord
    'w-message-v2': SavedMessage
    'w-message-word-v2': SavedMessageWord
    'w-message-guild': SavedGuild
    'w-message-migration': MessageMigration
  }
}

export function extendMessageModels(ctx: Context) {
  // Keep the v1 tables readable until the v2 migration has been verified.
  ctx.model.extend('w-message', {
    id: 'string',
    platform: 'string',
    guildId: 'string',
    userId: 'string',
    username: 'string',
    content: 'text',
    timestamp: 'unsigned(8)',
    segmented: 'boolean',
    quoteId: 'string',
  }, {
    primary: 'id',
    indexes: [
      ['timestamp'],
      ['platform', 'guildId'],
    ],
  })

  ctx.model.extend('w-message-word', {
    messageId: 'string',
    platform: 'string',
    guildId: 'string',
    userId: 'string',
    timestamp: 'unsigned(8)',
    index: 'unsigned',
    word: 'string',
    tag: 'string',
  }, {
    primary: ['messageId', 'index'],
  })

  ctx.model.extend('w-message-v2', {
    key: 'string',
    id: 'string',
    platform: 'string',
    guildId: 'string',
    userId: 'string',
    username: 'string',
    content: 'text',
    timestamp: 'unsigned(8)',
    segmented: 'boolean',
    quoteId: 'string',
    messageTypeMask: 'unsigned',
  }, {
    primary: 'key',
    indexes: [
      ['timestamp'],
      ['platform', 'guildId', 'timestamp'],
    ],
  })

  ctx.model.extend('w-message-word-v2', {
    messageKey: 'string',
    platform: 'string',
    guildId: 'string',
    userId: 'string',
    timestamp: 'unsigned(8)',
    index: 'unsigned',
    word: 'string',
    tag: 'string',
  }, {
    primary: ['messageKey', 'index'],
    indexes: [
      ['timestamp'],
      ['platform', 'guildId', 'timestamp'],
    ],
  })

  ctx.model.extend('w-message-guild', {
    platform: 'string',
    guildId: 'string',
    name: 'string',
    managerBotId: 'string',
    isTracked: 'boolean',
  }, {
    primary: ['platform', 'guildId'],
  })

  ctx.model.extend('w-message-migration', {
    id: 'string',
    completedAt: 'timestamp',
  }, {
    primary: 'id',
  })
}

export interface MessageMigrationResult {
  skipped: boolean
  messages: number
  words: number
}

export async function migrateMessageV2(ctx: Context): Promise<MessageMigrationResult> {
  const [completed] = await ctx.database.get('w-message-migration', {
    id: MESSAGE_MIGRATION_ID,
  })
  if (completed) return { skipped: true, messages: 0, words: 0 }

  let cursor: string | undefined
  let messageCount = 0
  let wordCount = 0

  while (true) {
    const legacyMessages = await ctx.database
      .select('w-message')
      .where(cursor === undefined ? {} : { id: { $gt: cursor } })
      .orderBy('id')
      .limit(MIGRATION_BATCH_SIZE)
      .execute()
    if (! legacyMessages.length) break

    const messages: SavedMessage[] = legacyMessages.map(message => ({
      ...message,
      key: createMessageKey(message),
      messageTypeMask: getMessageTypeMask(message.content),
    }))
    const keysByLegacyId = new Map(messages.map(message => [message.id, message.key]))
    const legacyWords = await ctx.database.get('w-message-word', {
      messageId: { $in: legacyMessages.map(message => message.id) },
    })
    const words: SavedMessageWord[] = legacyWords.map(({ messageId, ...word }) => ({
      ...word,
      messageKey: keysByLegacyId.get(messageId)!,
    }))

    await ctx.database.upsert('w-message-v2', messages)
    if (words.length) await ctx.database.upsert('w-message-word-v2', words)
    await validateBatch(ctx, messages, words)

    messageCount += messages.length
    wordCount += words.length
    cursor = legacyMessages.at(-1)!.id
  }

  await ctx.database.create('w-message-migration', {
    id: MESSAGE_MIGRATION_ID,
    completedAt: new Date(),
  }).catch(async error => {
    const [marker] = await ctx.database.get('w-message-migration', {
      id: MESSAGE_MIGRATION_ID,
    })
    if (! marker) throw error
  })

  return {
    skipped: false,
    messages: messageCount,
    words: wordCount,
  }
}

export async function migrateMessageTypes(ctx: Context): Promise<MessageMigrationResult> {
  const [completed] = await ctx.database.get('w-message-migration', {
    id: MESSAGE_TYPE_MIGRATION_ID,
  })
  if (completed) return { skipped: true, messages: 0, words: 0 }

  let cursor: string | undefined
  let messageCount = 0
  while (true) {
    const messages = await ctx.database
      .select('w-message-v2')
      .where(cursor === undefined ? {} : { key: { $gt: cursor } })
      .orderBy('key')
      .limit(MIGRATION_BATCH_SIZE)
      .execute()
    if (! messages.length) break

    await ctx.database.upsert('w-message-v2', messages.map(message => ({
      key: message.key,
      messageTypeMask: getMessageTypeMask(message.content),
    })))
    messageCount += messages.length
    cursor = messages.at(-1)!.key
  }

  await ctx.database.create('w-message-migration', {
    id: MESSAGE_TYPE_MIGRATION_ID,
    completedAt: new Date(),
  }).catch(async error => {
    const [marker] = await ctx.database.get('w-message-migration', {
      id: MESSAGE_TYPE_MIGRATION_ID,
    })
    if (! marker) throw error
  })

  return { skipped: false, messages: messageCount, words: 0 }
}

async function validateBatch(
  ctx: Context,
  messages: SavedMessage[],
  words: SavedMessageWord[],
) {
  const [storedMessages, storedWords] = await Promise.all([
    ctx.database.get('w-message-v2', { key: { $in: messages.map(message => message.key) } }),
    words.length
      ? ctx.database.get('w-message-word-v2', {
        messageKey: { $in: messages.map(message => message.key) },
      })
      : [],
  ])
  const messageKeys = new Set(storedMessages.map(message => message.key))
  const wordKeys = new Set(storedWords.map(word => `${word.messageKey}\0${word.index}`))

  for (const message of messages) {
    if (! messageKeys.has(message.key))
      throw new Error(`failed to migrate message ${message.key}`)
  }
  for (const word of words) {
    if (! wordKeys.has(`${word.messageKey}\0${word.index}`))
      throw new Error(`failed to migrate word ${word.messageKey}:${word.index}`)
  }
}
