import { h } from 'koishi'

import { MessageType } from './types'

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
