import { SessionError } from 'koishi'

import dayjs from 'dayjs'
import { GuildQuery } from '../src/types'

export const stripUndefined = <T extends object>(obj: T): T => {
  for (const key in obj)
    if (obj[key] === undefined)
      delete obj[key]
  
  return obj
}

interface Divide {
  <T, U extends T>(arr: T[], pred: (it: T) => it is U): [ U[], Exclude<T, U>[] ]
  <T>(arr: T[], pred: (it: T) => boolean): [ T[], T[] ]
}
export const divide = (<T>(arr: T[], pred: (it: T) => boolean): [ T[], T[] ] => {
  const trueArr: T[] = []
  const falseArr: T[] = []
  for (const it of arr)
    if (pred(it))
      trueArr.push(it)
    else
      falseArr.push(it)
  return [ trueArr, falseArr ]
}) as Divide

export const sumBy = <T>(arr: T[], getValue: (it: T) => number) =>
  arr.reduce((acc, it) => acc + getValue(it), 0)

export const maxBy = <T>(arr: T[], getValue: (it: T) => number) =>
  Math.max(...arr.map(getValue))
export const minBy = <T>(arr: T[], getValue: (it: T) => number) =>
  Math.min(...arr.map(getValue))

export const formatSize = (size: number) => {
  const units = [ 'B', 'KB', 'MB', 'GB' ]
  while (true) {
    const unit = units.shift()
    if (size < 1024 || ! units.length) return `${size.toFixed(2)} ${unit}`
    size /= 1024
  }
}

export const mapFrom = <T, K, V = T>(
  arr: T[],
  getKey: <U extends T>(item: U) => K,
  getValue?: <U extends T>(item: U) => V
) =>
  new Map(arr.map(it => [ getKey(it), getValue?.(it) ?? it ]))

export interface Duration {
  start: number | null
  end: number | null
}

export const parseDate = (dateStr: string): number | null => {
  if (! dateStr) return null
  const date = dayjs(dateStr)

  if (! date.isValid())
    throw new SessionError('message-db.error.duration.invalid-date', [ dateStr ])

  return date.valueOf()
}

export const parseDuration = (durationStr: string = ''): Duration => {
  const [ start, end ] = durationStr
    .split(/~(?!.*~)/)
    .map(str => parseDate(str.trim()))

  if (start && end && start >= end)
    throw new SessionError('message-db.error.duration.end-before-start')

  return { start, end }
}

export const getGid = ({ platform, guildId }: GuildQuery) =>
  `${platform}:${guildId}`
