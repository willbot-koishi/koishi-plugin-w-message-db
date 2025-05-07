import { resolve } from 'node:path'

import {
  Context, SessionError, Service, Session, Bot,
  Query, Tables, Driver,
  pick, z, h, $,
} from 'koishi'
import type {} from 'koishi-plugin-cron'
import { DataService } from '@koishijs/plugin-console'
import type { StrictEChartsOption } from 'koishi-plugin-w-echarts'
import type {} from 'koishi-plugin-w-option-conflict'
import type { NapCatBot } from 'koishi-plugin-adapter-napcat'

import dayjs from 'dayjs'

import {
  divide, formatSize, mapFromList, maxBy, stripUndefined, sumBy,
  Duration, parseDuration
} from '../shared/utils'
import {
  TrackedMessage, TrackedGuild,
  MessageDbStats, MessageDbStatsGuilds, FetchHistoryOptions, FetchHistoryResult, FetchHistoryGuildResult,
  MessageDbChart,
  UniversalI18n,
  MessageDbChartOptions,
  MessageDbStatsMembers,
  GuildQuery,
} from './types'

export class MessageDbService extends Service {
  static inject = {
    required: [ 'database', 'cron', 'console' ],
    optional: [ 'echarts' ],
  }

  logger = this.ctx.logger('w-message-db')

  private launchTime: number

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

    // Extend console.
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../../dist'),
    })
    // Provide data to console.
    ctx.plugin(MessageDbProvider, {
      getConfig: () => this.config,
    })
    // Handle console events.
    type ChartMethod = 'statsGuildsChart' | 'statsMembersChart'
    const handleChart = <M extends ChartMethod>(method: M) => (locales: string[], args?: any) => this[method]({
      i18n: this.createI18n(locales),
      isStatic: false,
      withData: false,
      ...args,
    }) as ReturnType<MessageDbService[M]>

    ctx.console.addListener('message-db/stats', () => this.stats())
    ctx.console.addListener('message-db/stats/guilds', () => this.statsGuilds())
    ctx.console.addListener('message-db/stats/guilds/chart', handleChart('statsGuildsChart'))
    ctx.console.addListener('message-db/stats/members', (guildQuery: GuildQuery) => this.statsMembers(guildQuery))
    ctx.console.addListener('message-db/stats/members/chart', handleChart('statsMembersChart'))

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

    this.launchTime = Date.now()
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

        const durationQuery = this.queryDuration(parseDuration(options.duration))

        const userId = this.validateUid(options.user, platform)

        const query: Query<TrackedMessage> = {
          platform,
          guildId,
          userId: userId ?? {},
          content: options.search
            ? { $regex: options.search }
            : {},
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

    ctx.command('message-db.fetch-history [duration:string]', { authority: 3 })
      .option('force', '-f Fetch history even if database is readonly')
      .option('maxCount', '-m <count:posint> Maximum number of messages to fetch')
      .action(async ({ session, options }, duration) => {
        if (! options.force) this.checkNotReadonly()

        const startTime = Date.now()
        const result = await this.fetchHistory({
          duration: parseDuration(duration),
          stopOnOld: false,
          maxCount: options.maxCount,
        })
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
        const {
          messageTotal, guildTotal, trackedGuildsCount, tableSize
        } = await this.stats()

        return session.text('.summary', {
          messageTotal,
          guildTotal,
          trackedGuilds: trackedGuildsCount,
          dbSize: formatSize(tableSize),
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

        const guildStats = await this.statsGuilds()

        const eh = this.ctx.echarts.createChart(
          600, 600,
          await this.statsGuildsChart({ i18n: session }).then(it => it.option)
        )

        let rankMessage = ''
        if (session.guildId) {
          const index = guildStats.findIndex(
            it => it.gid === `${session.platform}:${session.guildId}`
          )
          const rank = index + 1
          const count = guildStats[index].value
          rankMessage = rank
            ? session.text('.summary', { count, rank })
            : session.text('.untracked')
        }

        return <>
          { await eh.export() }
          { rankMessage }
        </>
      })

    ctx.command('message-db.stats.members')
      .action(async ({ session }) => {
        this.checkECharts()
        this.checkInGuild(session)

        const eh = this.ctx.echarts.createChart(
          600, 600,
          await this
            .statsMembersChart({ i18n: session, guildQuery: session })
            .then(it => it.option)
        )

        return eh.export()
      })

    ctx.command('message-db.stats.time')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .option('user', '-u <user:user>')
      .action(async ({ session, options }) => {
        this.checkECharts()

        const guildQuery = this.queryGuild(session, options)
        const userQuery = options.user
          ? { userId: this.validateUid(options.user, session.platform) }
          : undefined

        const timezoneOffset = (ctx.root.config.timezoneOffset as number) * 60 * 1000

        const [ data, guild ] = await Promise.all([
          ctx.database
            .select('w-message')
            .where({
              ...guildQuery,
              ...userQuery,
            })
            .project({
              id: row => row.id,
              hour: row => $.mod(
                $.floor($.div($.sub(row.timestamp, timezoneOffset), 60 * 60 * 1000)),
                24
              ),
              weekday: row => $.mod(
                $.add(
                  $.floor($.div($.sub(row.timestamp, timezoneOffset), 24 * 60 * 60 * 1000)),
                  4
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

        const countMap = await this.ctx.database
          .select('w-message')
          .groupBy('guildId', {
            count: row => $.count(row.id)
          })
          .execute()
          .then(list => new Map(list.map(it => [ it.guildId, it.count ])))

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
    if (this.config.readonly) return
    await this.fetchHistory({
      duration: {
        start: 0,
        end: this.launchTime,
      }
    })
  }
  
  private checkECharts() {
    if (! this.ctx.echarts)
      throw new SessionError('message-db.error.echarts-not-loaded')
  }

  private checkInGuild(session: Session) {
    if (! session.guildId)
      throw new SessionError('message-db.error.guild-only')
  }

  private checkTracked(guildQuery: GuildQuery) {
    if (! this.isTracked(guildQuery))
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
  ): GuildQuery | undefined {
    if (options.global || ! session.guildId) return undefined
    if (! options.guild) return pick(session, [ 'platform', 'guildId' ])
    const [ platform, guildId ] = options.guild.split(':')
    return { platform, guildId }
  }

  private queryDuration({ start, end }: Duration) {
    return {
      timestamp: stripUndefined({
        $gte: start ?? undefined,
        $lte: end ?? undefined,
      })
    }
  }

  private renderMessage(content: string) {
    // TODO: Better message rendering.
    return h.transform(h.parse(content), {
      json: ({ data }) => {
        if (data.includes('[聊天记录]')) return '[聊天记录]'
        return '[JSON]'
      }
    })
  }

  private getPieChartOption({ title, isStatic = true, i18n, data }: {
    title: string
    isStatic: boolean
    i18n: UniversalI18n
    data: { name: string, value: number }[]
  }): StrictEChartsOption {
    const total = sumBy(data, it => it.value)
    const threshold = total * 0.01
    const [ majors, minors ] = divide(data, it => it.value > threshold)
    const other = {
      name: i18n.text('message-db.chart.other'),
      value: sumBy(minors, it => it.value)
    }
    data = majors
    if (other.value > 0) data.push(other)

    return {
      title: {
        text: i18n.text(`message-db.chart.title.${title}`),
        left: 'center',
        top: '5%',
        textStyle: {
          fontSize: 24,
        },
      },
      backgroundColor: isStatic ? '#fff' : undefined,
      series: {
        type: 'pie',
        width: '100%',
        height: '100%',
        left: 'center',
        top: isStatic ? '5%' : '0',
        radius: '60%',
        data,
        label: {
          formatter: '{b}: {c}',
          overflow: 'breakAll',
          textShadowBlur: isStatic ? undefined : 0,
          color: isStatic ? undefined : '#fff',
        },
      },
    }
  }

  get managerBots() {
    const managerBotIds = this.config.trackedGuilds.map(it => it.managerBotId)
    return this.ctx.bots.filter(it => managerBotIds.includes(it.selfId))
  }

  getManagerBotOf(guildQuery: GuildQuery) {
    const { platform, guildId } = guildQuery
    const { managerBotId } = this.config.trackedGuilds
      .find(it => it.platform === platform && it.id === guildId)
    return this.ctx.bots
      .find(it => it.platform === platform && it.selfId === managerBotId)
  }

  private createI18n(locales: string[]): UniversalI18n {
    return {
      text: (path: string, args?: Record<string, any>) =>
        this.ctx.i18n.render(locales, [ path ], args).map(String).join(''),
    }
  }

  async stats(): Promise<MessageDbStats> {
    const [ messageTotal, guildTotal, dbStats ] = await Promise.all([
      this.ctx.database
        .select('w-message')
        .execute(row => $.count(row.id)),
      this.ctx.database
        .select('w-message')
        .project({ gid: row => $.concat(row.platform, ':', row.guildId) })
        .execute(row => $.count(row.gid)),
      this.ctx.database.stats(),
    ])
    const trackedGuildsCount = this.config.trackedGuilds.length
    const tablesStats = dbStats.tables as Record<keyof Tables, Driver.TableStats>
    const tableSize = tablesStats['w-message'].size

    return {
      messageTotal,
      trackedGuildsCount,
      guildTotal,
      tableSize,
    }
  }

  async statsGuilds(): Promise<MessageDbStatsGuilds> {
    const [ data, guildLists ] = await Promise.all([
      this.ctx.database
        .select('w-message')
        .groupBy([ 'platform', 'guildId' ], {
          count: row => $.count(row.id),
        })
        .orderBy('count', 'desc')
        .execute(),
      Promise.all(this
        .managerBots
        .map(bot => bot
          .getGuildList()
          .then(it => ({
            platform: bot.platform,
            list: it.data,
          }))
        )
      )
    ])

    const guildMap = new Map(
      guildLists.flatMap(({ platform, list }) => list
        .map(guild => [ `${platform}:${guild.id}`, guild ])
      )
    )

    const guildStats = data.map(({ platform, guildId, count }) => {
      const gid = `${platform}:${guildId}`
      return {
        gid,
        name: guildMap.get(gid)?.name ?? gid,
        value: count,
      }
    })

    return guildStats
  }

  async statsGuildsChart({
    i18n,
    withData = false,
    isStatic = true,
  }: MessageDbChartOptions): Promise<MessageDbChart<MessageDbStatsGuilds>> {
    const data = await this.statsGuilds()
    return {
      option: this.getPieChartOption({
        title: 'guilds',
        isStatic,
        i18n,
        data,
      }),
      data: withData ? data : undefined,
    }
  }

  async statsMembers(guildQuery: GuildQuery): Promise<MessageDbStatsMembers> {
    this.checkTracked(guildQuery)

    const [ data, memberList ] = await Promise.all([
      this.ctx.database
        .select('w-message')
        .where(guildQuery)
        .groupBy('userId', {
          count: row => $.count(row.id),
        })
        .orderBy('count', 'desc')
        .execute(),
      this
        .getManagerBotOf(guildQuery)
        .getGuildMemberList(guildQuery.guildId)
        .then(it => it.data)
    ])

    const memberMap = mapFromList(memberList, it => it.user.id)

    const memberStats = data.map(({ userId, count }) => {
      const member = memberMap.get(userId)
      return {
        userId,
        name: member?.nick || member?.user.name || userId,
        value: count,
      }
    })

    return memberStats
  }

  async statsMembersChart({
    guildQuery,
    i18n,
    withData = false,
    isStatic = true,
  }: MessageDbChartOptions & { guildQuery: GuildQuery }): Promise<MessageDbChart<MessageDbStatsMembers>> {
    this.checkTracked(guildQuery)

    const data = await this.statsMembers(guildQuery)
    return {
      option: this.getPieChartOption({
        title: 'members',
        isStatic,
        i18n,
        data,
      }),
      data: withData ? data : undefined,
    }
  }

  /**
   * Check if the guild is tracked.
   * @param platform The platform name
   * @param guildId The guild ID
   * @param force Whether to force the check when `requireTracking` is disabled
   */
  isTracked({ platform, guildId }: GuildQuery, force = false) {
    return (! this.config.requireTracking && ! force)
      || this.config.trackedGuilds.some(it => it.platform === platform && it.id === guildId)
  }

  /**
   * Run garbage collection to remove old messages.
   * @returns The number of removed messages
   */
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

  /**
   * Get an asynchronous message iterator of `guildId` from the `bot`.
   * @param bot The bot
   * @param guildId The guild ID
   * @param startToken The token to start from
   * @param limit The message count limit for each page
   */
  async * getMessageIter(bot: Bot, guildId: string, startToken?: string, limit?: number) {
    let next = startToken
    while (true) {
      const list = await bot.getMessageList(guildId, next, 'before', limit)
      if (! list.data) return

      list.data.reverse()
      yield * list.data

      if (! list.next) return
      next = list.next
    }
  }

  /**
   * Get the start token of the message history before the specified time.
   * @param bot The bot
   * @param time The timestamp to start from
   */
  async getStartTokenBefore(bot: Bot, time: number): Promise<string | undefined> {
    // If the bot is a NapCat bot,
    // we can use the last message ID before the time as the start token.
    if (bot.platform === 'onebot' && (bot.internal as NapCatBot<Context>).isNapCat) {
      const [ message ] = await this.ctx.database
        .select('w-message')
        .where({ timestamp: { $lt: time } })
        .orderBy('timestamp', 'desc')
        .limit(1)
        .execute()
      if (message) return message.id
    }
  }

  /**
   * Fetch message history from all tracked guilds.
   * @param options.duration The duration to fetch messages
   * @param options.stopOnOld Whether to stop fetching when getting an old message
   * @param options.maxCount The maximum number of messages to fetch
   */
  async fetchHistory({
    duration,
    stopOnOld = true,
    maxCount = this.config.historyFetching.maxCount,
  }: FetchHistoryOptions): Promise<FetchHistoryResult> {
    const results = await Promise.all(
      // Fetch message history from all tracked guilds.
      this.config.trackedGuilds.map(async (guild): Promise<FetchHistoryGuildResult> => {
        // Get the manager bot for the guild.
        const { platform, id: guildId, managerBotId } = guild
        const bot = this.ctx.bots.find(it => it.platform === platform && it.selfId === managerBotId)
        // Check if the manager bot is available.
        if (! bot || ! bot.isActive)
          return { guild, type: 'error', error: 'bot-not-available' }

        // We will fetch message history from new to old.
        // If `duration.end` is specified, we will start from the last message before the end;
        // otherwise, we will start from the recent message.
        const startToken = duration.end
          ? await this.getStartTokenBefore(bot, duration.end)
          : undefined

        // Start fetching message history.
        try {
          // Get the asynchronous message iterator from `startToken`.
          const iter = this.getMessageIter(bot, guildId, startToken, this.config.historyFetching.pageSize)
          let count = 0
          let inserted = 0
          for await (const msg of iter) {
            // Fetch no more than `maxCount` messages.
            if (count ++ === maxCount)
              return { guild, type: 'ok', inserted, exit: 'reached-max' }

            // Skip empty messages.
            if (! msg.content) continue

            // Construct the `TrackedMessage` object.
            const { id, content, timestamp } = msg
            const message = ({
              id,
              platform,
              guildId,
              userId: msg.user.id,
              username: msg.user.nick || msg.user.name,
              content,
              timestamp,
            })

            // Try to insert it into the database.
            const { inserted: insertedIt } = await this.ctx.database.upsert('w-message', [ message ])
            inserted += insertedIt

            // The fetching is done if
            // 1. `stopOnOld` is enabled and the message exists in the database;
            // 2. the message is older than the `duration.start`.
            if (
              ! insertedIt && stopOnOld ||
              timestamp < duration.start
            ) return { guild, type: 'ok', inserted, exit: 'done' }
          }

          // 
          return { guild, type: 'ok', inserted, exit: 'exhausted' }
        }
        catch (err) {
          this.logger.error(err)
          return { guild, type: 'error', error: 'internal-error', internal: err }
        }
      })
    )

    // Log the results.
    const [ errors, oks ] = divide(results, it => it.type === 'error')
    const result: FetchHistoryResult = {
      results,
      errorCount: errors.length,
      okCount: oks.length,
      messageCount: oks.reduce((acc, { inserted: count }) => acc + count, 0),
    }

    this.logger.info(`Fetch message history in ${results.length} guilds:\n${
      results
        .map(result => {
          const { guild, type } = result
          return `  - ${guild.platform}:${guild.id} @ ${guild.managerBotId}: ${
            type === 'ok'
              ? `√ (fetched ${result.inserted} messages, ${result.exit})`
              : `× (${result.error})`
          }`
        })
        .join('\n')
    }`)

    return result
  }
}

interface MessageGcConfig {
  enabled: boolean
  olderThan: number
  cron: string
  untrackedOnly: boolean
}

interface HistoryFetchingConfig {
  maxCount: number
  pageSize: number
}

export namespace MessageDbService {
  export interface Config {
    readonly: boolean
    trackedGuilds: TrackedGuild[]
    requireTracking: boolean
    pageSize: number
    historyFetching: HistoryFetchingConfig
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
    historyFetching: z.
      object({
        maxCount: z
          .natural()
          .default(1024)
          .description('Maximum number of history messages to fetch in the whole task.'),
        pageSize: z
          .natural()
          .default(64)
          .description('Number of history messages to fetch in one request.')
      })
      .description('History fetching'),
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

export class MessageDbProvider extends DataService<MessageDbProvider.Data> {
  constructor(ctx: Context, public config: MessageDbProvider.Config) {
    super(ctx, 'messageDb')
  }

  async get() {
    return {
      config: this.config.getConfig()
    }
  }
}

export namespace MessageDbProvider {
  export interface Config {
    getConfig: () => MessageDbService.Config
  }

  export interface Data {
    config: MessageDbService.Config
  }
}

export default MessageDbService
