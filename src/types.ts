import { EChartsOption } from 'echarts'
import { MessageDbService, MessageDbProvider } from '.'
import { Duration } from '../shared/utils'

export type { MessageDbService, MessageDbProvider }

declare module 'koishi' {
  interface Tables {
    'w-message': TrackedMessage
  }

  interface Context {
    messageDb: MessageDbService
  }
}

declare module '@koishijs/plugin-console' {
  interface Events {
    'message-db/stats': () => Promise<MessageDbStats>
    'message-db/stats/guilds': () => Promise<MessageDbStatsGuilds>
    'message-db/stats/guilds/chart': (locales: string[]) => Promise<MessageDbChart<MessageDbStatsGuilds>>
    'message-db/stats/members': (guildQuery: GuildQuery) => Promise<MessageDbStatsMembers>
    'message-db/stats/members/chart': (locales: string[], args: { guildQuery: GuildQuery }) => Promise<MessageDbChart<MessageDbStatsMembers>>
  }

  namespace Console {
    interface Services {
      messageDb: MessageDbProvider
    }
  }
}

export interface TrackedGuild {
  platform: string
  id: string
  managerBotId: string
}

export interface TrackedMessage {
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
  | { guild: TrackedGuild, type: 'error', error: 'bot-not-available' }
  | { guild: TrackedGuild, type: 'error', error: 'internal-error', internal: any }
  | { guild: TrackedGuild, type: 'ok', inserted: number, exit: 'reached-max' | 'exhausted' | 'done' }

export interface MessageDbStats {
  messageTotal: number
  trackedGuildsCount: number
  guildTotal: number
  tableSize: number
}

export type MessageDbStatsGuilds = Array<{
  gid: string
  name: string
  value: number
}>

export type MessageDbStatsMembers = Array<{
  userId: string
  name: string
  value: number
}>

export type UniversalI18n = {
  text: (key: string, args?: Record<string, any>) => string 
}

export interface MessageDbChart<T = any> {
  option: EChartsOption
  data?: T
}

export interface MessageDbChartOptions {
  i18n: UniversalI18n,
  withData?: boolean,
  isStatic?: boolean,
}