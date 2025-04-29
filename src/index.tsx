import { Context, z, SessionError, h, Service, Awaitable } from 'koishi'

import dayjs from 'dayjs'
import { divide, stripUndefined } from './utils'
import { Message } from '@satorijs/protocol'

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

declare module 'koishi' {
  interface Tables {
    'w-message': TrackedMessage
  }

  interface Context {
    messageDb: MessageDbService
  }
}

interface Duration {
  start: number | null
  end: number | null
}

const parseDate = (dateStr: string): number | null => {
  if (! dateStr) return null
  const date = dayjs(dateStr)

  if (! date.isValid())
    throw new SessionError('message-db.error.duration.invalid-date', [ dateStr ])

  return date.valueOf()
}

const parseDuration = (durationStr: string): Duration => {
  const [ start, end ] = durationStr
    .split(/~(?!.*~)/)
    .map(str => parseDate(str.trim()))

  if (start && end && start >= end)
    throw new SessionError('message-db.error.duration.end-before-start')

  return { start, end }
}

const durationToQuery = ({ start, end }: Duration) => {
  return {
    timestamp: stripUndefined({
      $gte: start ?? undefined,
      $lte: end ?? undefined,
    })
  }
}

export type FetchHistoryResult = {
  results: FetchHistoryGuildResult[]
  errorCount: number
  okCount: number
  messageCount: number
}

export type FetchHistoryGuildResult =
  | { guild: TrackedGuild, type: 'error', error: 'bot-not-available' }
  | { guild: TrackedGuild, type: 'error', error: 'internal-error', internal: any }
  | { guild: TrackedGuild, type: 'ok', count: number, done: boolean }

class MessageDbService extends Service {
  static inject = [ 'database' ]

  logger = this.ctx.logger('w-message-db')

  constructor(ctx: Context, public config: MessageDbService.Config) {
    super(ctx, 'messageDb')

    ctx.model.extend('w-message', {
      id: 'string',
      platform: 'string',
      guildId: 'string',
      userId: 'string',
      username: 'string',
      content: 'text',
      timestamp: 'unsigned',
    }, {
      primary: 'id',
      autoInc: true,
    })

    ctx.middleware(async (session, next) => {
      // Check readonly mode.
      if (config.readonly) return next()

      // Ignore non-guild messages.
      const { guildId } = session
      if (! session.guildId) return next()

      // Ignore messages from untracked guilds.
      if (! config.trackedGuilds.some(it => it.id === guildId)) return next()

      // Save message.
      const { platform, userId, username, content, timestamp, messageId } = session
      const message: TrackedMessage = {
        id: messageId,
        platform,
        guildId,
        userId,
        username,
        content,
        timestamp
      }
      await ctx.database.upsert('w-message', [ message ])
    })

    ctx.command('message-db', 'Message database')
      .alias('mdb')

    ctx.command('message-db.list', 'List messages')
      .option('guild', '-g <guild:channel> Guild ID to filter messages', { authority: 4 })
      .option('duration', '-d <duration:string> Duration to filter messages')
      .option('user', '-u <user:user> User ID to filter messages')
      .option('page', '-p <page:number> Page number to display', { fallback: 1 })
      .option('withTime', '-t, --with-time Show message timestamps', { fallback: false })
      .option('search', '-s <regexp:string> Search for messages')
      .action(async ({ options, session }) => {
        const { platform, guildId } = session
        if (! guildId)
          return 'Please call this command in a guild.'
        if (! config.trackedGuilds.some(it => it.id === guildId))
          return 'This guild is not tracked.'

        const durationQuery = durationToQuery(parseDuration(options.duration ?? ''))

        const messages = await ctx.database
          .select('w-message')
          .where({
            platform,
            guildId,
            userId: options.user ?? {},
            content: options.search ? { $regex: options.search } : {},
            ...durationQuery,
          })
          .orderBy('timestamp', 'desc')
          .offset((options.page - 1) * config.pageSize)
          .limit(config.pageSize)
          .execute()

        if (! messages.length)
          return 'No messages found.'

        messages.reverse()

        return <message forward>
          <message>
            Found {messages.length} messages. (Page {options.page})
          </message>
          {
            messages.map(({ username, timestamp, content }) => <message>
              <b>{ username }{ options.withTime ? ` [${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}]` : '' }:</b>
              <br />
              { h.parse(content) }
            </message>)
          }
        </message>
      })

    ctx.command('message-db.fetch-history', 'Fetch message history', { authority: 3 })
      .action(async () => {
        if (config.readonly)
          return 'Message database is in readonly mode.'

        const startTime = Date.now()
        const result = await this.fetchHistory()
        const endTime = Date.now()

        return <>
          Fetched history of {config.trackedGuilds.length} guilds in {((endTime - startTime) / 1000).toFixed(3)}s.<br />
          {result.okCount} succeeded while {result.errorCount} failed.<br />
          Fetched {result.messageCount} messages in total.
        </>
      })
  }

  async start() {
    await this.fetchHistory()
  }

  async fetchHistory(): Promise<FetchHistoryResult> {
    const results = await Promise.all(this.config.trackedGuilds.map(async (guild): Promise<FetchHistoryGuildResult> => {
      const { platform, id: guildId, managerBotId } = guild
      const bot = this.ctx.bots.find(it => it.platform === platform && it.selfId === managerBotId)
      if (! bot || ! bot.isActive) return { guild, type: 'error', error: 'bot-not-available' }
      try {
        const iter = bot.getMessageIter(guildId)
        let count = 0
        for await (const msg of iter) {
          if (msg.id === managerBotId) continue

          count ++

          const message = ({
            id: msg.id,
            platform,
            guildId,
            userId: msg.user.id,
            username: msg.user.nick || msg.user.name,
            content: msg.content,
            timestamp: msg.timestamp,
          })

          const { inserted } = await this.ctx.database.upsert('w-message', [ message ])
          if (! inserted)
            return { guild, type: 'ok', count, done: true }

          if (count === this.config.maxFetchHistoryCount)
            return { guild, type: 'ok', count, done: false }
        }
      }
      catch (err) {
        this.logger.error(err)
        return { guild, type: 'error', error: 'internal-error', internal: err }
      }
    }))

    const [ errors, oks ] = divide(results, it => it.type === 'error')
    const result: FetchHistoryResult = {
      results,
      errorCount: errors.length,
      okCount: oks.length,
      messageCount: oks.reduce((acc, { count }) => acc + count, 0),
    }

    this.logger.info(`Fetch message history in ${results.length} guilds:\n${
      results
        .map(result => {
          const { guild, type } = result
          return `  - ${guild.platform}:${guild.id} @ ${guild.managerBotId}: ${
            type === 'ok' ? `√ (fetched ${result.count} messages)` : `× (${result.error})`
          }`
        })
        .join('\n')
    }`)

    return result
  }
}

namespace MessageDbService {
  export interface Config {
    readonly: boolean
    trackedGuilds: TrackedGuild[]
    pageSize: number
    maxFetchHistoryCount: number
  }

  export const Config: z<Config> = z.object({
    readonly: z
      .boolean()
      .default(false)
      .description('Whether to save messages to the database.'),
    trackedGuilds: z
      .array(z.object({
        platform: z.string().description('Platform name.'),
        id: z.string().description('Guild ID.'),
        managerBotId: z.string().description('Manager bot ID.'), 
      }))
      .description('List of guilds to track messages.'),
    pageSize: z
      .natural()
      .default(30)
      .description('Number of messages to display per page.'),
    maxFetchHistoryCount: z
      .natural()
      .default(100)
      .description('Maximum number of history messages to fetch in one go.'),
  })
}

export default MessageDbService