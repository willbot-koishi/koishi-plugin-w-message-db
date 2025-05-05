import { Context, z, SessionError, h, Service, Query, Session, $, Tables, Driver, pick } from 'koishi'
import type {} from 'koishi-plugin-cron'
import type { StrictEChartsOption } from 'koishi-plugin-w-echarts'
import type {} from 'koishi-plugin-w-option-conflict'

import dayjs from 'dayjs'

import { divide, formatSize, mapFromList, maxBy, stripUndefined, sumBy } from './utils'

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
  static inject = {
    required: [ 'database', 'cron' ],
    optional: [ 'echarts' ],
  }

  logger = this.ctx.logger('w-message-db')

  private checkECharts() {
    if (! this.ctx.echarts)
      throw new SessionError('message-db.error.echarts-not-loaded')
  }

  private checkInGuild(session: Session) {
    if (! session.guildId)
      throw new SessionError('message-db.error.guild-only')
  }

  isTracked({ platform, guildId }: { platform: string, guildId: string }, force = false) {
    return (! this.config.requireTracking && ! force)
      || this.config.trackedGuilds.some(it => it.platform === platform && it.id === guildId)
  }

  private checkTracked(session: Session) {
    if (! this.isTracked(session))
      throw new SessionError('message-db.error.guild-not-tracked')
  }

  private checkNotReadonly() {
    if (this.config.readonly)
      throw new SessionError('message-db.error.readonly')
  }

  private validateUid(uid: string | undefined, platform?: string) {
    if (! uid) return undefined
    const [ userPlatform, userId ] = uid.split(':')
    if (platform && userPlatform !== platform)
      throw new SessionError('message-db.error.user-not-same-platform', [ uid ])
    return userId
  }

  private queryGuild(
    session: Session,
    options: { global?: boolean, guild?: string }
  ): { platform: string, guildId: string } | undefined {
    if (options.global || ! session.guildId) return undefined
    if (! options.guild) return pick(session, [ 'platform', 'guildId' ])
    const [ platform, guildId ] = options.guild.split(':')
    return { platform, guildId }
  }

  constructor(ctx: Context, public config: MessageDbService.Config) {
    super(ctx, 'messageDb')

    // I18n
    void [ 'zh-CN', 'en-US' ].map((locale: string) => {
      this.ctx.i18n.define(locale, require(`./locales/${locale}.yml`))
    })

    // Define message table.
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

    // Save messages.
    const saveMessage = async (session: Session) => {
      // Check readonly mode.
      if (config.readonly) return

      // Ignore non-guild messages.
      const { guildId } = session
      if (! session.guildId) return

      // Ignore messages from untracked guilds if tracking is required.
      if (config.requireTracking && ! config.trackedGuilds.some(it => it.id === guildId)) return

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

    // Garbage collection.
    if (config.gc.enabled) ctx.cron(config.gc.cron, () => this.gc())

    // Commands.
    ctx.command('message-db')
      .alias('mdb')

    ctx.command('message-db.list')
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

        const [ messages, messageTotal ] = await Promise.all([
          ctx.database
            .select('w-message')
            .where(query)
            .orderBy('timestamp', 'desc')
            .offset((options.page - 1) * config.pageSize)
            .limit(config.pageSize)
            .execute(),
          ctx.database
            .select('w-message')
            .where(query)
            .execute(row => $.count(row.id))
        ])
        const pageTotal = Math.ceil(messageTotal / config.pageSize)

        messages.reverse()

        return <message forward>
          <message>
            {
              session.text('.summary', {
                found: messages.length,
                total: messageTotal,
                page: options.page,
                pageTotal
              })
            }
          </message>
          {
            messages.map(({ username, timestamp, content }) => (
              <message>
                <b>
                  { username }
                  { options.withTime ? ` [${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}]` : '' }:
                </b>
                <br />
                { this.renderMessage(content) }
              </message>
            ))
          }
        </message>
      })

    ctx.command('message-db.fetch-history', { authority: 3 })
      .option('force', '-f Fetch history even if database is readonly')
      .action(async ({ session, options }) => {
        if (! options.force) this.checkNotReadonly()

        const startTime = Date.now()
        const result = await this.fetchHistory()
        const endTime = Date.now()

        return session.text('.summary', {
          guildCount: config.trackedGuilds.length,
          duration: ((endTime - startTime) / 1000).toFixed(3),
          okCount: result.okCount,
          errorCount: result.errorCount,
          messageCount: result.messageCount,
        })
      })

    ctx.command('message-db.gc', { authority: 4 })
      .action(async ({ session }) => {
        const removed = await this.gc()
        if (removed === null)
          return session.text('.disabled')
        return session.text('.summary', { removed })
      })
    
    ctx.command('message-db.stats')
      .action(async ({ session }) => {
        const [ messageTotal, guildTotal, dbStats ] = await Promise.all([
          ctx.database
            .select('w-message')
            .execute(row => $.count(row.id)),
          ctx.database
            .select('w-message')
            .project({ gid: row => $.concat(row.platform, ':', row.guildId) })
            .execute(row => $.count(row.gid)),
          ctx.database.stats()
        ])

        const tablesStats = dbStats.tables as Record<keyof Tables, Driver.TableStats>
        const size = tablesStats['w-message'].size

        return session.text('.summary', {
          messageTotal,
          guildTotal,
          trackedGuilds: this.config.trackedGuilds.length,
          dbSize: formatSize(size),
          gcStatus: this.config.gc.enabled
            ? `${session.text('.gc.enabled')} (${[
              this.config.gc.cron,
              `>= ${this.config.gc.olderThan}${session.text('.gc.day')}`,
              session.text(this.config.gc.untrackedOnly ? '.gc.untracked' : '.gc.all')
            ].join(', ')})`
            : session.text('.gc.disabled'),
        })
      })

    ctx.command('message-db.stats.guilds')
      .action(async ({ session }) => {
        this.checkECharts()

        const [ data, guildMap ] = await Promise.all([
          ctx.database
            .select('w-message')
            .groupBy([ 'platform', 'guildId' ], {
              count: row => $.count(row.id),
            })
            .orderBy('count', 'desc')
            .execute(),
          session.bot
            .getGuildList()
            .then(it => mapFromList(it.data, it => it.id)),
        ])

        const eh = this.ctx.echarts.createChart(
          600, 600,
          this.getPieChartOption({
            session,
            data: data.map(({ platform, guildId, count }) => ({
              name: (platform === session.platform
                ? guildMap.get(guildId)?.name
                : undefined
              ) ?? `${platform}:${guildId}`,
              value: count,
            }))
          })
        )

        const index = data.findIndex(
          it => it.platform === session.platform && it.guildId === session.guildId
        )
        const rank = index + 1
        const count = data[index].count

        return <>
          { await eh.export() }<br />
          { rank
            ? session.text('.summary', { count, rank })
            : session.text('.untracked')
          }
        </>
      })

    ctx.command('message-db.stats.members')
      .action(async ({ session }) => {
        this.checkECharts()
        this.checkInGuild(session)

        const { platform, guildId } = session
        const [ data, memberMap ] = await Promise.all([
          ctx.database
            .select('w-message')
            .where({ platform, guildId })
            .groupBy('userId', {
              count: row => $.count(row.id),
            })
            .orderBy('count', 'desc')
            .execute(),
          session.bot
            .getGuildMemberList(guildId)
            .then(it => mapFromList(it.data, it => it.user.id)),
        ])

        const eh = this.ctx.echarts.createChart(
          600, 600,
          this.getPieChartOption({
            session,
            data: data.map(({ userId, count }) => {
              const member = memberMap.get(userId)
              return {
                name: (platform === session.platform
                  ? member?.nick || member?.user.name
                  : undefined
                ) ?? `${platform}:${userId}`,
                value: count,
              }
            })
          })
        )

        return <>
          { await eh.export() }
        </>
      })

    ctx.command('message-db.stats.time')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .action(async ({ session, options }) => {
        this.checkECharts()

        const guildQuery = this.queryGuild(session, options)

        const [ data, guild ] = await Promise.all([
          ctx.database
            .select('w-message')
            .where({ ...guildQuery })
            .project({
              id: row => row.id,
              hour: row => $.mod(
                $.sub(
                  $.round($.div(row.timestamp, 60 * 60 * 1000)),
                  (ctx.root.config.timezoneOffset as number) / 60
                ),
                24
              ),
              weekday: row => $.mod(
                $.add(
                  $.round($.div(row.timestamp, 24 * 60 * 60 * 1000)),
                  3
                ),
                7
              ),
            })
            .groupBy([ 'weekday', 'hour' ], {
              count: row => $.count(row.id),
            })
            .execute(),
          guildQuery
            ? session.bot.getGuild(guildQuery.guildId)
            : undefined,
        ])

        const eh = this.ctx.echarts.createChart(24 * 30 + 100, 7 * 30 + 120, {
          title: {
            text: guildQuery
              ? session.text('.title-guild', { name: guild.name })
              : session.text('.title-global'),
            left: 'center',
            top: '5%',
            textStyle: {
              fontSize: 24,
            },
          },
          xAxis: {
            type: 'category',
            data: Array.from({ length: 24 }).map((_, i) => i.toString().padStart(2, '0')),
          },
          yAxis: {
            type: 'category',
            data: [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ],
          },
          visualMap: {
            min: 0,
            max: maxBy(data, it => it.count),
            calculable: true,
            show: false
          },
          series: {
            type: 'heatmap',
            silent: true,
            label: { show: true },
            data: data.map(it => [ it.hour, it.weekday, it.count ]),
          },
          backgroundColor: '#fff'
        })

        return eh.export()
      })

    ctx.command('message-db.guild', { authority: 4 })

    ctx.command('message-db.guild.list-tracked')
      .action(async ({ session }) => {
        const { trackedGuilds } = this.config
        if (! trackedGuilds.length)
          return session.text('.no-tracked-guilds')

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

        return session.text('.summary', {
          count: guilds.length,
          list: guilds
            .map(guild => `${guild.platform}:${guild.id} @ ${guild.managerBotId} * ${guild.messageCount}`)
            .join('\n')
        })
      })

    ctx.command('message-db.guild.track')
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

        return session.text('.guild-tracked')
      })
  }

  async start() {
    // Fetch message history of tracked guilds on start.
    if (! this.config.readonly)
      await this.fetchHistory()
  }

  async gc(): Promise<number | null> {
    if (! this.config.gc.enabled) return null

    const { olderThan, untrackedOnly } = this.config.gc
    const minTime = Date.now() - olderThan * 24 * 60 * 60 * 1000

    const { removed } = await this.ctx.database.remove('w-message', row => $.and(
      $.lt(row.timestamp, minTime),
      untrackedOnly
        ? $.not(
          $.in(
            $.concat(row.platform, ':', row.guildId),
            this.config.trackedGuilds.map(it => `${it.platform}:${it.id}`)
          )
        )
        : true,
    ))

    this.logger.info('collected %d messages', removed)

    return removed
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
          if (! msg.content) continue

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

          if (++ count === this.config.maxHistoryFetchingCount)
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

  private renderMessage(content: string) {
    // TODO: Better message rendering.
    return h.transform(h.parse(content), {
      json: ({ data }) => {
        if (data.includes('[聊天记录]')) return '[聊天记录]'
        return '[]'
      }
    })
  }

  private getPieChartOption({ session, data }: {
    session: Session
    data: { name: string, value: number }[]
  }): StrictEChartsOption {
    const total = sumBy(data, it => it.value)
    const threshold = total * 0.01
    const [ majors, minors ] = divide(data, it => it.value > threshold)
    const other = {
      name: session.text('message-db.misc.other'),
      value: sumBy(minors, it => it.value)
    }
    data = majors
    if (other.value > 0) data.push(other)

    return {
      title: {
        text: session.text('.title'),
        left: 'center',
        top: '5%',
        textStyle: {
          fontSize: 24,
        },
      },
      backgroundColor: '#fff',
      series: {
        type: 'pie',
        width: '100%',
        height: '100%',
        left: 'center',
        top: '5%',
        radius: '60%',
        data,
        label: {
          formatter: (params) => `${params.name}: ${params.value}`,
          overflow: 'breakAll',
        },
      },
    }
  }
}

interface MessageGcConfig {
  enabled: boolean
  olderThan: number
  cron: string
  untrackedOnly: boolean
}

namespace MessageDbService {
  export interface Config {
    readonly: boolean
    trackedGuilds: TrackedGuild[]
    requireTracking: boolean
    pageSize: number
    maxHistoryFetchingCount: number
    gc: MessageGcConfig
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
    requireTracking: z
      .boolean()
      .default(false)
      .description('Whether to require tracking guilds.'),
    pageSize: z
      .natural()
      .default(30)
      .description('Number of messages to display per page.'),
    maxHistoryFetchingCount: z
      .natural()
      .default(100)
      .description('Maximum number of history messages to fetch in one go.'),
    gc: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .description('Whether to enable message garbage collection.'),
        cron: z
          .string()
          .default('0 0 * * *')
          .description('Cron expression for garbage collection.'),
        olderThan: z
          .number()
          .default(3)
          .description('Number of days to keep messages.'),
        untrackedOnly: z
          .boolean()
          .default(false)
          .description('Whether to only delete untracked messages.'),
      })
      .description('Garbage collection'),
  })
}

export default MessageDbService