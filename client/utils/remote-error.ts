import type { MdbRemoteError } from '../../src/types'

export function normalizeRemoteError(error: unknown): MdbRemoteError {
  if (error === 'unauthorized') return { error: 'authentication-required' }
  if (error instanceof Error) return { error: 'network' }
  return { error: 'internal' }
}
