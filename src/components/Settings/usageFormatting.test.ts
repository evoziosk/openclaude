import { expect, test } from 'bun:test'

import { buildRemainingUsageDisplay } from './usageFormatting.js'

test('buildRemainingUsageDisplay reports remaining-first text and ratio', () => {
  const display = buildRemainingUsageDisplay(37.9)

  expect(display.normalizedUsedPercent).toBe(37.9)
  expect(display.remainingPercent).toBe(62.1)
  expect(display.ratio).toBe(0.621)
  expect(display.text).toBe('62% remaining (37% used)')
})

test('buildRemainingUsageDisplay clamps below zero', () => {
  const display = buildRemainingUsageDisplay(-8)

  expect(display.normalizedUsedPercent).toBe(0)
  expect(display.remainingPercent).toBe(100)
  expect(display.ratio).toBe(1)
  expect(display.text).toBe('100% remaining (0% used)')
})

test('buildRemainingUsageDisplay clamps above one hundred', () => {
  const display = buildRemainingUsageDisplay(145.2)

  expect(display.normalizedUsedPercent).toBe(100)
  expect(display.remainingPercent).toBe(0)
  expect(display.ratio).toBe(0)
  expect(display.text).toBe('0% remaining (100% used)')
})
