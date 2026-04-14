export type RemainingUsageDisplay = {
  normalizedUsedPercent: number
  remainingPercent: number
  ratio: number
  text: string
}

export function buildRemainingUsageDisplay(
  usedPercent: number,
): RemainingUsageDisplay {
  const normalizedUsedPercent = Math.max(0, Math.min(100, usedPercent))
  const remainingPercent = 100 - normalizedUsedPercent

  return {
    normalizedUsedPercent,
    remainingPercent,
    ratio: remainingPercent / 100,
    text: `${Math.floor(remainingPercent)}% remaining (${Math.floor(normalizedUsedPercent)}% used)`,
  }
}
