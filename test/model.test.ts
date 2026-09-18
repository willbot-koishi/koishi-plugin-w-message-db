import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import { Context } from 'koishi'

import { createMessageKey } from '../shared/utils'
import {
  extendMessageModels,
  MESSAGE_MIGRATION_ID,
  migrateMessageV2,
} from '../src/model'

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
    assert.equal((await ctx.database.get('w-message-v2', { key }))[0].content, 'hello')
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
})
