import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { executeQuery } from 'minato'

import { SavedMessage } from '../src/types'
import {
  createMessageFilterQuery,
  getMessageTypeMask,
  MESSAGE_TYPE_BITS,
} from '../src/query'

const createMessage = (data: Partial<SavedMessage> = {}): SavedMessage => ({
  key: '["discord","guild","message"]',
  id: 'message',
  platform: 'discord',
  guildId: 'guild',
  userId: 'alice',
  username: 'Alice',
  content: 'hello a.b',
  timestamp: 100,
  segmented: false,
  messageTypeMask: MESSAGE_TYPE_BITS.text,
  ...data,
})

const matches = (message: SavedMessage, filter: Parameters<typeof createMessageFilterQuery>[0]) =>
  executeQuery(message, createMessageFilterQuery(filter), '_')

describe('message filters', () => {
  it('matches any selected user within the selected duration', () => {
    assert.equal(matches(createMessage(), {
      userIds: ['alice', 'bob'],
      startTime: 50,
      endTime: 150,
    }), true)
    assert.equal(matches(createMessage({ userId: 'charlie' }), {
      userIds: ['alice', 'bob'],
    }), false)
    assert.equal(matches(createMessage({ timestamp: 200 }), {
      endTime: 150,
    }), false)
    assert.equal(matches(createMessage(), { endTime: 150 }), true)
    assert.equal(matches(createMessage(), { startTime: 50 }), true)
  })

  it('escapes plain keywords and accepts regular expressions', () => {
    assert.equal(matches(createMessage(), { keyword: 'a.b', keywordMode: 'plain' }), true)
    assert.equal(matches(createMessage({ content: 'hello axb' }), {
      keyword: 'a.b',
      keywordMode: 'plain',
    }), false)
    assert.equal(matches(createMessage({ content: 'hello axb' }), {
      keyword: 'a.b',
      keywordMode: 'regex',
    }), true)
    assert.throws(() => createMessageFilterQuery({
      keyword: '[',
      keywordMode: 'regex',
    }), SyntaxError)
  })

  it('matches messages containing any selected content type', () => {
    const message = createMessage({
      content: 'caption<img src="image"/>',
      messageTypeMask: getMessageTypeMask('caption<img src="image"/>'),
    })
    assert.equal(matches(message, { types: ['image'] }), true)
    assert.equal(matches(message, { types: ['text'] }), true)
    assert.equal(matches(message, { types: ['video', 'file'] }), false)
  })
})
