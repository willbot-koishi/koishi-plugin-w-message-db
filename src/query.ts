import { h, Query } from 'koishi'

import { MessageFilter, MessageType, SavedMessage } from './types'

export const MESSAGE_TYPE_BITS: Record<MessageType, number> = {
  text: 1,
  image: 2,
  audio: 4,
  video: 8,
  file: 16,
}

const STRUCTURAL_ELEMENTS = new Set(['br', 'figure', 'message', 'p', 'quote'])

export function getMessageTypeMask(content: string) {
  let mask = 0
  const visit = (element: h) => {
    if (element.type === 'image' || element.type === 'img') {
      mask |= MESSAGE_TYPE_BITS.image
    }
    else if (element.type in MESSAGE_TYPE_BITS) {
      mask |= MESSAGE_TYPE_BITS[element.type as MessageType]
    }
    else if (! STRUCTURAL_ELEMENTS.has(element.type)) {
      mask |= MESSAGE_TYPE_BITS.text
    }
    element.children.forEach(visit)
  }
  h.parse(content).forEach(visit)
  return mask
}

export function createMessageFilterQuery(filter: MessageFilter = {}): Query<SavedMessage> {
  const query: Query<SavedMessage> = {}

  if (filter.userIds?.length) {
    if (filter.userIds.length > 1000)
      throw new RangeError('too many users in message filter')
    query.userId = { $in: [...new Set(filter.userIds)] }
  }

  if (filter.startTime !== undefined || filter.endTime !== undefined) {
    if (filter.startTime !== undefined && ! Number.isFinite(filter.startTime))
      throw new TypeError('invalid message filter start time')
    if (filter.endTime !== undefined && ! Number.isFinite(filter.endTime))
      throw new TypeError('invalid message filter end time')
    if (
      filter.startTime !== undefined &&
      filter.endTime !== undefined &&
      filter.startTime > filter.endTime
    ) throw new RangeError('message filter ends before it starts')
    query.timestamp = {}
    if (filter.startTime !== undefined) query.timestamp.$gte = filter.startTime
    if (filter.endTime !== undefined) query.timestamp.$lte = filter.endTime
  }

  const keyword = filter.keyword?.trim()
  if (keyword) {
    if (keyword.length > 256) throw new RangeError('message filter keyword is too long')
    const pattern = filter.keywordMode === 'regex'
      ? keyword
      : keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (filter.keywordMode === 'regex') new RegExp(pattern)
    query.content = { $regex: pattern }
  }

  if (filter.types?.length) {
    const mask = [...new Set(filter.types)]
      .reduce((result, type) => result | (MESSAGE_TYPE_BITS[type] ?? 0), 0)
    if (mask) query.messageTypeMask = { $bitsAnySet: mask }
  }

  return query
}
