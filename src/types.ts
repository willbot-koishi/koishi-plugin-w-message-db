import type { EChartsOption } from 'echarts'

import { MdbService } from '.'
import { Duration } from '../shared/utils'
import { DataService } from '@koishijs/plugin-console'

export type { MdbService }

declare module 'koishi' {
  interface Tables {
    'w-message': SavedMessage
    'w-message-guild': SavedGuild
  }

  interface Context {
    messageDb: MdbService
  }
}

declare module '@koishijs/plugin-console' {
  interface Events {
    'message-db/stats': () => Promise<MdbStats>
    'message-db/stats/guilds': () => Promise<MdbStatsGuilds>
    'message-db/stats/guilds/chart': (locales: string[]) => Promise<MdbChart<MdbStatsGuilds>>
    'message-db/stats/members': (args: MdbStatsMembersOption) => Promise<MdbStatsMembers>
    'message-db/stats/members/chart': (locales: string[], args: MdbStatsMembersOption) => Promise<MdbChart<MdbStatsMembers>>
    'message-db/stats/time': (args: MdbStatsTimeOption) => Promise<MdbStatsTime>
    'message-db/stats/time/chart': (locales: string[], args: MdbStatsTimeOption) => Promise<MdbChart<MdbStatsTime>>
  }

  namespace Console {
    interface Services {
      messageDb: MdbProvider
    }
  }
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

export type UniversalI18n = {
  text: (key: string, args?: Record<string, any>) => string 
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