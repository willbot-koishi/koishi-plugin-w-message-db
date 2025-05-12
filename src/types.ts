import type { DataService } from '@koishijs/plugin-console'

import type { EChartsOption } from 'echarts'

import { MdbService } from '.'
import { Duration } from '../shared/utils'

export type { MdbService }

export type MdbRemoteMethod =
  | 'stats'
  | 'statsGuilds' | 'statsGuildsChart'
  | 'statsMembers' | 'statsMembersChart'
  | 'statsTime' | 'statsTimeChart'
  | 'getMessages'
  | 'getGuildMembers'

export type MdbRemoteError =
  | { error: 'internal' }
  | { error: 'require-guild-member' }

export type MdbEvents = {
  [M in MdbRemoteMethod as `message-db/${M}`]:
    MdbService[M] extends () => any
      ? () => Promise<Awaited<ReturnType<MdbService[M]>> | MdbRemoteError>
      : (param: Omit<Parameters<MdbService[M]>[0], 'i18n'>) => Promise<Awaited<ReturnType<MdbService[M]>> | MdbRemoteError>
}

export type MdbProvider = DataService<MdbProviderData>

export interface SavedGuild {
  platform: string
  guildId: string
  name: string
  managerBotId: string
  isTracked: boolean
}

export type TrackedGuild = SavedGuild & { isTracked: true }

export interface SavedMessage {
  id: string
  platform: string
  guildId: string
  userId: string
  username: string
  content: string
  timestamp: number
}

export interface GuildQuery {
  platform: string
  guildId: string
}

export interface UserQuery {
  userId: string
}

export interface DurationQuery {
  timestamp?: {
    $gte?: number
    $lte?: number
  }
}

export interface FetchHistoryOptions {
  duration: Duration
  stopOnOld?: boolean
  maxCount?: number
}

export interface FetchHistoryResult {
  results: FetchHistoryGuildResult[]
  errorCount: number
  okCount: number
  messageCount: number
}

export type FetchHistoryGuildResult =
  | { guild: SavedGuild, type: 'error', error: 'bot-not-available' }
  | { guild: SavedGuild, type: 'error', error: 'internal-error', internal: any }
  | { guild: SavedGuild, type: 'ok', inserted: number, exit: 'reached-max' | 'exhausted' | 'done' }

export interface MdbStats {
  messageCount: number
  guildCount: number
  trackedGuildCount: number
  tableSize: number
}

export type MdbStatsGuilds = Array<{
  gid: string
  name: string
  value: number
}>

export type MdbStatsMembersOption = {
  guildQuery: GuildQuery
  durationQuery?: DurationQuery
}

export type MdbStatsMembers = Array<{
  userId: string
  name: string
  value: number
}>

export type MdbStatsTimeOption = {
  guildQuery?: GuildQuery
  userQuery?: UserQuery
}

export type MdbStatsTime = {
  timeData: Array<{
    count: number
    hour: number
    weekday: number
  }>
  guild: SavedGuild
}

export type GetMessageOption = {
  guildQuery: GuildQuery
  userQuery?: UserQuery
  durationQuery?: DurationQuery
  limit?: number
  page?: number
}

export type GetGuildMembersOption = {
  guildQuery: GuildQuery
}

export type UniversalI18n = {
  text: (key: string, param?: Record<string, any>) => string 
}

export interface MdbChart<T = any> {
  option: EChartsOption
  data?: T
}

export interface MdbChartOption {
  i18n: UniversalI18n
  withData?: boolean
  isStatic?: boolean
}

export interface MdbProviderData {
  config: MdbService.Config
  savedGuilds: SavedGuild[]
  trackedGuilds: TrackedGuild[]
}