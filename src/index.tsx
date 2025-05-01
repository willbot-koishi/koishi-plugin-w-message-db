import { Context, z, SessionError, h, Service, Query, Session, $ } from 'koishi'

import dayjs from 'dayjs'
import { divide, stripUndefined } from './utils'

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

  checkInGuild(session: Session) {
    if (! session.guildId)
      throw new SessionError('message-db.error.guild-only')
  }

  checkTracked({ guildId }: Session) {
    if (! this.config.trackedGuilds.some(it => it.id === guildId))
      throw new SessionError('message-db.error.guild-not-tracked')
  }

  checkNotReadonly() {
    if (this.config.readonly)
      throw new SessionError('message-db.error.readonly')
  }

  validateUid(uid: string | undefined, platform?: string) {
    if (! uid) return undefined
    const [ userPlatform, userId ] = uid.split(':')
    if (platform && userPlatform !== platform)
      throw new SessionError('message-db.error.user-not-same-platform', [ uid ])
    return userId
  }

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
    })

    const saveMessage = async (session: Session) => {
      // Check readonly mode.
      if (config.readonly) return

      // Ignore non-guild messages.
      const { guildId } = session
      if (! session.guildId) return

      // Ignore messages from untracked guilds.
      if (! config.trackedGuilds.some(it => it.id === guildId)) return

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

      return
    }

    ctx.on('message', saveMessage)
    ctx.on('send', saveMessage)

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
        this.checkInGuild(session)
        this.checkTracked(session)

        const { platform, guildId } = session

        const durationQuery = durationToQuery(parseDuration(options.duration ?? ''))

        const userId = this.validateUid(options.user, platform)

        const query: Query<TrackedMessage> = {
          platform,
          guildId,
          userId: userId ?? {},
          content: options.search ? { $regex: options.search } : {},
          ...durationQuery,
        }

        const messages = await ctx.database
          .select('w-message')
          .where(query)
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
              { this.renderMessage(content) }
            </message>)
          }
        </message>
      })

    ctx.command('message-db.fetch-history', 'Fetch message history', { authority: 3 })
      .action(async () => {
        this.checkNotReadonly()

        const startTime = Date.now()
        const result = await this.fetchHistory()
        const endTime = Date.now()

        return <>
          Fetched history of {config.trackedGuilds.length} guilds in {((endTime - startTime) / 1000).toFixed(3)}s.<br />
          {result.okCount} succeeded while {result.errorCount} failed.<br />
          Fetched {result.messageCount} messages in total.
        </>
      })

    ctx.command('message-db.guild', 'Manage tracked guilds', { authority: 4 })

    ctx.command('message-db.guild.list', 'List tracked guilds')
      .action(async () => {
        const { trackedGuilds } = this.config
        if (! trackedGuilds.length)
          return 'No tracked guilds.'

        const countMap = new Map((await this.ctx.database
          .select('w-message')
          .groupBy('guildId', {
            count: row => $.count(row.id)
          })
          .execute()
        ).map(it => [ it.guildId, it.count ]))

        const guilds = trackedGuilds.map(guild => ({
          ...guild,
          messageCount: countMap.get(guild.id) ?? 0,
        }))

        return <message>
          {guilds.length} tracked guilds:<br />
          {
            guilds.map(guild => <>
              { guild.platform }:{ guild.id } @ { guild.managerBotId } * { guild.messageCount } <br />
            </>)
          }
        </message>  
      })

    ctx.command('message-db.guild.track', 'Track current guild')
      .action(({ session }) => {
        this.checkInGuild(session)

        const { platform, guildId } = session

        if (config.trackedGuilds.some(it => it.id === guildId))
          throw new SessionError('message-db.error.guild-already-tracked')

        config.trackedGuilds.push({
          platform,
          id: guildId,
          managerBotId: session.bot.selfId,
        })
        this.ctx.scope.update(config)

        return 'Tracked current guild.'
      })
  }

  async start() {
    await this.fetchHistory()
  }

  async fetchHistory(): Promise<FetchHistoryResult> {
    const results = await Promise.all(this.config.trackedGuilds.map(async (guild): Promise<FetchHistoryGuildResult> => {
      const { platform, id: guildId, managerBotId } = guild
      const bot = this.ctx.bots.find(it => it.platform === platform && it.selfId === managerBotId)
      if (! bot || ! bot.isActive)
        return { guild, type: 'error', error: 'bot-not-available' }
      try {
        const iter = bot.getMessageIter(guildId)
        let count = 0
        for await (const msg of iter) {
          if (msg.id === managerBotId) continue

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
          if (! inserted) break

          if (++ count === this.config.maxFetchHistoryCount)
            return { guild, type: 'ok', count, done: false }
        }

        return { guild, type: 'ok', count, done: true }
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

  renderMessage(content: string) {
    return h.transform(h.parse(content), {
      json: ({ data }) => {
        if (data.includes('[聊天记录]')) return '[聊天记录]'
        return '[]'
      }
    })
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