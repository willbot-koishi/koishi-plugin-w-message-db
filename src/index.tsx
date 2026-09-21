import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'

import {
  Context, SessionError, Service, Session, Bot,
  Query, Tables, Driver,
  pick, z, h, $, HTTP,
  Awaitable,
} from 'koishi'
import { Client } from '@koishijs/console'
import type {} from '@koishijs/assets'
import { DataService } from '@koishijs/plugin-console'
import type {} from 'koishi-plugin-cron'
import type { StrictEChartsOption } from 'koishi-plugin-w-echarts'
import type {} from 'koishi-plugin-w-jieba'
import type {} from 'koishi-plugin-w-wordcloud'
import type {} from 'koishi-plugin-w-option-conflict'
import type { NapCatBot } from 'koishi-plugin-adapter-napcat'
import type {} from '@koishijs/plugin-auth'
import type {} from '@koishijs/plugin-server'
import type { GuildMember } from '@satorijs/protocol'

import dayjs from 'dayjs'
import type { EChartsOption } from 'echarts'

import {
  divide, formatSize, mapFrom, maxBy, stripUndefined, sumBy,
  parseDuration, getGid, createMessageKey,
} from '../shared/utils'
import {
  FetchHistoryOptions, FetchHistoryResult, FetchHistoryGuildResult,
  SavedMessage, SavedGuild, TrackedGuild,
  MdbStats, MdbStatsGuilds, MdbStatsMembers, MdbStatsMembersOption,
  MdbStatsTime, MdbStatsTimeOption,
  MdbChart, MdbChartOption, UniversalI18n,
  GuildQuery, UserQuery,
  MdbProviderData,
  MdbRemoteMethod,
  MdbRemoteError,
  DurationQuery,
  MdbEvents,
  MdbProvider,
  GetMessageOption,
  GetGuildMembersOption,
  MessageMigrationStage,
  MessageMigrationState,
  MdbStatsGuildsOption,
  SavedMessageWord,
} from './types'
import {
  extendMessageModels,
  markMessageTypesMigrated,
  migrateMessageTypes,
  migrateMessageV2,
} from './model'
import { createMessageFilterQuery, getMessageTypeMask } from './query'

declare module 'koishi' {
  interface Context {
    messageDb: MdbService
  }

  interface Events {
    'message-db/message': (message: SavedMessage) => void
  }
}

declare module '@koishijs/console' {
  interface Events extends MdbEvents {}
}

declare module '@koishijs/plugin-console' {
  namespace Console {
    interface Services {
      messageDb: MdbProvider
    }
  }
}

export class MdbService extends Service {
  static inject = {
    required: ['database', 'cron', 'console'],
    optional: ['echarts', 'assets', 'server', 'jieba', 'wordcloud'],
  }

  logger = this.ctx.logger('w-message-db')
  private proxyToken = randomUUID()
  migration: MessageMigrationState = {
    status: 'pending',
    processed: 0,
    total: 0,
  }
  private migrationRefreshAt = 0

  constructor(ctx: Context, public config: MdbService.Config) {
    super(ctx, 'messageDb')
    this.launchTime = Date.now()

    // I18n
    void ['zh-CN', 'en-US'].map((locale: string) => {
      this.ctx.i18n.define(locale, require(`../locales/${locale}.yml`))
    })

    extendMessageModels(ctx)

    // Extend console.
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../../dist'),
    })

    // Set up html2canvas proxy.
    if (config.console.proxyMode === 'internal') {
      if (! ctx.server)
        throw new Error('Internal console proxy requires the server service.')
      if (! config.console.proxyAllowedHosts.length)
        throw new Error('Internal console proxy requires at least one allowed host.')

      let proxyUrl: URL
      try {
        proxyUrl = new URL(config.console.proxyUrl)
      }
      catch {
        throw new Error('Internal console proxy requires an absolute proxy URL.')
      }

      const RESPONSE_TYPES = ['blob', 'text']
      const RESPONSE_HEADERS = [
        'cache-control', 'content-length', 'content-type',
        'etag', 'expires', 'last-modified',
      ]
      const isAllowed = (target: URL) => {
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
        const host = target.host.toLowerCase()
        return config.console.proxyAllowedHosts.some(pattern => {
          pattern = pattern.trim().toLowerCase()
          if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(1)
            return host.endsWith(suffix) && host.length > suffix.length
          }
          return host === pattern
        })
      }

      ctx.server.get(proxyUrl.pathname, async (ktx) => {
        const { token, url, responseType } = ktx.query
        if (token !== this.proxyToken) {
          ktx.status = 403
          return
        }
        if (typeof url !== 'string' || ! url) {
          ktx.status = 400
          ktx.body = 'Missing `url`.'
          return
        }
        if (responseType !== undefined && (
          typeof responseType !== 'string' ||
          ! RESPONSE_TYPES.includes(responseType)
        )) {
          ktx.status = 400
          ktx.body = 'Invalid `responseType`.'
          return
        }

        try {
          let target = new URL(url)
          let resp: HTTP.Response<ReadableStream<Uint8Array>>
          for (let redirects = 0; ; redirects ++) {
            if (! isAllowed(target)) {
              ktx.status = 403
              ktx.body = 'Target host is not allowed.'
              return
            }
            if (redirects > 5)
              throw new Error('Too many redirects.')

            resp = await ctx.http(target.href, {
              method: 'GET',
              redirect: 'manual',
              responseType: 'stream',
              validateStatus: () => true,
            })
            if (resp.status < 300 || resp.status >= 400) break

            const location = resp.headers.get('location')
            await resp.data.cancel()
            if (! location) break
            target = new URL(location, target)
          }

          ktx.status = resp.status
          for (const key of RESPONSE_HEADERS) {
            const value = resp.headers.get(key)
            if (value !== null) ktx.set(key, value)
          }
          ktx.body = Readable.fromWeb(resp.data)
        }
        catch (error) {
          this.logger.warn('console proxy request failed: %s', error)
          ktx.status = 502
          ktx.body = 'Failed to fetch target.'
        }
      })
    }

    // Garbage collection.
    if (config.gc.enabled) ctx.cron(config.gc.cron, () => {
      if (this.migration.status !== 'ready') return
      return this.gc()
    })

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
        this.checkMigrationReady()
        const guildQuery = this.queryGuild(session, options)
        if (! guildQuery)
          throw new SessionError('message-db.error.guild-only')
        this.checkSaved(guildQuery)

        const durationQuery = this.queryDuration(options.duration)

        const userQuery = this.queryUser(session, {
          ...pick(options, ['user']),
          validatePlatform: true,
        })

        const query: Query<SavedMessage> = {
          ...guildQuery,
          ...userQuery,
          ...durationQuery,
          content: options.search
            ? { $regex: options.search }
            : {},
        }

        const [messages, messageTotal] = await Promise.all([
          ctx.database
            .select('w-message-v2')
            .where(query)
            .orderBy('timestamp', 'desc')
            .orderBy('id', 'desc')
            .offset((options.page - 1) * config.pageSize)
            .limit(config.pageSize)
            .execute(),
          ctx.database
            .select('w-message-v2')
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
      .option('duration', '-d <duration:string>')
      .option('force', '-f')
      .option('maxCount', '-m <count:posint>')
      .action(async ({ session, options }) => {
        if (! options.force) this.checkNotReadonly()

        const startTime = Date.now()
        const result = await this.fetchHistory({
          duration: parseDuration(options.duration),
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

    ctx.command('message-db.task')

    ctx.command('message-db.task.list', { authority: 3 })
      .action(({ session }) => {
        const tasks = Object.entries(this.tasks)

        return (tasks.length
          ? <>
            {session.text('.summary', { count: tasks.length })}
            <br />
            {tasks.map(([id, task]) => (
              <li>{session.text('.task-info', { id, ...task })}</li>
            ))}
          </>
          : session.text('.no-tasks')
        )
      })

    ctx.command('message-db.task.abort <id:number>', { authority: 3 })
      .action(({ session }, id) => {
        const task = this.tasks[id]
        if (! task) {
          return session.text('.not-found', { id })
        }
        task.ac.abort()
        delete this.tasks[id]
        return session.text('.aborted', { id })
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
      .option('duration', '-d <duration:string>')
      .action(async ({ session, options }) => {
        this.checkECharts()

        const durationQuery = this.queryDuration(options.duration)

        const { data: statsGuilds, option } = await this.statsGuildsChart({
          i18n: session,
          withData: true,
          durationQuery,
        })

        const eh = this.ctx.echarts.createChart(600, 600, option)

        let rankMessage = ''
        if (session.guildId) {
          const index = statsGuilds.findIndex(
            it => it.gid === `${session.platform}:${session.guildId}`
          )
          rankMessage = index >= 0
            ? session.text('.summary', {
              count: statsGuilds[index].value,
              rank: index + 1,
            })
            : session.text('.untracked')
        }

        return <>
          { await eh.export() }
          { rankMessage }
        </>
      })

    ctx.command('message-db.stats.members')
      .option('duration', '-d <duration:string>')
      .action(async ({ session, options }) => {
        this.checkECharts()
        this.checkInGuild(session)

        const eh = this.ctx.echarts.createChart(
          600, 600,
          await this
            .statsMembersChart({
              i18n: session,
              guildQuery: this.queryGuild(session),
              durationQuery: this.queryDuration(options.duration),
            })
            .then(it => it.option)
        )

        return eh.export()
      })

    ctx.command('message-db.stats.user')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .option('duration', '-d <duration:string>')
      .action(async ({ session, options }) => {
        this.checkMigrationReady()
        const userQuery = this.queryUser(session, {
          useSender: true,
          validatePlatform: true,
        })
        const guildQuery = this.queryGuild(session, options)
        if (! options.global && ! guildQuery)
          throw new SessionError('message-db.error.guild-only')
        const durationQuery = this.queryDuration(options.duration)

        const [count, guildName] = await Promise.all([
          this.ctx.database
            .select('w-message-v2')
            .where({
              ...userQuery,
              ...guildQuery,
              ...durationQuery,
            })
            .execute(row => $.count(row.id)),
          guildQuery
            ? this.savedGuildMap.get(getGid(guildQuery))?.name ?? getGid(guildQuery)
            : undefined,
        ])
        const userName = session.username

        return options.global
          ? session.text('.summary-global', { count, userName })
          : session.text('.summary-guild', { count, userName, guildName })
      })

    ctx.command('message-db.stats.time')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .option('user', '-u <user:user>')
      .option('duration', '-d <duration:string>')
      .action(async ({ session, options }) => {
        this.checkECharts()

        const guildQuery = this.queryGuild(session, options)
        const userQuery: UserQuery = this.queryUser(session, {
          ...pick(options, ['user']),
          validatePlatform: true,
        })
        const durationQuery = this.queryDuration(options.duration)

        const { option } = await this.statsTimeChart({
          i18n: session,
          guildQuery,
          userQuery,
          durationQuery,
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
              `- ${ guild.isTracked ? `[${session.text('.tracked')}] ` : '' }${guild.name} (${getGid(guild)}@${guild.managerBotId})`
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
        await ctx.database.upsert('w-message-guild', [trackedGuild])

        return session.text('.guild-tracked')
      })

    ctx.command('message-db.segment')

    ctx.command('message-db.segment.run', { authority: 4 })
      .option('duration', '-d <duration:string>')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .option('quiet', '-q')
      .action(async ({ session, options }) => {
        this.checkMigrationReady()
        if (! ctx.jieba) return session.text('message-db.error.jieba-not-loaded')

        await this.runTask('segment', async signal => {
          ctx.logger.info('segment start')

          const guildQuery = this.queryGuild(session, options)
          const durationQuery = this.queryDuration(options.duration)

          const BATCH_SIZE = 2000
          let messageIndex = 0
          let batchIndex = 0

          ctx.logger.info('init jieba')
          const jieba = new ctx.jieba.Jieba()

          const [
            { segmentedCount, totalCount } = { segmentedCount: 0, totalCount: 0 }
          ] = await ctx.database
            .select('w-message-v2')
            .where({
              ...guildQuery,
              ...durationQuery,
              segmented: false,
            })
            .groupBy([], {
              segmentedCount: row => $.sum($.number(row.segmented)),
              totalCount: row => $.count(row.id),
            })
            .execute()

          const leftBatch = Math.ceil((totalCount - segmentedCount) / BATCH_SIZE)

          ctx.logger.info(
            `segment progress: ${segmentedCount} / ${totalCount} messages, ` +
            `${leftBatch} batches left`
          )

          while (true) {
            if (signal.aborted) {
              ctx.logger.info('aborted')
              return
            }

            const progress = `${(batchIndex / leftBatch * 100).toFixed(2)}%`
            ctx.logger.info(`batch ${batchIndex}: select, index: ${messageIndex}, ${progress}`)

            const messages = await ctx.database
              .select('w-message-v2')
              .where({
                ...guildQuery,
                ...durationQuery,
                segmented: false,
              })
              .project({
                messageKey: row => row.key,
                content: row => row.content,
                platform: row => row.platform,
                guildId: row => row.guildId,
                userId: row => row.userId,
                timestamp: row => row.timestamp,
              })
              .limit(BATCH_SIZE)
              .execute()

            if (! messages.length) break

            ctx.logger.info(`batch ${batchIndex}: segment, first key: ${messages[0].messageKey}`)

            const words: SavedMessageWord[] = []
            for (const { content, ...message } of messages) {
              const text = h
                .parse(content)
                .filter(el => el.type === 'text')
                .map(el => el.attrs.content)
                .join('')
              const taggedWords = jieba.tag(text)
              taggedWords.forEach((taggedWord, index) => words.push({
                ...message,
                index,
                ...taggedWord,
              }))
            }

            ctx.logger.info(`batch ${batchIndex}: upsert words, count: ${words.length}`)
            await ctx.database.upsert('w-message-word-v2', words)
            // Mark a message only after all derived rows are durable. If either
            // write fails, the next run can safely upsert the same word rows.
            ctx.logger.info(`batch ${batchIndex}: mark messages`)
            await ctx.database.set('w-message-v2', {
              key: { $in: messages.map(message => message.messageKey) },
            }, {
              segmented: true,
            })

            messageIndex += messages.length
            batchIndex ++
          }

          ctx.logger.info('segment done')
        })
      })

    ctx.command('message-db.stats.wordcloud')
      .alias('message-db.stats.wc')
      .option('global', '-G')
      .option('guild', '-g <guild:channel>', { conflictsWith: 'global' })
      .option('user', '-u <user:user>')
      .option('duration', '-d <duration:string>')
      .option('top', '-n <count:posint>', { fallback: 100 })
      .action(async ({ session, options }) => {
        this.checkMigrationReady()
        if (! ctx.wordcloud) {
          return session.text('message-db.error.wordcloud-not-loaded')
        }

        if (options.top > 200 || options.top <= 0) {
          return session.text('message-db.error.wordcloud-top-out-of-range')
        }

        const guildQuery = this.queryGuild(session, options)
        const userQuery = this.queryUser(session, {
          ...pick(options, ['user']),
          validatePlatform: true,
        })
        const durationQuery = this.queryDuration(options.duration)

        const words = await this.ctx.database
          .select('w-message-word-v2')
          .where({
            ...guildQuery,
            ...userQuery,
            ...durationQuery,
            tag: { $ne: 'x' },
          })
          .project(['word'])
          .groupBy('word', {
            weight: () => $.sum(1),
          })
          .orderBy('weight', 'desc')
          .limit(options.top)
          .execute()

        const wctx = ctx.wordcloud.createWordCloud(words, {})

        return <>
          {session.text('.summary', {
            wordTopCount: words.length
          })}
          <br />
          {h.image(await wctx.canvas.toBuffer('png'), 'image/png')}
        </>
      })

    // Dispose
    ctx.on('dispose', () => {
      for (const { ac } of Object.values(this.tasks)) {
        ac.abort()
      }
    })
  }

  private launchTime: number

  private nextTaskId = 0
  private tasks: Record<number, {
    ac: AbortController
    description: string
    startAt: number
  }> = {}

  private async runTask(description: string, task: (signal: AbortSignal) => Promise<void>) {
    const taskId = this.nextTaskId ++
    const ac = new AbortController()
    this.tasks[taskId] = {
      ac,
      description,
      startAt: Date.now(),
    }
    try {
      await task(ac.signal)
    }
    finally {
      delete this.tasks[taskId]
    }
  }

  savedGuildMap = new Map<string, SavedGuild>()
  get savedGuilds() {
    return [...this.savedGuildMap.values()]
  }
  get trackedGuilds(): TrackedGuild[] {
    return this.savedGuilds.filter((it): it is TrackedGuild => it.isTracked)
  }

  async start() {
    // Load saved guilds from database.
    this.savedGuildMap = await this.ctx.database
      .get('w-message-guild', {})
      .then(guilds => mapFrom(guilds, getGid))

    // Start saving messages.
    const saveMessage = this.saveMessage.bind(this)
    this.ctx.on('message', saveMessage)
    this.ctx.on('send', saveMessage)

    // Provide data to console.
    const that = this
    this.ctx.plugin(class extends DataService<MdbProviderData> implements MdbProvider {
      constructor(ctx: Context) {
        super(ctx, 'messageDb')
      }

      async get() {
        const config = that.config.console.proxyMode === 'internal'
          ? {
            ...that.config,
            console: {
              ...that.config.console,
              proxyUrl: `${that.config.console.proxyUrl}${
                that.config.console.proxyUrl.includes('?') ? '&' : '?'
              }token=${encodeURIComponent(that.proxyToken)}`,
            },
          }
          : that.config
        return {
          config,
          migration: that.migration,
          savedGuilds: that.savedGuilds,
          trackedGuilds: that.trackedGuilds,
        }
      }
    })

    // Handle console events.
    const bind = <M extends MdbRemoteMethod>(method: M): this[M] =>
      async function (...params: any[]): Promise<void | MdbRemoteError> {
        if (that.migration.status !== 'ready') {
          return { error: 'migration-pending' }
        }
        try {
          return that[method].call(that, ...params)
        }
        catch (error) {
          that.logger.warn('console method %s failed: %s', method, error)
          return { error: 'internal' }
        }
      } as unknown as this[M]

    const chart = <P extends MdbChartOption, R>(fn: (param: P) => R) =>
      function (this: Client, param: Omit<P, 'i18n'>): R {
        return fn.call(this, {
          i18n: that.createI18n(Object.keys(this.ctx.i18n.locales)),
          isStatic: false,
          withData: false,
          ...param,
        } satisfies MdbChartOption)
      }

    const requireGuildMember = <P extends { guildQuery?: GuildQuery }, R>(fn: (param: P) => R) =>
      async function (this: Client, param: P): Promise<Awaited<R> | MdbRemoteError> {
        if (param.guildQuery) {
          const { platform, guildId } = param.guildQuery
          const [binding] = await that.ctx.database.get('binding', {
            platform,
            aid: this.auth.id,
          })

          if (! binding) return { error: 'require-guild-member' }
          const bot = that.getManagerBotOf(param.guildQuery)
          if (! bot?.isActive) return { error: 'bot-not-available' }
          const isMember = await bot.getGuildMember(guildId, binding.pid)
            .then(() => true).catch(() => false)
          if (! isMember) return { error: 'require-guild-member' }
        }

        return fn.call(this, param)
      }

    // TODO: Validate params.
    this.ctx.console.addListener('message-db/stats', bind('stats'))
    this.ctx.console.addListener('message-db/statsGuilds', bind('statsGuilds'))
    this.ctx.console.addListener('message-db/statsGuildsChart', chart(bind('statsGuildsChart')))
    this.ctx.console.addListener('message-db/statsMembers', requireGuildMember(bind('statsMembers')))
    this.ctx.console.addListener('message-db/statsMembersChart', requireGuildMember(chart(bind('statsMembersChart'))))
    this.ctx.console.addListener('message-db/statsTime', requireGuildMember(bind('statsTime')))
    this.ctx.console.addListener('message-db/statsTimeChart', requireGuildMember(chart(bind('statsTimeChart'))))
    this.ctx.console.addListener('message-db/getMessages', requireGuildMember(bind('getMessages')))
    this.ctx.console.addListener('message-db/getGuildMembers', requireGuildMember(bind('getGuildMembers')))

    // Migrations can take hours on large databases. Run them only after the
    // console provider and listeners are registered so their progress remains
    // visible and the rest of the application can finish starting.
    void this.runTask('database migration', signal => this.migrateDatabase(signal))
  }

  private async migrateDatabase(signal: AbortSignal) {
    const onProgress = (stage: MessageMigrationStage) =>
      ({ processed, total }: { processed: number, total: number }) => {
        this.updateMigration({
          status: 'running',
          stage,
          processed,
          total,
        })
      }

    try {
      this.updateMigration({
        status: 'running',
        stage: 'messages',
        processed: 0,
        total: 0,
      }, true)
      const migration = await migrateMessageV2(this.ctx, {
        signal,
        onProgress: onProgress('messages'),
      })
      const migratedTotal = this.migration.total
      if (! migration.skipped) {
        this.logger.info(
          'migrated %d messages and %d word records to v2',
          migration.messages,
          migration.words,
        )
      }

      this.updateMigration({
        status: 'running',
        stage: 'message-types',
        processed: 0,
        total: 0,
      }, true)
      if (migration.skipped) {
        const typeMigration = await migrateMessageTypes(this.ctx, {
          signal,
          onProgress: onProgress('message-types'),
        })
        if (! typeMigration.skipped) {
          this.logger.info('indexed message types for %d messages', typeMigration.messages)
        }
      }
      else {
        // Fresh v2 rows already receive a type mask while they are copied, so
        // a second full-table pass would only duplicate several hours of work.
        await markMessageTypesMigrated(
          this.ctx,
          migratedTotal,
          onProgress('message-types'),
        )
      }

      signal.throwIfAborted()
      this.updateMigration({
        status: 'ready',
        processed: this.migration.total,
        total: this.migration.total,
      }, true)

      // Fetch history only after the v2 tables are complete, otherwise query
      // results and migration progress would describe a partial data set.
      if (! this.config.readonly) {
        void this.fetchHistory({
          duration: {
            start: 0,
            end: this.launchTime,
          },
        }).catch(error => {
          this.logger.warn('failed to fetch history on start: %s', error)
        })
      }
    }
    catch (error) {
      if (signal.aborted) return
      this.logger.error('database migration failed:')
      this.logger.error(error)
      this.updateMigration({
        ...this.migration,
        status: 'error',
        error,
      }, true)
    }
  }

  private updateMigration(state: MessageMigrationState, force = false) {
    this.migration = state
    const now = Date.now()
    if (! force && now - this.migrationRefreshAt < 1000) return
    this.migrationRefreshAt = now
    void Promise.resolve(this.ctx.console.refresh('messageDb')).catch(error => {
      this.logger.debug('failed to refresh migration progress: %s', error)
    })
  }

  stop(): Awaitable<void> {
    super.stop()
  }

  private checkECharts() {
    if (! this.ctx.echarts)
      throw new SessionError('message-db.error.echarts-not-loaded')
  }

  private checkMigrationReady() {
    if (this.migration.status !== 'ready')
      throw new SessionError('message-db.error.migration-pending')
  }

  private checkInGuild(session: Session) {
    if (! session.guildId)
      throw new SessionError('message-db.error.guild-only')
  }

  private checkSaved(guildQuery: GuildQuery) {
    if (! this.isGuildSaved(guildQuery))
      throw new SessionError('message-db.error.guild-not-tracked')
  }

  private checkNotReadonly() {
    if (this.config.readonly)
      throw new SessionError('message-db.error.readonly')
  }

  private queryUser(
    session: Session,
    options: { user?: string, useSender?: boolean, validatePlatform?: boolean } = {}
  ): UserQuery | undefined {
    if (options.user) {
      const [platform, userId] = options.user.split(':')
      if (options.validatePlatform && platform !== session.platform)
        throw new SessionError('message-db.error.user-platform-mismatch', [options.useSender])
      return { userId }
    }
    if (options.useSender) return pick(session, ['userId'])
  }

  private queryGuild(
    session: Session,
    options: { global?: boolean, guild?: string } = {},
  ): GuildQuery | undefined {
    if (options.global) return undefined
    if (options.guild) {
      const [platform, guildId] = options.guild.split(':')
      return { platform, guildId }
    }
    if (session.guildId)
      return pick(session, ['platform', 'guildId'])
  }

  private queryDuration(durationStr = '~'): DurationQuery {
    const { start, end } = parseDuration(durationStr)
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
    const [majors, minors] = divide(data, it => it.value > threshold)
    const other = {
      name: i18n.text('message-db.chart.other'),
      value: sumBy(minors, it => it.value),
      itemStyle: { color: '#888' }
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
    return this.ctx.bots.filter(it => it.isActive && this.managerBotIds.includes(it.selfId))
  }

  getManagerBotOf(guildQuery: GuildQuery) {
    const savedGuild = this.savedGuildMap.get(getGid(guildQuery))
    if (! savedGuild) return
    return this.ctx.bots
      .find(it => it.platform === guildQuery.platform && it.selfId === savedGuild.managerBotId)
  }

  private requireManagerBotOf(guildQuery: GuildQuery) {
    const bot = this.getManagerBotOf(guildQuery)
    if (! bot?.isActive)
      throw new SessionError('message-db.error.bot-not-available')
    return bot
  }

  private createI18n(locales: string[]): UniversalI18n {
    return {
      text: (path: string, params?: Record<string, any>) =>
        this.ctx.i18n.render(locales, [path], params).map(String).join(''),
    }
  }

  async getMessages({
    guildQuery,
    userQuery,
    filter,
    baseTimestamp,
    baseId,
    direction = 'before',
    limit = this.config.pageSize,
    page = 1,
  }: GetMessageOption) {
    this.checkMigrationReady()
    limit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : this.config.pageSize
    page = Number.isSafeInteger(page) ? Math.max(1, page) : 1
    const cursorQuery: Query<SavedMessage> = baseTimestamp === undefined
      ? {}
      : baseId === undefined
        ? {
          timestamp: direction === 'before'
            ? { $lt: baseTimestamp }
            : { $gt: baseTimestamp },
        }
        : {
          $or: [
            {
              timestamp: direction === 'before'
                ? { $lt: baseTimestamp }
                : { $gt: baseTimestamp },
            },
            {
              timestamp: baseTimestamp,
              id: direction === 'before' ? { $lt: baseId } : { $gt: baseId },
            },
          ],
        }
    const messages = await this.ctx.database
      .select('w-message-v2')
      .where(guildQuery)
      .where(cursorQuery)
      .where(userQuery ?? {})
      .where(createMessageFilterQuery(filter))
      .orderBy('timestamp', direction === 'before' ? 'desc' : 'asc')
      .orderBy('id', direction === 'before' ? 'desc' : 'asc')
      .limit(limit + 1)
      .offset(Math.max(0, page - 1) * limit)
      .execute()

    return {
      data: messages.slice(0, limit),
      hasMore: messages.length > limit,
    }
  }

  async getGuildMembers({ guildQuery }: GetGuildMembersOption): Promise<GuildMember[]> {
    const bot = this.requireManagerBotOf(guildQuery)
    return bot.getGuildMemberList(guildQuery.guildId).then(it => it.data)
  }

  async stats(): Promise<MdbStats> {
    this.checkMigrationReady()
    const [messageCount, dbStats] = await Promise.all([
      this.ctx.database
        .select('w-message-v2')
        .execute(row => $.count(row.id)),
      this.ctx.database.stats(),
    ])
    const guildCount = this.savedGuildMap.size
    const trackedGuildCount = this.trackedGuilds.length
    const tablesStats = dbStats.tables as Record<keyof Tables, Driver.TableStats>
    const tableSize = tablesStats['w-message-v2'].size

    return {
      messageCount,
      guildCount,
      trackedGuildCount,
      tableSize,
    }
  }

  async statsGuilds({
    durationQuery,
  }: MdbStatsGuildsOption): Promise<MdbStatsGuilds> {
    this.checkMigrationReady()
    const [data, guildLists] = await Promise.all([
      this.ctx.database
        .select('w-message-v2')
        .where({
          ...durationQuery,
        })
        .groupBy(['platform', 'guildId'], {
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
        .map(guild => [`${platform}:${guild.id}`, guild])
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
    durationQuery,
    i18n,
    withData = false,
    isStatic = true,
  }: MdbStatsGuildsOption & MdbChartOption): Promise<MdbChart<MdbStatsGuilds>> {
    const data = await this.statsGuilds({ durationQuery })
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

  async statsMembers({
    guildQuery,
    durationQuery
  }: MdbStatsMembersOption): Promise<MdbStatsMembers> {
    this.checkMigrationReady()
    this.checkSaved(guildQuery)

    const [data, memberList] = await Promise.all([
      this.ctx.database
        .select('w-message-v2')
        .where({
          ...guildQuery,
          ...durationQuery,
        })
        .groupBy('userId', {
          count: row => $.count(row.id),
        })
        .orderBy('count', 'desc')
        .execute(),
      this
        .requireManagerBotOf(guildQuery)
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
    durationQuery,
    i18n,
    withData = false,
    isStatic = true,
  }: MdbChartOption & MdbStatsMembersOption): Promise<MdbChart<MdbStatsMembers>> {
    this.checkSaved(guildQuery)

    const data = await this.statsMembers({ guildQuery, durationQuery })
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

  async statsTime({ guildQuery, userQuery, durationQuery }: MdbStatsTimeOption) {
    this.checkMigrationReady()
    const timezoneOffset = (this.ctx.root.config.timezoneOffset as number) * 60 * 1000

    const [timeData, guild] = await Promise.all([
      this.ctx.database
        .select('w-message-v2')
        .where({
          ...guildQuery,
          ...userQuery,
          ...durationQuery,
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
        .groupBy(['weekday', 'hour'], {
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
          ? i18n.text('message-db.chart.title.time-guild', {
            name: data.guild?.name ?? getGid(statsOption.guildQuery),
          })
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
        data: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      },
      visualMap: {
        min: 0,
        max: data.timeData.length ? maxBy(data.timeData, it => it.count) : 0,
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
        data: data.timeData.map(it => [it.hour, it.weekday, it.count]),
      },
      backgroundColor: isStatic ? '#fff' : undefined,
    }

    return {
      option,
      data: withData ? data : undefined,
    }
  }

  /**
   * Check if the guild is saved.
   * @param guildQuery The guild to check
   */
  isGuildSaved(guildQuery: GuildQuery) {
    return this.savedGuildMap.has(getGid(guildQuery))
  }

  /**
   * Run garbage collection to remove old messages.
   * @returns The number of removed messages
   */
  async gc(): Promise<number | null> {
    this.checkMigrationReady()
    if (! this.config.gc.enabled) return null

    const { olderThan, untrackedOnly } = this.config.gc
    const minTime = Date.now() - olderThan * 24 * 60 * 60 * 1000

    const messageResult = await this.ctx.database.remove('w-message-v2', row => $.and(
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
    // Word rows duplicate the message timestamp and guild identity, so they
    // can be collected even if a previous run removed only the parent rows.
    const wordResult = await this.ctx.database.remove('w-message-word-v2', row => $.and(
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

    this.logger.info(
      'collected %d messages and %d word records',
      messageResult.removed,
      wordResult.removed,
    )

    return messageResult.removed
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
   * @param guildId The guild ID
   * @param time The timestamp to start from
   */
  async getStartTokenBefore(bot: Bot, guildId: string, time: number): Promise<string | undefined> {
    // If the bot is a NapCat bot,
    // we can use the last message ID before the time as the start token.
    if (bot.platform === 'onebot' && (bot.internal as NapCatBot<Context>).isNapCat) {
      const [message] = await this.ctx.database
        .select('w-message-v2')
        .where({
          platform: bot.platform,
          guildId,
          timestamp: { $lt: time },
        })
        .orderBy('timestamp', 'desc')
        .limit(1)
        .execute()
      if (message) return message.id
    }
  }

  /**
   * Save a message to the database.
   * @param session The session containing the message
   */
  async saveMessage(session: Session) {
    // Check readonly mode.
    if (this.config.readonly) return

    // Ignore non-guild messages.
    const { platform, selfId, guildId, userId, username, timestamp, messageId, quote } = session
    if (! session.guildId) return

    // Check if the guild is tracked.
    let savedGuild = this.savedGuildMap.get(getGid(session))
    if (! savedGuild?.isTracked) {
      // Ignore messages from untracked guilds if `requireTracking` is enabled.
      if (this.config.requireTracking) return
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
        await this.ctx.database.upsert('w-message-guild', [savedGuild])
        this.logger.info('saved guild %s', getGid(session))
      }
    }

    // Start message content processing.
    let { content } = session
    if (! content) return
    // Transfer assets.
    if (
      this.config.assetTransferring.enabled &&
      (savedGuild.isTracked || ! this.config.assetTransferring.requireTracking) &&
      this.ctx.assets
    ) {
      content = await this.ctx.assets.transform(content)
    }
    // Insert the message into the database.
    const message: SavedMessage = {
      key: createMessageKey({ platform, guildId, id: messageId }),
      id: messageId,
      platform,
      guildId,
      userId,
      username,
      content,
      timestamp,
      quoteId: quote?.id,
      segmented: false,
      messageTypeMask: getMessageTypeMask(content),
    }

    const { inserted } = await this.ctx.database.upsert('w-message-v2', [message])

    // Emit message event.
    // TODO: Multi-instance broadcast.
    if (inserted) this.ctx.emit('message-db/message', message)

    return
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
    this.checkMigrationReady()
    // All guild workers share the same budget. JavaScript runs the decrement
    // synchronously, so concurrent workers cannot reserve the same slot.
    let remaining = maxCount
    const reserve = () => {
      if (remaining <= 0) return false
      remaining --
      return true
    }

    const results = await Promise.all(
      // Fetch message history from all tracked guilds.
      this.trackedGuilds.map(async (guild): Promise<FetchHistoryGuildResult> => {
        // Get the manager bot for the guild.
        const { platform, guildId, managerBotId } = guild
        const bot = this.ctx.bots.find(it => it.platform === platform && it.selfId === managerBotId)
        // Check if the manager bot is available.
        if (! bot || ! bot.isActive)
          return { guild, type: 'error', error: 'bot-not-available' }

        // Start fetching message history.
        try {
          // We will fetch message history from new to old. NapCat can use a
          // saved message in this guild as an efficient cursor for `end`.
          const startToken = duration.end !== null
            ? await this.getStartTokenBefore(bot, guildId, duration.end)
            : undefined

          // Get the asynchronous message iterator from `startToken`.
          const iter = this.getMessageIter(bot, guildId, startToken, this.config.historyFetching.pageSize)
          let inserted = 0
          for await (const msg of iter) {
            const { content, timestamp } = msg

            // Adapters without a usable time cursor still start from the most
            // recent message, so explicitly discard messages after `end`.
            if (duration.end !== null && timestamp > duration.end) continue

            // Iteration is newest-first; reaching `start` completes this guild.
            if (duration.start !== null && timestamp < duration.start)
              return { guild, type: 'ok', inserted, exit: 'done' }

            // Skip empty messages.
            if (! content) continue

            // Fetch no more than `maxCount` eligible messages across the task.
            if (! reserve())
              return { guild, type: 'ok', inserted, exit: 'reached-max' }

            // Construct the `TrackedMessage` object.
            const { id } = msg
            const message: SavedMessage = ({
              key: createMessageKey({ platform, guildId, id }),
              id,
              platform,
              guildId,
              userId: msg.user.id,
              username: msg.user.nick || msg.user.name,
              content,
              timestamp,
              quoteId: msg.quote?.id,
              segmented: false,
              messageTypeMask: getMessageTypeMask(content),
            })

            // Try to insert it into the database.
            const { inserted: insertedIt } = await this.ctx.database.upsert('w-message-v2', [message])
            inserted += insertedIt

            // The fetching is done if
            // 1. `stopOnOld` is enabled and the message exists in the database;
            if (! insertedIt && stopOnOld)
              return { guild, type: 'ok', inserted, exit: 'done' }
          }

          return { guild, type: 'ok', inserted, exit: 'exhausted' }
        }
        catch (err) {
          this.logger.error(err)
          return { guild, type: 'error', error: 'internal-error', internal: err }
        }
      })
    )

    // Log the results.
    const [errors, oks] = divide(results, it => it.type === 'error')
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

export namespace MdbService {
  interface AssetTransferringConfig {
    enabled: boolean
    requireTracking: boolean
  }

  interface GcConfig {
    enabled: boolean
    olderThan: number
    cron: string
    untrackedOnly: boolean
  }

  interface HistoryFetchingConfig {
    maxCount: number
    pageSize: number
  }

  interface ConsoleConfig {
    proxyMode: 'disable' | 'external' | 'internal'
    proxyUrl: string
    proxyAllowedHosts: string[]
  }

  export interface Config {
    readonly: boolean
    requireTracking: boolean
    pageSize: number
    historyFetching: HistoryFetchingConfig
    assetTransferring: AssetTransferringConfig
    gc: GcConfig
    console: ConsoleConfig
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
    assetTransferring: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .description('Whether to enable asset transferring.'),
        requireTracking: z
          .boolean()
          .default(true)
          .description('Whether to require tracking guilds for asset transferring.'),
      })
      .description('Asset transferring'),
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
    console: z
      .object({
        proxyMode: z
          .union(['disable', 'external', 'internal'])
          .default('disable')
          .description('Proxy mode for console.'),
        proxyUrl: z
          .string()
          .default('')
          .description('Proxy URL for console.'),
        proxyAllowedHosts: z
          .array(z.string())
          .default([])
          .description('Hosts allowed by the internal proxy. Supports `*.example.com`.'),
      })
      .description('Console')
  })
}

export default MdbService
