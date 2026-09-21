import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatCompactNumber } from '../shared/utils'

describe('formatCompactNumber', () => {
  it('keeps small values intact', () => {
    assert.equal(formatCompactNumber(0), '0')
    assert.equal(formatCompactNumber(999), '999')
  })

  it('uses short metric suffixes for large values', () => {
    assert.equal(formatCompactNumber(1_000), '1k')
    assert.equal(formatCompactNumber(1_234), '1.2k')
    assert.equal(formatCompactNumber(24_124), '24k')
    assert.equal(formatCompactNumber(999_999), '1m')
    assert.equal(formatCompactNumber(1_250_000), '1.3m')
  })
})
