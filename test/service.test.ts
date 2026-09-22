import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import memory from '@koishijs/plugin-database-memory'
import { Context } from 'koishi'

import { createMessageKey } from '../shared/utils'
import { MdbService } from '../src'
import { extendMessageModels } from '../src/model'
import type { SavedMessage } from '../src/types'

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

function createService(ctx: Context, overrides: Record<string, any> = {}) {
  const service = Object.create(MdbService.prototype)
  Object.assign(service, {
    ctx,
    config: {
      readonly: false,
      requireTracking: false,
      assetTransferring: {
        enabled: false,
        requireTracking: true,
      },
      gc: {
        enabled: true,
        olderThan: 1,
        untrackedOnly: false,
      },
    },
    captureTasks: new Map(),
    savedGuildMap: new Map(),
    migration: { status: 'ready', processed: 0, total: 0 },
    logger: { info() {} },
    ...overrides,
  })
  return service as MdbService
}

function createMessage(id: string, data: Partial<SavedMessage> = {}): SavedMessage {
  const platform = data.platform ?? 'test'
  const guildId = data.guildId ?? '100'
  return {
    key: createMessageKey({ platform, guildId, id }),
    id,
    platform,
    guildId,
    userId: '1',
    username: 'Alice',
    content: `message ${id}`,
    timestamp: 0,
    segmented: false,
    messageTypeMask: 1,
    ...data,
  }
}

describe('message service API', () => {
  it('coalesces concurrent captures and returns the stored message', async () => {
    const ctx = await createContext()
    let transformCount = 0
    let emitCount = 0
    const fakeContext = {
      database: ctx.database,
      assetsPro: {
        async transform(content: string) {
          transformCount ++
          return `stored:${content}`
        },
      },
      emit() {
        emitCount ++
      },
    }
    const service = createService(ctx, {
      ctx: fakeContext,
      config: {
        readonly: false,
        requireTracking: false,
        assetTransferring: { enabled: true, requireTracking: true },
      },
      savedGuildMap: new Map([['test:100', {
        platform: 'test',
        guildId: '100',
        name: 'Test',
        managerBotId: 'bot',
        isTracked: true,
      }]]),
    })
    const session = {
      platform: 'test',
      selfId: 'bot',
      guildId: '100',
      userId: '1',
      username: 'Alice',
      timestamp: 123,
      messageId: '42',
      content: 'hello',
    } as any

    const [first, second] = await Promise.all([
      service.captureMessage(session),
      service.captureMessage(session),
    ])

    assert.deepEqual(first, second)
    assert.equal(first?.content, 'stored:hello')
    assert.equal(transformCount, 1)
    assert.equal(emitCount, 1)

    const third = await service.captureMessage(session)
    assert.equal(third?.key, first?.key)
    assert.equal(third?.content, first?.content)
    assert.equal(transformCount, 1)
    assert.equal(emitCount, 1)
  })

  it('reads batches in request order and manages retained messages', async () => {
    const ctx = await createContext()
    const service = createService(ctx)
    const first = createMessage('1')
    const second = createMessage('2')
    await ctx.database.upsert('w-message-v2', [first, second])
    await ctx.database.upsert('w-message-word-v2', [
      {
        messageKey: first.key,
        platform: first.platform,
        guildId: first.guildId,
        userId: first.userId,
        timestamp: first.timestamp,
        index: 1,
        word: 'b',
        tag: 'x',
      },
      {
        messageKey: first.key,
        platform: first.platform,
        guildId: first.guildId,
        userId: first.userId,
        timestamp: first.timestamp,
        index: 0,
        word: 'a',
        tag: 'x',
      },
      {
        messageKey: second.key,
        platform: second.platform,
        guildId: second.guildId,
        userId: second.userId,
        timestamp: second.timestamp,
        index: 0,
        word: 'c',
        tag: 'x',
      },
    ])

    assert.deepEqual(
      (await service.getMessagesByKeys([second.key, 'missing', first.key, second.key]))
        .map(message => message.key),
      [second.key, first.key],
    )
    assert.deepEqual(
      (await service.getWordsByMessageKeys([second.key, first.key]))
        .map(word => `${word.messageKey}:${word.index}`),
      [`${second.key}:0`, `${first.key}:0`, `${first.key}:1`],
    )

    await service.retainMessages('w-repeat:1', [first.key, 'missing', first.key])
    await service.retainMessages('w-repeat:1', [first.key])
    assert.deepEqual(await ctx.database.get('w-message-reference', {}), [{
      owner: 'w-repeat:1',
      messageKey: first.key,
    }])

    assert.equal(await service.gc(), 1)
    assert.deepEqual(
      (await ctx.database.get('w-message-v2', {})).map(message => message.key),
      [first.key],
    )
    assert.equal(await service.releaseMessages('w-repeat:1'), 1)
    assert.equal(await service.gc(), 1)
    assert.deepEqual(await ctx.database.get('w-message-v2', {}), [])
    assert.deepEqual(await ctx.database.get('w-message-word-v2', {}), [])
  })
})
