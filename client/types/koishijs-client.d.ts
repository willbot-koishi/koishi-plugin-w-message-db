import type { Component } from 'vue'

import type { MdbEvents, MdbProviderData } from '../../src/types'

// Keep vue-tsc scoped to this plugin instead of checking @koishijs/client's
// published Vue/TypeScript sources and reporting their diagnostics as ours.
export interface Context {
  page(options: {
    name: string
    path: string
    fields?: Array<keyof Store>
    component: Component
  }): () => void
}

export interface Store {
  messageDb: MdbProviderData
}

export const store: Store

export function send<T extends keyof MdbEvents>(
  type: T,
  ...args: Parameters<MdbEvents[T]>
): ReturnType<MdbEvents[T]>
