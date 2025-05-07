import { resolve } from 'node:path'

import {
  Context, SessionError, Service, Session, Bot,
  Query, Tables, Driver,
  pick, z, h, $,
} from 'koishi'
import { DataService } from '@koishijs/plugin-console'
import type {} from 'koishi-plugin-cron'
import type { StrictEChartsOption } from 'koishi-plugin-w-echarts'
import type {} from 'koishi-plugin-w-option-conflict'
import type { NapCatBot } from 'koishi-plugin-adapter-napcat'

import dayjs from 'dayjs'
import type { EChartsOption } from 'echarts'

import {
  divide, formatSize, mapFrom, maxBy, stripUndefined, sumBy,
  Duration, parseDuration,
  getGid
} from '../shared/utils'
import {
  FetchHistoryOptions, FetchHistoryResult, FetchHistoryGuildResult,
  SavedMessage, SavedGuild, TrackedGuild,
  MdbStats, MdbStatsGuilds, MdbStatsMembers, MdbStatsMembersOption,
  MdbStatsTime, MdbStatsTimeOption,
  MdbChart, MdbChartOption, UniversalI18n,
  GuildQuery, UserQuery,
  MdbProviderData,
} from './types'

export class MdbService extends Service {
  static inject = {
    required: [ 'database', 'cron', 'console' ],
    optional: [ 'echarts' ],
  }

  logger = this.ctx.logger('w-message-db')

  private launchTime: number

  constructor(ctx: Context, public config: MdbService.Config) {
    super(ctx, 'messageDb')
    const that = this
    this.launchTime = Date.now()

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
    ctx.model.extend('w-message-guild', {
      platform: 'string',
      guildId: 'string',
      name: 'string',
      managerBotId: 'string',
      isTracked: 'boolean',
    }, {
      primary: [ 'platform', 'guildId' ],
    })

    // Extend console.
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../../dist'),
    })

    // Provide data to console.
    ctx.plugin(class MdbProvider extends DataService<MdbProviderData> {
      constructor(ctx: Context) {
        super(ctx, 'messageDb')
      }

      async get() {
        return {
          config: that.config,
          savedGuilds: that.savedGuilds,
          trackedGuilds: that.trackedGuilds,
        }
      }
    })

    // Handle console events.
    type ChartMethod = 'statsGuildsChart' | 'statsMembersChart' | 'statsTimeChart'
    const handleChart = <M extends ChartMethod>(method: M) => (locales: string[], param?: any) => this[method]({
      i18n: this.createI18n(locales),
      isStatic: false,
      withData: false,
      ...param,
    }) as ReturnType<MdbService[M]>

    ctx.console.addListener('message-db/stats', this.stats.bind(this))
    ctx.console.addListener('message-db/stats/guilds', this.statsGuilds.bind(this))
    ctx.console.addListener('message-db/stats/guilds/chart', handleChart('statsGuildsChart'))
    ctx.console.addListener('message-db/stats/members', this.statsMembers.bind(this))
    ctx.console.addListener('message-db/stats/members/chart', handleChart('statsMembersChart'))
    ctx.console.addListener('message-db/stats/time', this.statsTime.bind(this))
    ctx.console.addListener('message-db/stats/time/chart', handleChart('statsTimeChart'))

    // Save messages.
    const saveMessage = async (session: Session) => {
      // Check readonly mode.
      if (config.readonly) return

      // Ignore non-guild messages.
      const { platform, selfId, guildId, userId, username, content, timestamp, messageId } = session
      if (! session.guildId) return

      // Check if the guild is tracked.
      let savedGuild = this.savedGuildMap.get(getGid(session))
      if (! savedGuild?.isTracked) {
        // Ignore messages from untracked guilds if `requireTracking` is enabled.
        if (config.requireTracking) return
        // Save untracked guilds.
        if (! savedGuild) {
          const { name } = await session.bot.getGuild(guildId)
          savedGuild = {
            platform,
            guildId,
            name,
            managerBotId: selfId,
            isTracked: false,
          }
          this.savedGuildMap.set(getGid(session), savedGuild)
          await ctx.database.upsert('w-message-guild', [ savedGuild ])
          this.logger.info('saved guild %s', getGid(session))
        }
      }

      // Save message.
      const message: SavedMessage = {
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
      .option('guild', '-g <guild:channel>', { authority: 4 })
      .option('duration', '-d <duration:string>')
      .option('user', '-u <user:user>')
      .option('page', '-p <page:number>', { fallback: 1 })
      .option('withTime', '-t, --with-time', { fallback: false })
      .option('search', '-s <regexp:string>')
      .action(async ({ options, session }) => {
        this.checkInGuild(session)
        this.checkSaved(session)

        const { platform, guildId } = session

        const durationQuery = this.queryDuration(parseDuration(options.duration))

        const userId = this.validateUid(options.user, platform)

        const query: Query<SavedMessage> = {
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
      .option('force', '-f ')
      .option('maxCount', '-m <count:posint>')
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
          guildCount: this.savedGuildMap.size,
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
          messageCount, guildCount, trackedGuildCount, tableSize
        } = await this.stats()

        return session.text('.summary', {
          messageCount,
          guildCount,
          trackedGuildCount,
          tableSize: formatSize(tableSize),
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

        const userQuery: UserQuery = options.user
          ? { userId: this.validateUid(options.user, session.platform) }
          : undefined
        
        const guildQuery = this.queryGuild(session, options)

        const { option } = await this.statsTimeChart({
          i18n: session,
          guildQuery,
          userQuery
        })

        const eh = this.ctx.echarts.createChart(24 * 30 + 100, 7 * 30 + 120, option)

        return eh.export()
      })

    ctx.command('message-db.guild', { authority: 4 })

    ctx.command('message-db.guild.list')
      .option('tracked', '-t')
      .action(({ session, options }) => {
        const guilds = options.tracked ? this.trackedGuilds : this.savedGuilds

        return session.text('.summary', {
          count: guilds.length,
          list: guilds
            .map(guild =>
              `${ guild.isTracked ? `[${session.text('.tracked')}] ` : '' } ${guild.name} (${getGid(guild)}@${guild.managerBotId})`
            )
            .join('\n')
        })
      })

    ctx.command('message-db.guild.track')
      .action(async ({ session }) => {
        this.checkInGuild(session)

        const { gid, platform, guildId, selfId } = session
        const savedGuild = this.savedGuildMap.get(gid)

        if (savedGuild?.isTracked)
          throw new SessionError('message-db.error.guild-already-tracked')

        const { name } = await session.bot.getGuild(guildId)

        const trackedGuild: SavedGuild = {
          platform: platform,
          guildId: guildId,
          managerBotId: selfId,
          name,
          isTracked: true,
        }
        this.savedGuildMap.set(gid, trackedGuild)
        await ctx.database.upsert('w-message-guild', [ trackedGuild ])

        return session.text('.guild-tracked')
      })
  }

  savedGuildMap = new Map<string, SavedGuild>()
  get savedGuilds() {
    return [ ...this.savedGuildMap.values() ]
  }
  get trackedGuilds(): TrackedGuild[] {
    return this.savedGuilds.filter((it): it is TrackedGuild => it.isTracked)
  }

  async start() {
    // Load saved guilds from database.
    this.savedGuildMap = await this.ctx.database
      .get('w-message-guild', {})
      .then(guilds => mapFrom(guilds, getGid))

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

  private checkSaved(guildQuery: GuildQuery) {
    if (! this.savedGuildMap.has(getGid(guildQuery)))
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

  get managerBotIds() {
    return this.savedGuilds.map(it => it.managerBotId)
  }
  get managerBots() {
    return this.ctx.bots.filter(it => this.managerBotIds.includes(it.selfId))
  }

  getManagerBotOf(guildQuery: GuildQuery) {
    const { managerBotId } = this.savedGuildMap.get(getGid(guildQuery))
    return this.ctx.bots
      .find(it => it.platform === guildQuery.platform && it.selfId === managerBotId)
  }

  private createI18n(locales: string[]): UniversalI18n {
    return {
      text: (path: string, params?: Record<string, any>) =>
        this.ctx.i18n.render(locales, [ path ], params).map(String).join(''),
    }
  }

  async stats(): Promise<MdbStats> {
    const [ messageCount, dbStats ] = await Promise.all([
      this.ctx.database
        .select('w-message')
        .execute(row => $.count(row.id)),
      this.ctx.database.stats(),
    ])
    const guildCount = this.savedGuildMap.size
    const trackedGuildCount = this.trackedGuilds.length
    const tablesStats = dbStats.tables as Record<keyof Tables, Driver.TableStats>
    const tableSize = tablesStats['w-message'].size

    return {
      messageCount,
      guildCount,
      trackedGuildCount,
      tableSize,
    }
  }

  async statsGuilds(): Promise<MdbStatsGuilds> {
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
  }: MdbChartOption): Promise<MdbChart<MdbStatsGuilds>> {
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

  async statsMembers({ guildQuery }: {
    guildQuery: GuildQuery
  }): Promise<MdbStatsMembers> {
    this.checkSaved(guildQuery)

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

    const memberMap = mapFrom(memberList, it => it.user.id)

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
  }: MdbChartOption & MdbStatsMembersOption): Promise<MdbChart<MdbStatsMembers>> {
    this.checkSaved(guildQuery)

    const data = await this.statsMembers({ guildQuery })
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

  async statsTime({ guildQuery, userQuery }: MdbStatsTimeOption) {
    const timezoneOffset = (this.ctx.root.config.timezoneOffset as number) * 60 * 1000

    const [ timeData, guild ] = await Promise.all([
      this.ctx.database
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
        ? this.savedGuildMap.get(getGid(guildQuery))
        : undefined,
    ])

    return { timeData, guild }
  }

  async statsTimeChart({
    i18n,
    withData = false,
    isStatic = true,
    ...statsOption
  }: MdbChartOption & MdbStatsTimeOption): Promise<MdbChart<MdbStatsTime>> {
    const data = await this.statsTime(statsOption)
    const option: EChartsOption = {
      title: {
        text: statsOption.guildQuery
          ? i18n.text('message-db.chart.title.time-guild', { name: data.guild.name })
          : i18n.text('message-db.chart.title.time-global'),
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
        max: maxBy(data.timeData, it => it.count),
        calculable: true,
        show: ! isStatic,
        orient: 'horizontal',
        bottom: '0',
        left: 'center',
      },
      grid: {
        left: '5%',
      },
      series: {
        type: 'heatmap',
        silent: ! isStatic,
        label: { show: true },
        data: data.timeData.map(it => [ it.hour, it.weekday, it.count ]),
      },
      backgroundColor: isStatic ? '#fff' : undefined,
    }

    return {
      option,
      data: withData ? data : undefined,
    }
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
            this.trackedGuilds.map(getGid)
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
      this.trackedGuilds.map(async (guild): Promise<FetchHistoryGuildResult> => {
        // Get the manager bot for the guild.
        const { platform, guildId, managerBotId } = guild
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

    this.logger.info(`fetched message history in ${results.length} guilds:\n${
      results
        .map(result => {
          const { guild, type } = result
          return `  - ${getGid(guild)} @ ${guild.managerBotId}: ${
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

interface MdbGcConfig {
  enabled: boolean
  olderThan: number
  cron: string
  untrackedOnly: boolean
}

interface HistoryFetchingConfig {
  maxCount: number
  pageSize: number
}

export namespace MdbService {
  export interface Config {
    readonly: boolean
    requireTracking: boolean
    pageSize: number
    historyFetching: HistoryFetchingConfig
    gc: MdbGcConfig
  }

  export const Config: z<Config> = z.object({
    readonly: z
      .boolean()
      .default(false)
      .description('Whether to save messages to the database.'),
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


export default MdbService
