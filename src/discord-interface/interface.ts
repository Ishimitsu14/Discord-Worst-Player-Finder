import { Events, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Interaction, type InteractionEditReplyOptions } from 'discord.js';
import { PipelineError, type Clock, type Job, type MatchRequestResult, type StoredResult } from '../match-pipeline/index.js';
import { StorageError } from '../storage/index.js';
import { renderAnalysis } from './render.js';
import { DiscordInterfaceError, type DiscordEvent, type DiscordInterface, type DiscordInterfaceDependencies, type DiscordInterfaceOptions, type ErrorCode } from './types.js';
import { copySettings, ensure, id, integer, keys, matchId, privateMentions, snowflake } from './values.js';

const nativeClock: Clock = { now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const commands = new Set(['worst', 'worst-status', 'worst-reanalyze']);
const unavailable = 'Задача не найдена или недоступна.';
const steps: Record<Job['step'], string> = {
  'load-match': 'Забираю составы и статистику из OpenDota.',
  'wait-parse': 'Жду, пока OpenDota разберёт реплей. Потом продолжу.',
  'build-facts': 'Собираю стату всех пяти союзников.',
  analyze: 'Смотрю, кто где насрал, и собираю разбор.',
  publish: 'Разбор готов — отправляю пост в этот канал.',
};
const reasons: Record<string, string> = {
  'live-disabled': 'Реальный анализ выключен.', 'experimental-disabled': 'Экспериментальный пакет не разрешён.', 'budget-unknown': 'Неизвестен расход прежнего запроса.',
  'budget-exhausted': 'Общий лимит расходов исчерпан.', 'parse-disabled': 'Запрос разбора реплея выключен.', 'parse-pending': 'Реплей ещё разбирается.',
  'parse-timeout': 'Реплей не разобран за отведённый срок.', 'publisher-unavailable': 'Публикация сейчас недоступна.', 'publication-invalid': 'Сообщение не прошло проверку.',
  'shared-parse-unknown': 'Исход прежнего запроса реплея требует проверки.', 'input-changed': 'Данные изменились: нужна новая версия анализа.',
  'publication-forbidden': 'Discord отклонил публикацию: проверь права бота в канале.', 'publication-unavailable': 'Исходный канал публикации недоступен.',
  'publication-invalid-message': 'Discord отклонил сообщение.', 'publication-rate-limited': 'Discord ограничил отправку; автоматического повтора нет.',
  'publication-transport-error': 'Доставка сообщения не подтверждена.', 'publication-pending': 'Исход отправки ещё не подтверждён.',
  aborted: 'Операция остановлена.', 'eligibility-changed': 'Пригодность матча или сторона изменились.',
  'analysis-profile-unavailable': 'Материалы профиля анализа недоступны.', 'gemini-recovery-unavailable': 'Сверка запроса недоступна. Нужна ручная проверка.',
  'gemini-request-recorded': 'OpenRouter зарегистрировал запрос. Повтор не запускается.', 'gemini-retry-consumed': 'Разрешённый повтор уже использован.',
};
interface Active { controller: AbortController; promise: Promise<void>; timer?: unknown; cancelled?: 'timeout' | 'stopped' }

class Interface implements DiscordInterface {
  private readonly settings: DiscordInterfaceOptions['settings'];
  private readonly timeout: number;
  private readonly deps: DiscordInterfaceDependencies;
  private readonly clock: Clock;
  private readonly active = new Map<string, Active>();
  private attached = false;
  private stopped = false;
  private readonly listener = (interaction: Interaction): void => { void this.handleInteraction(interaction).catch(() => this.emit({ type: 'error', code: 'pipeline-failure' })); };
  constructor(options: DiscordInterfaceOptions, dependencies: DiscordInterfaceDependencies) {
    try {
      keys(options, ['settings'], ['requestTimeoutMs']); keys(dependencies, ['client', 'pipeline', 'storage'], ['clock', 'onEvent']);
      this.settings = copySettings(options.settings); this.timeout = options.requestTimeoutMs ?? 60000; ensure(integer(this.timeout, 1, 60000));
      for (const [port, methods] of [[dependencies.client, ['on', 'off']], [dependencies.pipeline, ['requestMatch', 'requestReanalysis', 'getStatus']], [dependencies.storage, ['getJobArtifacts']]] as const) {
        ensure(port && methods.every(method => typeof (port as unknown as Record<string, unknown>)[method] === 'function'));
      }
      if (dependencies.clock !== undefined) ensure(dependencies.clock && ['now', 'setTimeout', 'clearTimeout'].every(method => typeof (dependencies.clock as unknown as Record<string, unknown>)[method] === 'function'));
      ensure(dependencies.onEvent === undefined || typeof dependencies.onEvent === 'function'); this.deps = { ...dependencies }; this.clock = dependencies.clock ?? nativeClock;
    } catch { throw new DiscordInterfaceError('invalid-config', 'configure'); }
  }
  private emit(event: DiscordEvent): void { try { void Promise.resolve(this.deps.onEvent?.(Object.freeze(event))).catch(() => {}); } catch {} }
  private disable(except?: Active): void {
    this.stopped = true;
    if (this.attached) { this.deps.client.off(Events.InteractionCreate, this.listener); this.attached = false; }
    for (const active of this.active.values()) if (active !== except) { active.cancelled = 'stopped'; active.controller.abort(); }
  }
  private scope(job: Job): boolean { return job.settings.guildId === this.settings.guildId && job.settings.channelId === this.settings.channelId; }
  private limited<T>(promise: Promise<T>, active: Active): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DiscordInterfaceError(active.cancelled ?? 'aborted', 'command'));
      if (active.controller.signal.aborted) { void promise.catch(() => {}); abort(); return; }
      active.controller.signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => active.controller.signal.removeEventListener('abort', abort));
    });
  }
  private timer(active: Active, ms: number): void {
    if (active.timer !== undefined) this.clock.clearTimeout(active.timer);
    active.timer = this.clock.setTimeout(() => { active.cancelled = 'timeout'; active.controller.abort(); }, ms);
  }
  private async reply(interaction: ChatInputCommandInteraction, content: string, active: Active, deferred = false, extra: InteractionEditReplyOptions = {}): Promise<void> {
    const body = { content, allowedMentions: { ...privateMentions, parse: [], users: [], roles: [] }, ...extra };
    try {
      if (deferred) await this.limited(interaction.editReply(body), active);
      else await this.limited(interaction.reply({ ...body, flags: MessageFlags.Ephemeral } as Parameters<typeof interaction.reply>[0]), active);
    } catch { this.emit({ type: 'error', code: 'reply-failed', interactionId: interaction.id }); }
  }
  private status(job: Job, attention = false, billingUnknown = false, reservedCostUsd = 0, publicationMode = 'automatic'): string {
    const match = `матча #${job.matchId}`;
    const onCommand = publicationMode === 'on-command' && job.origin === 'automatic';
    const states: Record<Job['state'], string> = {
      queued: `⏳ **Матч #${job.matchId} в очереди на разбор.**\nПосмотрю, кто где насрал, и соберу разбор.${onCommand ? ' Сохраню его, а в канал скину только по твоей команде.' : ' Когда будет готово — скину сюда.'}`,
      running: `🔎 **Разбираю матч #${job.matchId}.**\n${steps[job.step]}`,
      waiting: `⏳ **Разбор ${match} пока ждёт.**\n${job.step === 'wait-parse' ? steps[job.step] : 'Сейчас не получается продолжить. Попробую ещё раз позже.'}`,
      'needs-attention': `⚠️ **Разбор ${match} приостановлен.**`,
      succeeded: `✅ **Разбор ${match} готов.**`,
      failed: `❌ **Не получилось закончить разбор ${match}.**`,
    };
    const lines = [states[job.state]];
    const ready = job.reason === 'publication-ready', requested = job.reason === 'publication-requested';
    if (ready) lines[0] = `✅ **Разбор ${match} готов и ждёт команды на публикацию.**`;
    else if (requested) lines[0] = `📨 **Разбор ${match} готов.**\nПубликация в очереди — скоро пост появится здесь.`;
    else if (job.reason) lines.push(reasons[job.reason] ?? 'Нужно проверить, что случилось. Обратись к администратору бота.');
    if (attention) lines.push('Нужна проверка администратора. Сам повторять анализ не буду.');
    if (billingUnknown) lines.push('Стоимость запроса неизвестна.');
    if (reservedCostUsd > 0) lines.push(`Резерв бюджета: $${reservedCostUsd.toFixed(6)}; это не подтверждённое списание.`);
    if (onCommand && !ready && !requested && ['queued', 'running', 'waiting'].includes(job.state)) lines.push('Когда разбор будет готов, повтори команду, чтобы выложить его в канал.');
    lines.push(`\n${ready ? 'Опубликовать в этом канале' : 'Проверить состояние можно той же командой'}: \`/worst match_id:${job.matchId} side:${job.side}\`.`,
      `Служебный номер: ||${job.id}||${job.revision > 1 ? ` · повторный разбор №${job.revision}` : ''}`);
    return lines.join('\n');
  }
  private result(result: StoredResult | null): { content: string; embeds?: ReturnType<typeof renderAnalysis>[] } {
    if (!result || !this.scope(result.job)) return { content: '' };
    const artifacts = this.deps.storage.getJobArtifacts(result.job.id);
    ensure(artifacts.bundle && artifacts.snapshot, 'storage-failure', 'command');
    const common = { job: result.job, snapshot: artifacts.snapshot };
    const embed = result.analysisProfile === 'gemini' && artifacts.analysisProfile === 'gemini'
      ? renderAnalysis({ ...common, analysisProfile: 'gemini', analysis: result.attempt, bundle: artifacts.bundle })
      : result.analysisProfile === 'legacy' && artifacts.analysisProfile === 'legacy'
        ? renderAnalysis({ ...common, analysis: result.attempt, bundle: artifacts.bundle }) : null;
    ensure(embed, 'storage-failure', 'command');
    const publication = result.publications.find(item => item.outcome && 'messageId' in item.outcome);
    const messageId = publication?.outcome && 'messageId' in publication.outcome ? publication.outcome.messageId : null;
    const waiting = ['publication-ready', 'publication-requested'].includes(result.job.reason ?? '') && result.publications.length === 0;
    return { content: `\n\nПоследний готовый разбор · версия ${result.job.revision}.${messageId && snowflake(messageId) ? `\n[Открыть пост с разбором](https://discord.com/channels/${result.job.settings.guildId}/${result.job.settings.channelId}/${messageId})` : waiting ? '\nРазбор сохранён. Пост ещё не опубликован.' : '\nРазбор сохранён, но отправка поста в канал не подтверждена.'}`, embeds: [embed] };
  }
  private safeError(error: unknown, active: Active): ErrorCode {
    if (error instanceof StorageError || error instanceof PipelineError && error.code === 'storage-failure' || error instanceof DiscordInterfaceError && error.code === 'storage-failure') { this.disable(active); return 'storage-failure'; }
    if (error instanceof DiscordInterfaceError) return error.code;
    if (error instanceof PipelineError && ['not-found', 'conflict', 'aborted', 'stopped'].includes(error.code)) return error.code as ErrorCode;
    return 'pipeline-failure';
  }
  private async process(interaction: ChatInputCommandInteraction, active: Active): Promise<void> {
    let deferred = false;
    try {
      this.timer(active, 3000);
      if (interaction.guildId !== this.settings.guildId || interaction.channelId !== this.settings.channelId || interaction.channel?.isThread()) {
        await this.reply(interaction, 'Команда доступна только в заданном канале сервера.', active); return;
      }
      if (interaction.commandName === 'worst-reanalyze' && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await this.reply(interaction, 'Повторный анализ доступен только администратору сервера.', active); return;
      }
      ensure(snowflake(interaction.id), 'invalid-input', 'command');
      const jobId = interaction.commandName === 'worst-status' ? interaction.options.getString('job_id') : null;
      if (interaction.commandName === 'worst-status') ensure(id(jobId), 'invalid-input', 'command');
      const match = jobId === null ? matchId(interaction.options.getString('match_id')) : null;
      const side = jobId === null ? interaction.options.getString('side') : null;
      ensure(side === 'radiant' || side === 'dire' || side === null && interaction.commandName !== 'worst-reanalyze', 'invalid-input', 'command');
      try { await this.limited(interaction.deferReply({ flags: MessageFlags.Ephemeral }), active); deferred = true; }
      catch { this.emit({ type: 'error', code: 'ack-failed', interactionId: interaction.id }); return; }
      if (active.controller.signal.aborted || this.stopped) return;
      this.timer(active, this.timeout);
      if (jobId !== null) {
        const status = this.deps.pipeline.getStatus({ jobId });
        if (!this.scope(status.job)) { await this.reply(interaction, unavailable, active, true); return; }
        const result = this.result(status.result);
        await this.reply(interaction, this.status(status.job, status.attention, status.billingUnknown, status.reservedCostUsd, status.publicationMode) + result.content, active, true, { embeds: result.embeds ?? [] });
        this.emit({ type: 'command', code: 'completed', interactionId: interaction.id, guildId: interaction.guildId!, channelId: interaction.channelId, jobId: status.job.id }); return;
      }
      const requested: MatchRequestResult = interaction.commandName === 'worst-reanalyze'
        ? await this.limited(this.deps.pipeline.requestReanalysis({ requestId: `discord_${interaction.id}`, matchId: match!, side: side as 'radiant' | 'dire' }, { signal: active.controller.signal }), active)
        : await this.limited(this.deps.pipeline.requestMatch({ matchId: match!, ...(side ? { side } : {}) }, { signal: active.controller.signal }), active);
      if (requested.status === 'awaiting-data') {
        const text = requested.nextCheckAt === null
          ? 'Матч найден, но автоматическое ожидание данных OpenDota остановлено. Можно повторить /worst позже; если данные появятся, команда проверит их заново.'
          : 'Матч найден. Ожидаем данные OpenDota. Следующая проверка запланирована; время готовности пока неизвестно.';
        await this.reply(interaction, text, active, true); return;
      }
      if (!('job' in requested)) {
        await this.reply(interaction, requested.status === 'requires-side' ? `Не удалось определить сторону. Повтори: /worst match_id:${match} side:radiant или side:dire.` : 'Матч не подходит для анализа: нужен завершённый поддерживаемый рейтинговый матч с полной пятёркой союзников.', active, true); return;
      }
      if (!this.scope(requested.job)) { await this.reply(interaction, unavailable, active, true); return; }
      const result = this.result(requested.result);
      const status = this.deps.pipeline.getStatus({ jobId: requested.job.id });
      await this.reply(interaction, `${this.status(status.job, status.attention, status.billingUnknown, status.reservedCostUsd, status.publicationMode)}${result.content}`, active, true, { embeds: result.embeds ?? [] });
      this.emit({ type: 'command', code: 'completed', interactionId: interaction.id, guildId: interaction.guildId!, channelId: interaction.channelId, jobId: requested.job.id });
    } catch (error) {
      const code = this.safeError(error, active);
      this.emit({ type: 'error', code, ...(snowflake(interaction.id) ? { interactionId: interaction.id } : {}) });
      const text = code === 'not-found' ? unavailable : code === 'conflict' ? 'Для этой стороны уже выполняется задача или запрос повторного анализа конфликтует с сохранённым.'
        : code === 'invalid-input' ? 'Укажи ID матча числом без ссылки и пробелов, допустимую сторону или корректный ID задачи.'
        : code === 'timeout' ? 'Время ответа истекло. Постановка не подтверждена; обычный повторный запрос найдёт сохранённую задачу, если она создана.'
        : 'Не удалось подтвердить операцию. Сохранённые задачи не удалены; автоматического повторного анализа нет.';
      if (code === 'timeout' && deferred && !this.stopped) { active.controller = new AbortController(); active.cancelled = undefined; this.timer(active, 3000); }
      if (!active.controller.signal.aborted) await this.reply(interaction, text, active, deferred);
    } finally { if (active.timer !== undefined) this.clock.clearTimeout(active.timer); }
  }
  async handleInteraction(interaction: Interaction): Promise<{ status: 'ignored' | 'handled' }> {
    ensure(!this.stopped, 'stopped', 'lifecycle');
    if (!interaction.isChatInputCommand() || !commands.has(interaction.commandName)) return { status: 'ignored' };
    if (this.active.has(interaction.id)) return { status: 'handled' };
    const active: Active = { controller: new AbortController(), promise: Promise.resolve() }; this.active.set(interaction.id, active);
    active.promise = this.process(interaction, active);
    try { await active.promise; return { status: 'handled' }; } finally { this.active.delete(interaction.id); }
  }
  attach(): void { ensure(!this.stopped, 'stopped', 'lifecycle'); if (!this.attached) { this.deps.client.on(Events.InteractionCreate, this.listener); this.attached = true; } }
  async stop(): Promise<void> { this.disable(); await Promise.allSettled([...this.active.values()].map(item => item.promise)); }
}

export function createDiscordInterface(options: DiscordInterfaceOptions, dependencies: DiscordInterfaceDependencies): DiscordInterface { return new Interface(options, dependencies); }
