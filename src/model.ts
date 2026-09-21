import { $, Context, h, Query } from 'koishi'

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
export const ASSET_HOST_MIGRATION_ID = 'v4-asset-host-genshin-asm-ms'
export const MESSAGE_MIGRATION_PROGRESS_ID = `${MESSAGE_MIGRATION_ID}-progress`
export const MESSAGE_TYPE_MIGRATION_PROGRESS_ID = `${MESSAGE_TYPE_MIGRATION_ID}-progress`
export const ASSET_HOST_MIGRATION_PROGRESS_ID = `${ASSET_HOST_MIGRATION_ID}-progress`
export const OLD_ASSET_HOSTNAME = 'genshin.asm.ms'
export const NEW_ASSET_HOSTNAME = 'hjp0aj1a3c9.sn.mynetname.net'
const MIGRATION_BATCH_SIZE = 500
const ASSET_HOST_PATTERN = /(?:genshin\.asm\.ms|hjp0aj1a3c9\.sn\.mynetname\.net)/
const ASSET_ELEMENTS = new Set(['audio', 'file', 'image', 'img', 'video'])
const ASSET_ID_PATH = /^\/assets\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/?$/i

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
    cursor: { type: 'string', nullable: true, initial: null },
    processed: { type: 'unsigned', length: 8, initial: 0 },
    total: { type: 'unsigned', length: 8, initial: 0 },
    completedAt: { type: 'timestamp', nullable: true, initial: null },
  }, {
    primary: 'id',
  })
}

export interface MessageMigrationResult {
  skipped: boolean
  messages: number
  words: number
}

export interface MessageMigrationProgress {
  id: string
  processed: number
  total: number
  completed: boolean
}

export interface MessageMigrationOptions {
  batchSize?: number
  signal?: AbortSignal
  onProgress?: (progress: MessageMigrationProgress) => void
}

export interface AssetHostMigrationResult {
  skipped: boolean
  messages: number
  assets: number
  retained: number
}

export interface AssetHostMigrationOptions extends MessageMigrationOptions {
  markPermanent?: (ids: string[]) => Promise<number>
}

export interface RelocateAssetHostsResult {
  content: string
  changed: number
  assetIds: string[]
}

export function relocateAssetHosts(
  content: string,
  oldHostname = OLD_ASSET_HOSTNAME,
  newHostname = NEW_ASSET_HOSTNAME,
): RelocateAssetHostsResult {
  let changed = 0
  const assetIds = new Set<string>()
  const elements = h.parse(content)

  const visit = (element: h) => {
    if (ASSET_ELEMENTS.has(element.type) && typeof element.attrs.src === 'string') {
      try {
        const url = new URL(element.attrs.src)
        if (url.hostname === oldHostname) {
          url.hostname = newHostname
          element.attrs.src = url.href
          changed ++
        }
        if (url.hostname === newHostname) {
          const match = url.pathname.match(ASSET_ID_PATH)
          if (match) assetIds.add(match[1])
        }
      }
      catch {
        // Relative and malformed resource URLs are unrelated to this migration.
      }
    }
    element.children.forEach(visit)
  }

  elements.forEach(visit)
  return {
    content: changed ? elements.join('') : content,
    changed,
    assetIds: [...assetIds],
  }
}

export async function migrateAssetHosts(
  ctx: Context,
  options: AssetHostMigrationOptions = {},
): Promise<AssetHostMigrationResult> {
  const state = await getMigrationProgress(
    ctx,
    ASSET_HOST_MIGRATION_ID,
    ASSET_HOST_MIGRATION_PROGRESS_ID,
  )
  if (state?.completedAt) {
    return { skipped: true, messages: 0, assets: 0, retained: 0 }
  }

  const query: Query<SavedMessage> = {
    content: { $regex: ASSET_HOST_PATTERN },
  }
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? MIGRATION_BATCH_SIZE))
  let cursor = state?.cursor ?? undefined
  let processed = state?.processed ?? 0
  const total = state?.total || await ctx.database
    .select('w-message-v2')
    .where(query)
    .execute(row => $.count(row.key))
  let messageCount = 0
  let assetCount = 0
  let retainedCount = 0

  await saveMigrationProgress(ctx, {
    id: ASSET_HOST_MIGRATION_PROGRESS_ID,
    cursor,
    processed,
    total,
  })
  options.onProgress?.({
    id: ASSET_HOST_MIGRATION_ID,
    processed,
    total,
    completed: false,
  })

  while (true) {
    options.signal?.throwIfAborted()
    const messages = await ctx.database
      .select('w-message-v2')
      .where(query)
      .where(cursor === undefined ? {} : { key: { $gt: cursor } })
      .orderBy('key')
      .limit(batchSize)
      .execute()
    if (! messages.length) break

    const updates: Pick<SavedMessage, 'key' | 'content'>[] = []
    const assetIds = new Set<string>()
    for (const message of messages) {
      const result = relocateAssetHosts(message.content)
      result.assetIds.forEach(id => assetIds.add(id))
      assetCount += result.changed
      if (result.changed) {
        messageCount ++
        updates.push({ key: message.key, content: result.content })
      }
    }

    // Retain first: after content is rewritten, a crash must not leave a
    // successfully migrated URL pointing at an asset still eligible for GC.
    if (assetIds.size && options.markPermanent) {
      retainedCount += await options.markPermanent([...assetIds])
    }
    if (updates.length) await ctx.database.upsert('w-message-v2', updates)

    processed += messages.length
    cursor = messages.at(-1)!.key
    await saveMigrationProgress(ctx, {
      id: ASSET_HOST_MIGRATION_PROGRESS_ID,
      cursor,
      processed,
      total,
    })
    options.onProgress?.({
      id: ASSET_HOST_MIGRATION_ID,
      processed,
      total,
      completed: false,
    })
  }

  options.signal?.throwIfAborted()
  await saveMigrationProgress(ctx, {
    id: ASSET_HOST_MIGRATION_ID,
    cursor,
    processed: total,
    total,
    completedAt: new Date(),
  })
  await ctx.database.remove('w-message-migration', {
    id: ASSET_HOST_MIGRATION_PROGRESS_ID,
  })
  options.onProgress?.({
    id: ASSET_HOST_MIGRATION_ID,
    processed: total,
    total,
    completed: true,
  })

  return {
    skipped: false,
    messages: messageCount,
    assets: assetCount,
    retained: retainedCount,
  }
}

export async function migrateMessageV2(
  ctx: Context,
  options: MessageMigrationOptions = {},
): Promise<MessageMigrationResult> {
  const state = await getMigrationProgress(
    ctx,
    MESSAGE_MIGRATION_ID,
    MESSAGE_MIGRATION_PROGRESS_ID,
  )
  if (state?.completedAt) return { skipped: true, messages: 0, words: 0 }

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? MIGRATION_BATCH_SIZE))
  let cursor = state?.cursor ?? undefined
  let processed = state?.processed ?? 0
  const total = state?.total || await ctx.database
    .select('w-message')
    .execute(row => $.count(row.id))
  let messageCount = 0
  let wordCount = 0
  await saveMigrationProgress(ctx, {
    id: MESSAGE_MIGRATION_PROGRESS_ID,
    cursor,
    processed,
    total,
  })
  options.onProgress?.({
    id: MESSAGE_MIGRATION_ID,
    processed,
    total,
    completed: false,
  })

  while (true) {
    options.signal?.throwIfAborted()
    const legacyMessages = await ctx.database
      .select('w-message')
      .where(cursor === undefined ? {} : { id: { $gt: cursor } })
      .orderBy('id')
      .limit(batchSize)
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
    processed += messages.length
    cursor = legacyMessages.at(-1)!.id
    await saveMigrationProgress(ctx, {
      id: MESSAGE_MIGRATION_PROGRESS_ID,
      cursor,
      processed,
      total,
    })
    options.onProgress?.({
      id: MESSAGE_MIGRATION_ID,
      processed,
      total,
      completed: false,
    })
  }

  options.signal?.throwIfAborted()
  await saveMigrationProgress(ctx, {
    id: MESSAGE_MIGRATION_ID,
    cursor,
    processed,
    total,
    completedAt: new Date(),
  })
  await ctx.database.remove('w-message-migration', {
    id: MESSAGE_MIGRATION_PROGRESS_ID,
  })
  options.onProgress?.({
    id: MESSAGE_MIGRATION_ID,
    processed,
    total,
    completed: true,
  })

  return {
    skipped: false,
    messages: messageCount,
    words: wordCount,
  }
}

export async function migrateMessageTypes(
  ctx: Context,
  options: MessageMigrationOptions = {},
): Promise<MessageMigrationResult> {
  const state = await getMigrationProgress(
    ctx,
    MESSAGE_TYPE_MIGRATION_ID,
    MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
  )
  if (state?.completedAt) return { skipped: true, messages: 0, words: 0 }

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? MIGRATION_BATCH_SIZE))
  let cursor = state?.cursor ?? undefined
  let processed = state?.processed ?? 0
  const total = state?.total || await ctx.database
    .select('w-message-v2')
    .execute(row => $.count(row.key))
  let messageCount = 0
  await saveMigrationProgress(ctx, {
    id: MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
    cursor,
    processed,
    total,
  })
  options.onProgress?.({
    id: MESSAGE_TYPE_MIGRATION_ID,
    processed,
    total,
    completed: false,
  })

  while (true) {
    options.signal?.throwIfAborted()
    const messages = await ctx.database
      .select('w-message-v2')
      .where(cursor === undefined ? {} : { key: { $gt: cursor } })
      .orderBy('key')
      .limit(batchSize)
      .execute()
    if (! messages.length) break

    await ctx.database.upsert('w-message-v2', messages.map(message => ({
      key: message.key,
      messageTypeMask: getMessageTypeMask(message.content),
    })))
    messageCount += messages.length
    processed += messages.length
    cursor = messages.at(-1)!.key
    await saveMigrationProgress(ctx, {
      id: MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
      cursor,
      processed,
      total,
    })
    options.onProgress?.({
      id: MESSAGE_TYPE_MIGRATION_ID,
      processed,
      total,
      completed: false,
    })
  }

  options.signal?.throwIfAborted()
  await saveMigrationProgress(ctx, {
    id: MESSAGE_TYPE_MIGRATION_ID,
    cursor,
    processed,
    total,
    completedAt: new Date(),
  })
  await ctx.database.remove('w-message-migration', {
    id: MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
  })
  options.onProgress?.({
    id: MESSAGE_TYPE_MIGRATION_ID,
    processed,
    total,
    completed: true,
  })

  return { skipped: false, messages: messageCount, words: 0 }
}

export async function markMessageTypesMigrated(
  ctx: Context,
  total: number,
  onProgress?: MessageMigrationOptions['onProgress'],
) {
  const [state] = await ctx.database.get('w-message-migration', {
    id: MESSAGE_TYPE_MIGRATION_ID,
  })
  if (state?.completedAt) return

  await saveMigrationProgress(ctx, {
    id: MESSAGE_TYPE_MIGRATION_ID,
    processed: total,
    total,
    completedAt: new Date(),
  })
  await ctx.database.remove('w-message-migration', {
    id: MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
  })
  onProgress?.({
    id: MESSAGE_TYPE_MIGRATION_ID,
    processed: total,
    total,
    completed: true,
  })
}

async function saveMigrationProgress(
  ctx: Context,
  state: MessageMigration,
) {
  await ctx.database.upsert('w-message-migration', [state])
}

async function getMigrationProgress(
  ctx: Context,
  completedId: string,
  progressId: string,
) {
  const [completed] = await ctx.database.get('w-message-migration', {
    id: completedId,
  })
  if (completed?.completedAt) return completed

  const [progress] = await ctx.database.get('w-message-migration', {
    id: progressId,
  })
  if (progress) {
    if (completed) {
      await ctx.database.remove('w-message-migration', { id: completedId })
    }
    return progress
  }
  if (! completed) return

  // Early development builds stored an incomplete checkpoint under the final
  // marker ID. Move it away before continuing so older versions, which only
  // test for the marker's existence, cannot mistake it for a completed run.
  const migratedProgress = { ...completed, id: progressId }
  await saveMigrationProgress(ctx, migratedProgress)
  await ctx.database.remove('w-message-migration', { id: completedId })
  return migratedProgress
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
