import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import { Context } from 'koishi'

import { createMessageKey } from '../shared/utils'
import {
  extendMessageModels,
  markMessageTypesMigrated,
  MESSAGE_MIGRATION_ID,
  MESSAGE_MIGRATION_PROGRESS_ID,
  MESSAGE_TYPE_MIGRATION_ID,
  MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
  migrateMessageTypes,
  migrateMessageV2,
} from '../src/model'
import { getMessageTypeMask, MESSAGE_TYPE_BITS } from '../src/query'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.stop()))
})

async function createContext() {
  const ctx = new Context()
  ctx.plugin(memory)
  extendMessageModels(ctx)
  contexts.push(ctx)
  await ctx.start()
  return ctx
}

describe('message v2 model', () => {
  it('uses the platform and guild as part of message identity', async () => {
    const ctx = await createContext()
    const first = {
      key: createMessageKey({ platform: 'onebot', guildId: '100', id: '42' }),
      id: '42',
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      username: 'Alice',
      content: 'first',
      timestamp: 1,
      segmented: false,
    }
    const second = {
      ...first,
      key: createMessageKey({ platform: 'discord', guildId: '200', id: '42' }),
      platform: 'discord',
      guildId: '200',
      content: 'second',
    }

    await ctx.database.upsert('w-message-v2', [first, second])

    assert.notEqual(first.key, second.key)
    assert.equal((await ctx.database.get('w-message-v2', {})).length, 2)
  })

  it('copies legacy messages and related words idempotently', async () => {
    const ctx = await createContext()
    await ctx.database.create('w-message', {
      id: '42',
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      username: 'Alice',
      content: 'hello',
      timestamp: 1,
      segmented: true,
    })
    await ctx.database.create('w-message-word', {
      messageId: '42',
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      timestamp: 1,
      index: 0,
      word: 'hello',
      tag: 'eng',
    })
    // Old GC versions could leave orphan word rows. They should not block the
    // migration because there is no valid composite message identity for them.
    await ctx.database.create('w-message-word', {
      messageId: 'missing',
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      timestamp: 1,
      index: 0,
      word: 'orphan',
      tag: 'eng',
    })

    assert.deepEqual(await migrateMessageV2(ctx), {
      skipped: false,
      messages: 1,
      words: 1,
    })

    const key = createMessageKey({ platform: 'onebot', guildId: '100', id: '42' })
    const [message] = await ctx.database.get('w-message-v2', { key })
    assert.equal(message.content, 'hello')
    assert.equal(message.messageTypeMask, MESSAGE_TYPE_BITS.text)
    assert.deepEqual(await ctx.database.get('w-message-word-v2', {}), [{
      messageKey: key,
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      timestamp: 1,
      index: 0,
      word: 'hello',
      tag: 'eng',
    }])
    assert.equal((await ctx.database.get('w-message', {})).length, 1)
    assert.equal((await ctx.database.get('w-message-word', {})).length, 2)
    assert.equal((await ctx.database.get('w-message-migration', {
      id: MESSAGE_MIGRATION_ID,
    })).length, 1)

    assert.deepEqual(await migrateMessageV2(ctx), {
      skipped: true,
      messages: 0,
      words: 0,
    })
  })

  it('resumes the legacy migration after its last durable batch', async () => {
    const ctx = await createContext()
    await ctx.database.upsert('w-message', ['1', '2'].map(id => ({
      id,
      platform: 'onebot',
      guildId: '100',
      userId: '1',
      username: 'Alice',
      content: `message ${id}`,
      timestamp: Number(id),
      segmented: false,
    })))

    const controller = new AbortController()
    await assert.rejects(migrateMessageV2(ctx, {
      batchSize: 1,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.processed === 1) controller.abort()
      },
    }), { name: 'AbortError' })

    const [checkpoint] = await ctx.database.get('w-message-migration', {
      id: MESSAGE_MIGRATION_PROGRESS_ID,
    })
    assert.equal(checkpoint.cursor, '1')
    assert.equal(checkpoint.processed, 1)
    assert.equal(checkpoint.total, 2)
    assert.equal(checkpoint.completedAt, null)
    assert.equal((await ctx.database.get('w-message-migration', {
      id: MESSAGE_MIGRATION_ID,
    })).length, 0)

    assert.deepEqual(await migrateMessageV2(ctx, { batchSize: 1 }), {
      skipped: false,
      messages: 1,
      words: 0,
    })
    assert.equal((await ctx.database.get('w-message-v2', {})).length, 2)
  })

  it('indexes message element types for existing v2 rows', async () => {
    const ctx = await createContext()
    const key = createMessageKey({ platform: 'discord', guildId: '200', id: '42' })
    await ctx.database.create('w-message-v2', {
      key,
      id: '42',
      platform: 'discord',
      guildId: '200',
      userId: '1',
      username: 'Alice',
      content: 'caption<img src="https://example.com/a.png"/><audio src="a"/>',
      timestamp: 1,
      segmented: false,
      messageTypeMask: 0,
    })

    assert.deepEqual(await migrateMessageTypes(ctx), {
      skipped: false,
      messages: 1,
      words: 0,
    })
    const [message] = await ctx.database.get('w-message-v2', { key })
    assert.equal(message.messageTypeMask,
      MESSAGE_TYPE_BITS.text | MESSAGE_TYPE_BITS.image | MESSAGE_TYPE_BITS.audio)
    assert.equal((await ctx.database.get('w-message-migration', {
      id: MESSAGE_TYPE_MIGRATION_ID,
    })).length, 1)
  })

  it('resumes message type indexing after its last durable batch', async () => {
    const ctx = await createContext()
    const messages = ['1', '2'].map(id => ({
      key: createMessageKey({ platform: 'discord', guildId: '200', id }),
      id,
      platform: 'discord',
      guildId: '200',
      userId: '1',
      username: 'Alice',
      content: `<img src="${id}"/>`,
      timestamp: Number(id),
      segmented: false,
      messageTypeMask: 0,
    })).sort((a, b) => a.key.localeCompare(b.key))
    await ctx.database.upsert('w-message-v2', messages)

    const controller = new AbortController()
    await assert.rejects(migrateMessageTypes(ctx, {
      batchSize: 1,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.processed === 1) controller.abort()
      },
    }), { name: 'AbortError' })

    const [checkpoint] = await ctx.database.get('w-message-migration', {
      id: MESSAGE_TYPE_MIGRATION_PROGRESS_ID,
    })
    assert.equal(checkpoint.cursor, messages[0].key)
    assert.equal(checkpoint.processed, 1)
    assert.equal((await ctx.database.get('w-message-migration', {
      id: MESSAGE_TYPE_MIGRATION_ID,
    })).length, 0)

    assert.deepEqual(await migrateMessageTypes(ctx, { batchSize: 1 }), {
      skipped: false,
      messages: 1,
      words: 0,
    })
    const indexed = await ctx.database.get('w-message-v2', {})
    assert.ok(indexed.every(message => message.messageTypeMask === MESSAGE_TYPE_BITS.image))
  })

  it('can mark message types migrated after a fresh v2 copy', async () => {
    const ctx = await createContext()
    await markMessageTypesMigrated(ctx, 42)

    const [marker] = await ctx.database.get('w-message-migration', {
      id: MESSAGE_TYPE_MIGRATION_ID,
    })
    assert.equal(marker.processed, 42)
    assert.equal(marker.total, 42)
    assert.ok(marker.completedAt)
    assert.deepEqual(await migrateMessageTypes(ctx), {
      skipped: true,
      messages: 0,
      words: 0,
    })
  })
})

describe('message type detection', () => {
  it('recognizes all filterable resource types', () => {
    const mask = getMessageTypeMask(
      'text<img src="image"/><audio src="audio"/><video src="video"/><file src="file"/>',
    )
    assert.equal(mask, Object.values(MESSAGE_TYPE_BITS).reduce((result, bit) => result | bit, 0))
  })
})
