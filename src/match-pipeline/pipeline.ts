import { createHash, randomUUID } from 'node:crypto';
import { analyzeMatch, analyzeGeminiMatch, checkGeminiRecovery, prepareAnalysis, prepareGeminiAnalysis, geminiRecoveryEligible, isGeminiAttempt, AnalysisError, type RuntimeAttempt } from '../match-analysis/index.js';
import { FactsError, prepareMatchFacts, prepareCompactMatchFacts } from '../match-facts/index.js';
import { OpenDotaError, type MatchSnapshot, type OpenDotaErrorSummary, type PlayerMatch } from '../opendota/index.js';
import { StorageError, type Claim, type DiscoveryCandidate, type Inputs, type JobArtifacts, type Receipt, type PublicationOutcome } from '../storage/index.js';
import { SteamHistoryError } from '../steam/index.js';
import { classify, endAt, supported } from './classify.js';
import { configure, ensure, fields, id, integer, object, snowflake } from './config.js';
import { PipelineError, PublicationError, type Clock, type DiscoveryReport, type Job, type MatchPipeline, type MatchRequestResult,
  type PipelineConfig, type PipelineDependencies, type PipelineEvent, type PipelineOptions, type PipelineStatus, type ProcessResult,
  type PublicationInput, type RequestOptions, type Side } from './types.js';

interface Execution { job: Job; claim: Claim; controller: AbortController; lost: boolean; timer?: unknown }
const nativeClock: Clock = { now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
const transient = new Set(['network_error', 'timeout', 'upstream_error', 'rate_limited']);
const outcome = (receipt: Receipt): RuntimeAttempt | null => receipt.kind === 'analysis' ? receipt.outcome as RuntimeAttempt | null : null;
const reasons = /^(?:parse-disabled|parse-pending|parse-timeout|parse-request-failed|shared-parse-unknown|live-disabled|experimental-disabled|publisher-unavailable|publication-invalid|publication-pending|publication-late-outcome|publication-failed|budget-unknown|budget-exhausted|estimated-cost-exceeded|input-changed|eligibility-changed|facts-invalid|analysis-input-invalid|released-analysis-present|analysis-not-sent-after-start|external-outcome-unknown|processing-failed|aborted|opendota-(?:invalid_argument|not_found|unauthorized|forbidden|bad_request|rate_limited|network_error|timeout|upstream_error|invalid_response|aborted)|analysis-(?:preflight-failed|invalid-output|api-error|transport-error|timed-out|aborted|cooldown|metadata-unavailable|unsupported-endpoint|unknown-price|estimated-cost-exceeded|before-send-failed|invalid-input|missing-key|secret-in-input|secret-in-output)|publication-(?:unavailable|forbidden|invalid-message|rate-limited|transport-error|publication-unknown))$/;

class Pipeline implements MatchPipeline {
  readonly config: PipelineConfig;
  private readonly deps: PipelineDependencies;
  private readonly clock: Clock;
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private fatal: PipelineError | null = null;
  private working = false;
  private scanning = false;
  private running = false;
  constructor(options: PipelineOptions, dependencies: PipelineDependencies) {
    const configured = configure(options, dependencies); this.config = configured.config; this.deps = configured.dependencies; this.clock = dependencies.clock ?? nativeClock;
  }
  private emit(event: PipelineEvent): void {
    try { void Promise.resolve(this.deps.onEvent?.(Object.freeze(event))).catch(() => {}); } catch { /* Диагностика не меняет журнал. */ }
  }
  private failStorage(): PipelineError {
    this.fatal ??= new PipelineError('storage-failure'); this.controller.abort(); this.emit({ type: 'error', code: 'storage-failure' }); return this.fatal;
  }
  private db<T>(call: () => T): T {
    try { return call(); } catch (error) {
      if (error instanceof StorageError && error.code === 'lease-lost') throw new PipelineError('lease-lost');
      throw this.failStorage();
    }
  }
  private check(signal?: AbortSignal): void {
    if (this.fatal) throw this.fatal;
    if (this.stopped) throw new PipelineError('stopped');
    if (signal?.aborted) throw new PipelineError('aborted');
  }
  private track<T>(call: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(call); this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {}); return promise;
  }
  private signal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal; }
  private cutoff(): number { if (this.config.automaticSince === undefined) throw new PipelineError('automatic-since-required'); return this.config.automaticSince; }
  private discoveryContext(): string {
    return createHash('sha256').update(JSON.stringify({ steamAccountIds: [...this.deps.settings.steamAccountIds].sort((a, b) => a - b),
      guildId: this.deps.settings.guildId, channelId: this.deps.settings.channelId, automaticSince: this.cutoff() })).digest('hex');
  }
  private jobEvent(job: Job): void {
    const { knownCostUsd, reservedCostUsd, uncoveredUnknownCount } = this.db(() => this.deps.storage.getBillingSummary({ jobId: job.id }));
    const safe = job.reason && (reasons.test(job.reason) || /^(?:analysis-profile-unavailable|publication-(?:ready|requested)|gemini-(?:recovery-unavailable|request-recorded|retry-consumed))$/.test(job.reason));
    this.emit({ type: 'job', jobId: job.id, matchId: job.matchId, side: job.side, revision: job.revision, state: job.state, step: job.step,
      knownCostUsd, reservedCostUsd, uncoveredUnknownCount, ...(job.reason ? { code: safe ? job.reason : 'stored-reason' } : {}) });
  }
  private readOptions(options: RequestOptions): void { fields(options, [], ['signal']); ensure(options.signal === undefined || options.signal instanceof AbortSignal); }
  private requestInput(input: unknown, revision = false): asserts input is { matchId: number; side?: Side; requestId?: string } {
    fields(input, revision ? ['matchId', 'side', 'requestId'] : ['matchId'], revision ? [] : ['side']);
    ensure(integer(input.matchId, 1) && (input.side === 'radiant' || input.side === 'dire' || !revision && input.side === undefined) && (!revision || id(input.requestId)));
  }
  private enqueue(matchId: number, side: Side, origin: Job['origin']): MatchRequestResult {
    const previous = this.db(() => this.deps.storage.getLatestJob(matchId, side));
    let job = this.db(() => this.deps.storage.enqueueInitial({ matchId, side, origin, settings: this.deps.settings, analysisProfile: this.config.analysisProfile }));
    if (origin === 'manual' && job.origin === 'automatic' && this.config.publicationMode === 'on-command'
      && job.settings.guildId === this.deps.settings.guildId && job.settings.channelId === this.deps.settings.channelId) {
      job = this.db(() => this.deps.storage.requestPublication({ jobId: job.id, guildId: this.deps.settings.guildId, channelId: this.deps.settings.channelId }));
    }
    this.jobEvent(job); return { status: previous ? 'existing' : 'queued', job, result: this.db(() => this.deps.storage.getLatestResult(matchId, side)) };
  }
  private existingRequest(matchId: number, side?: Side): MatchRequestResult | null {
    if (side) return this.db(() => this.deps.storage.getLatestJob(matchId, side)) ? this.enqueue(matchId, side, 'manual') : null;
    const existing = (['radiant', 'dire'] as const).filter(side => this.db(() => this.deps.storage.getLatestJob(matchId, side)));
    if (existing.length > 1) return { status: 'requires-side', matchId, code: 'ambiguous-side' };
    return existing.length === 1 ? this.enqueue(matchId, existing[0], 'manual') : null;
  }
  requestMatch(input: { matchId: number; side?: Side }, options: RequestOptions = {}): Promise<MatchRequestResult> {
    return this.track(async () => {
      this.readOptions(options); this.check(options.signal); this.requestInput(input); const signal = this.signal(options.signal);
      const existing = this.existingRequest(input.matchId, input.side); if (existing) return existing;
      let candidate = this.config.historySource === 'steam' && this.config.automaticSince !== undefined
        ? this.db(() => this.deps.storage.getDiscoveryCandidate(this.discoveryContext(), input.matchId)) : null;
      if (candidate?.state === 'pending') {
        if (candidate.expiresAt <= this.clock.now()) candidate = this.decide(candidate, 'needs-attention', 'discovery-timeout');
        else if (candidate.reason !== null) return { status: 'awaiting-data', matchId: input.matchId, code: candidate.reason, nextCheckAt: candidate.nextCheckAt };
      }
      let snapshot: MatchSnapshot;
      try { snapshot = await this.deps.opendota.getMatch(input.matchId, { fresh: true, signal }); }
      catch (error) {
        this.check(signal);
        const existing = this.existingRequest(input.matchId, input.side); if (existing) return existing;
        if (candidate) candidate = this.db(() => this.deps.storage.getDiscoveryCandidate(this.discoveryContext(), input.matchId));
        if (candidate?.state === 'pending') {
          const retry = error instanceof OpenDotaError && (error.code === 'not_found' || transient.has(error.code));
          if (!retry) throw new PipelineError('opendota-failure');
          candidate = this.decide(candidate, 'pending', this.readCode(error).replaceAll('_', '-'), error instanceof OpenDotaError ? error.retryAt ?? 0 : 0);
          return { status: 'awaiting-data', matchId: input.matchId, code: candidate.reason!, nextCheckAt: candidate.nextCheckAt };
        }
        if (candidate?.state === 'needs-attention') return { status: 'awaiting-data', matchId: input.matchId, code: candidate.reason ?? 'discovery-stopped', nextCheckAt: null };
        throw new PipelineError('opendota-failure');
      }
      this.check(signal); const concurrent = this.existingRequest(input.matchId, input.side); if (concurrent) return concurrent;
      if (candidate) candidate = this.db(() => this.deps.storage.getDiscoveryCandidate(this.discoveryContext(), input.matchId));
      const result = classify(snapshot.data, this.deps.settings, 'manual', input.side);
      if (candidate?.state === 'pending' && (!endAt(snapshot.data, this.clock.now()) || snapshot.data.radiant_win === null || result.status === 'rejected' && result.code === 'incomplete-allies')) {
        candidate = this.decide(candidate, 'pending', 'opendota-pending');
        return { status: 'awaiting-data', matchId: input.matchId, code: candidate.reason!, nextCheckAt: candidate.nextCheckAt };
      }
      if (candidate?.state === 'needs-attention' && (!endAt(snapshot.data, this.clock.now()) || snapshot.data.radiant_win === null || result.status === 'rejected' && result.code === 'incomplete-allies')) {
        return { status: 'awaiting-data', matchId: input.matchId, code: candidate.reason ?? 'discovery-stopped', nextCheckAt: null };
      }
      if (result.status !== 'eligible') return { ...result, matchId: input.matchId };
      return this.enqueue(input.matchId, result.side, 'manual');
    });
  }
  requestReanalysis(input: { requestId: string; matchId: number; side: Side }, options: RequestOptions = {}): Promise<MatchRequestResult> {
    return this.track(async () => {
      this.readOptions(options); this.check(options.signal); this.requestInput(input, true); const signal = this.signal(options.signal);
      let snapshot: MatchSnapshot;
      try { snapshot = await this.deps.opendota.getMatch(input.matchId, { fresh: true, signal }); }
      catch { this.check(signal); throw new PipelineError('opendota-failure'); }
      this.check(signal); const classified = classify(snapshot.data, this.deps.settings, 'manual', input.side);
      if (classified.status !== 'eligible') return { ...classified, matchId: input.matchId };
      let job: Job;
      try { job = this.deps.storage.createRevision({ ...input, settings: this.deps.settings, analysisProfile: this.config.analysisProfile }); }
      catch (error) { if (error instanceof StorageError && (error.code === 'conflict' || error.code === 'not-found')) throw new PipelineError(error.code); throw this.failStorage(); }
      this.jobEvent(job); return { status: 'queued', job, result: this.db(() => this.deps.storage.getLatestResult(job.matchId, job.side)) };
    });
  }
  discoverOnce(options: RequestOptions = {}): Promise<DiscoveryReport> {
    return this.track(async () => {
      this.readOptions(options); this.check(options.signal); const cutoff = this.cutoff(), scanAt = this.clock.now();
      const report: DiscoveryReport = { status: this.scanning ? 'busy' : 'complete', scanAt, cutoff, pages: 0, candidates: 0, queued: [], existing: [], rejected: [], requiresSide: [], errors: [], partial: false };
      if (this.scanning) return report;
      this.scanning = true; const signal = this.signal(options.signal), candidates = new Map<number, PlayerMatch[]>();
      try {
        if (this.config.historySource === 'steam') return await this.discoverSteam(report, signal);
        for (const accountId of this.deps.settings.steamAccountIds) {
          for (let page = 0; page < this.config.maxPagesPerAccount; page++) {
            this.check(signal); let rows: PlayerMatch[];
            try { rows = await this.deps.opendota.getPlayerMatches(accountId, { limit: this.config.pageSize, offset: page * this.config.pageSize, signal }); }
            catch (error) { this.check(signal); report.partial = true; report.errors.push({ accountId, code: this.readCode(error) }); break; }
            this.check(signal); report.pages++;
            for (const row of rows) {
              if (!integer(row.match_id, 1)) continue;
              const previous = candidates.get(row.match_id);
              if (previous) previous.push(row);
              else if (candidates.size < this.config.maxCandidatesPerScan) candidates.set(row.match_id, [row]);
              else report.partial = true;
            }
            if (rows.length < this.config.pageSize) break;
            if (page + 1 === this.config.maxPagesPerAccount) report.partial = true;
          }
        }
        report.candidates = candidates.size; if (candidates.size === this.config.maxCandidatesPerScan) report.partial = true;
        for (const [matchId, rows] of candidates) {
          this.check(signal); this.db(() => this.deps.storage.recordMatch({ matchId, observedAt: scanAt }));
          if (!rows.some(row => supported(row) && (endAt(row, scanAt) ?? -1) > cutoff)) { report.rejected.push({ matchId, code: 'outside-window-or-unsupported' }); continue; }
          const existing = (['radiant', 'dire'] as const).map(side => this.db(() => this.deps.storage.getLatestJob(matchId, side)))
            .find(job => job?.origin === 'automatic' && JSON.stringify(job.settings) === JSON.stringify(this.deps.settings));
          if (existing) { report.existing.push(existing.id); continue; }
          let snapshot: MatchSnapshot;
          try { snapshot = await this.deps.opendota.getMatch(matchId, { fresh: true, signal }); }
          catch (error) { this.check(signal); report.partial = true; report.errors.push({ matchId, code: this.readCode(error) }); continue; }
          this.check(signal);
          if ((endAt(snapshot.data, scanAt) ?? -1) <= cutoff) { report.rejected.push({ matchId, code: 'outside-window' }); continue; }
          const result = classify(snapshot.data, this.deps.settings, 'automatic');
          if (result.status === 'requires-side') report.requiresSide.push(matchId);
          else if (result.status === 'rejected') report.rejected.push({ matchId, code: result.code });
          else {
            const queued = this.enqueue(matchId, result.side, 'automatic');
            if (queued.status === 'queued' || queued.status === 'existing') report[queued.status].push(queued.job.id);
          }
        }
        this.emit({ type: 'discovery', pages: report.pages, candidates: report.candidates, queued: report.queued.length, existing: report.existing.length,
          rejected: report.rejected.length, requiresSide: report.requiresSide.length, errors: report.errors.length, partial: report.partial });
        return report;
      } finally { this.scanning = false; }
    });
  }
  private decide(candidate: DiscoveryCandidate, state: DiscoveryCandidate['state'], reason: string | null, retryAt = 0): DiscoveryCandidate {
    return this.db(() => this.deps.storage.decideDiscoveryCandidate({ contextKey: candidate.contextKey, matchId: candidate.matchId, state, reason,
      nextCheckAt: state === 'pending' ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.clock.now() + this.config.discoveryRetryMs, retryAt)) : null }));
  }
  private async discoverSteam(report: DiscoveryReport, signal: AbortSignal): Promise<DiscoveryReport> {
    ensure(this.deps.steam, 'invalid-config');
    const contextKey = this.discoveryContext(), seen = new Set<number>(); let added = 0, blocked = false;
    report.deferred = 0; report.checks = 0; report.accountsChecked = 0;
    for (const accountId of this.deps.settings.steamAccountIds) {
      if (blocked) { report.errors.push({ accountId, code: 'steam-unchecked' }); continue; }
      report.accountsChecked++; let cursor: number | undefined;
      for (let page = 0; page < this.config.maxPagesPerAccount; page++) {
        this.check(signal);
        let history;
        try { history = await this.deps.steam.getMatchHistory(accountId, { limit: this.config.pageSize, ...(cursor === undefined ? {} : { startAtMatchId: cursor }), signal }); }
        catch (error) {
          this.check(signal); const code = error instanceof SteamHistoryError ? `steam-${error.code}` : 'steam-failure';
          report.partial = true; report.errors.push({ accountId, code }); this.emit({ type: 'discovery', accountId, code });
          blocked = error instanceof SteamHistoryError && ['unauthorized', 'forbidden', 'rate-limited'].includes(error.code); break;
        }
        this.check(signal); report.pages++;
        for (const row of history.matches) {
          if (seen.has(row.matchId)) continue; seen.add(row.matchId);
          const previous = this.db(() => this.deps.storage.getDiscoveryCandidate(contextKey, row.matchId));
          if (!previous && added >= this.config.maxCandidatesPerScan) { report.deferred++; report.partial = true; continue; }
          const expiresAt = report.scanAt + this.config.discoveryTimeoutMs;
          ensure(integer(expiresAt, report.scanAt + 1), 'invalid-config');
          this.db(() => this.deps.storage.observeDiscoveryCandidate({ contextKey, matchId: row.matchId, observedAt: report.scanAt, expiresAt }));
          if (!previous) added++;
        }
        if (history.nextStartAtMatchId === null) break;
        cursor = history.nextStartAtMatchId;
        if (page + 1 === this.config.maxPagesPerAccount) report.partial = true;
      }
    }
    report.candidates = seen.size;
    const due = this.db(() => this.deps.storage.listDueDiscoveryCandidates(contextKey, this.config.maxDiscoveryChecksPerScan));
    for (const candidate of due) {
      this.check(signal); report.checks++;
      if (candidate.expiresAt <= this.clock.now()) { this.decide(candidate, 'needs-attention', 'discovery-timeout'); report.rejected.push({ matchId: candidate.matchId, code: 'discovery-timeout' }); continue; }
      let snapshot: MatchSnapshot;
      try { snapshot = await this.deps.opendota.getMatch(candidate.matchId, { fresh: true, signal }); }
      catch (error) {
        this.check(signal); const code = this.readCode(error).replaceAll('_', '-');
        const retry = error instanceof OpenDotaError && (error.code === 'not_found' || transient.has(error.code));
        this.decide(candidate, retry ? 'pending' : 'needs-attention', code, error instanceof OpenDotaError ? error.retryAt ?? 0 : 0);
        report.partial = true; report.errors.push({ matchId: candidate.matchId, code }); continue;
      }
      this.check(signal);
      if (candidate.expiresAt <= this.clock.now()) { this.decide(candidate, 'needs-attention', 'discovery-timeout'); report.rejected.push({ matchId: candidate.matchId, code: 'discovery-timeout' }); continue; }
      const end = endAt(snapshot.data, this.clock.now());
      if (end === null || snapshot.data.radiant_win === null) { this.decide(candidate, 'pending', 'opendota-pending'); continue; }
      if (end <= report.cutoff || !supported(snapshot.data)) {
        const code = end <= report.cutoff ? 'outside-window' : 'unsupported-match';
        this.decide(candidate, 'ignored', code); report.rejected.push({ matchId: candidate.matchId, code }); continue;
      }
      const result = classify(snapshot.data, this.deps.settings, 'automatic');
      if (result.status === 'eligible') {
        const queued = this.enqueue(candidate.matchId, result.side, 'automatic');
        if ('job' in queued) report[queued.status === 'queued' ? 'queued' : 'existing'].push(queued.job.id);
        this.decide(candidate, 'admitted', null);
      } else if (result.status === 'rejected' && (result.code === 'incomplete-allies' || result.code === 'not-group-match' && snapshot.data.players.length < 10)) {
        this.decide(candidate, 'pending', 'incomplete-allies');
      } else {
        this.decide(candidate, 'needs-attention', result.code);
        if (result.status === 'requires-side') report.requiresSide.push(candidate.matchId);
        else report.rejected.push({ matchId: candidate.matchId, code: result.code });
      }
    }
    const counts = this.db(() => this.deps.storage.getDiscoveryCounts(contextKey));
    report.pending = counts.pending; report.deferred += counts.due; if (counts.pending > 0) report.partial = true;
    this.emit({ type: 'discovery', pages: report.pages, candidates: report.candidates, queued: report.queued.length, existing: report.existing.length,
      rejected: report.rejected.length, requiresSide: report.requiresSide.length, errors: report.errors.length, partial: report.partial,
      pending: report.pending, deferred: report.deferred, checks: report.checks, accountsChecked: report.accountsChecked });
    return report;
  }
  private readCode(error: unknown): string { return error instanceof OpenDotaError ? `opendota-${error.code}` : 'opendota-failure'; }
  private owned(ctx: Execution): void {
    if (ctx.lost) throw new PipelineError('lease-lost');
    const job = this.db(() => this.deps.storage.getJob(ctx.job.id));
    if (job.state !== 'running' || job.version !== ctx.claim.version || job.leaseToken !== ctx.claim.token || job.leaseUntil! <= this.clock.now()) {
      ctx.lost = true; ctx.controller.abort(); throw new PipelineError('lease-lost');
    }
  }
  private guard(ctx: Execution): void { this.owned(ctx); this.check(ctx.controller.signal); }
  private heartbeat(ctx: Execution): void {
    ctx.timer = this.clock.setTimeout(() => {
      try { ctx.claim = this.db(() => this.deps.storage.renewClaim(ctx.claim)); ctx.job.version = ctx.claim.version; this.heartbeat(ctx); }
      catch (error) { ctx.lost = error instanceof PipelineError && error.code === 'lease-lost'; ctx.controller.abort(); }
    }, 20000);
  }
  private checkpoint(ctx: Execution, step: Job['step'], resultAttemptId?: string): void {
    this.owned(ctx); const current = this.db(() => this.deps.storage.checkpoint(ctx.claim, { step, ...(resultAttemptId ? { resultAttemptId } : {}) }));
    ctx.job = current.job; ctx.claim = current.claim;
  }
  private saveInputs(ctx: Execution, input: Inputs): void {
    this.guard(ctx); const saved = this.db(() => this.deps.storage.saveInputs(ctx.claim, input)); ctx.claim = saved.claim; ctx.job.refs = saved.refs;
  }
  private defer(ctx: Execution, reason: string, delay = this.config.pauseMs, retryAt = 0): Job {
    this.owned(ctx); return this.db(() => this.deps.storage.defer(ctx.claim, { reason, nextRunAt: Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.clock.now() + delay, retryAt)) }));
  }
  private finish(ctx: Execution, state: 'succeeded' | 'failed' | 'needs-attention', reason?: string): Job {
    this.owned(ctx); return this.db(() => this.deps.storage.finish(ctx.claim, { state, ...(reason ? { reason } : {}) }));
  }
  private attempts(ctx: Execution): Receipt[] { return this.db(() => this.deps.storage.listAttempts(ctx.job.id)); }
  private artifacts(ctx: Execution): JobArtifacts { return this.db(() => this.deps.storage.getJobArtifacts(ctx.job.id)); }
  processNext(options: RequestOptions = {}): Promise<ProcessResult> {
    return this.track(async () => {
      this.readOptions(options); this.check(options.signal); if (this.working) return { status: 'busy' };
      this.working = true; let ctx: Execution | undefined;
      try {
        this.db(() => this.deps.storage.recoverInterrupted()); const claimed = this.db(() => this.deps.storage.claimNext());
        if (!claimed) return { status: 'idle' };
        ctx = { ...claimed, controller: new AbortController(), lost: false };
        const signal = this.signal(options.signal), abort = () => ctx!.controller.abort(); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) ctx.controller.abort();
        this.heartbeat(ctx);
        try {
          let job: Job;
          try { job = await this.execute(ctx); }
          catch (error) { job = this.executionError(ctx, error); }
          this.jobEvent(job); return { status: 'processed', job };
        } finally { signal.removeEventListener('abort', abort); }
      } finally { if (ctx?.timer !== undefined) this.clock.clearTimeout(ctx.timer); this.working = false; }
    });
  }
  private executionError(ctx: Execution, error: unknown): Job {
    if (this.fatal) throw this.fatal;
    if (error instanceof PipelineError && error.code === 'lease-lost') { ctx.lost = true; ctx.controller.abort(); return this.db(() => this.deps.storage.getJob(ctx.job.id)); }
    this.owned(ctx);
    if (this.attempts(ctx).some(item => item.unresolved && !item.released)) return this.finish(ctx, 'needs-attention', 'external-outcome-unknown');
    if (ctx.controller.signal.aborted || error instanceof PipelineError && ['aborted', 'stopped'].includes(error.code)) return this.defer(ctx, 'aborted');
    if (error instanceof OpenDotaError) {
      if (transient.has(error.code)) return this.defer(ctx, this.readCode(error), 60000, error.retryAt);
      return this.finish(ctx, 'failed', this.readCode(error));
    }
    if (error instanceof FactsError) return this.finish(ctx, 'failed', 'facts-invalid');
    if (error instanceof AnalysisError) return this.finish(ctx, 'failed', 'analysis-input-invalid');
    return this.finish(ctx, 'failed', 'processing-failed');
  }
  private async execute(ctx: Execution): Promise<Job> {
    this.guard(ctx); const attempts = this.attempts(ctx), artifacts = this.artifacts(ctx);
    const valid = attempts.find(item => !item.released && outcome(item)?.status === 'valid');
    if (valid) this.checkpoint(ctx, 'publish', valid.id);
    const publication = attempts.find(item => item.kind === 'publication' && item.outcome && 'messageId' in item.outcome);
    if (publication) return this.finish(ctx, 'succeeded');
    if (!valid && attempts.some(item => outcome(item) && geminiRecoveryEligible(outcome(item)!)
      && this.db(() => this.deps.storage.getGeminiRecovery(item.id))?.retryAttemptId)) return this.finish(ctx, 'needs-attention', 'gemini-retry-consumed');
    const root = attempts.find(item => outcome(item) && geminiRecoveryEligible(outcome(item)!));
    if (!valid && root && artifacts.analysisProfile === 'gemini') return this.recoverGemini(ctx, artifacts, root);
    if (attempts.some(item => item.unresolved && !item.released && item.id !== valid?.id)) return this.finish(ctx, 'needs-attention', 'external-outcome-unknown');
    if (valid) return this.publish(ctx, artifacts, outcome(valid)!);
    const sentFailure = attempts.find(item => !item.released && outcome(item)?.requestSent);
    if (sentFailure) return this.finish(ctx, 'failed', `analysis-${outcome(sentFailure)!.status}`);
    const parseFailure = attempts.find(item => item.kind === 'parse' && !item.released && item.outcome && 'error' in item.outcome);
    if (parseFailure) return this.finish(ctx, 'failed', 'parse-request-failed');
    if (ctx.job.analysisProfile === 'gemini' && (!this.deps.geminiPrompt || !this.deps.heroMetricsDictionary)) return this.defer(ctx, 'analysis-profile-unavailable');
    this.guard(ctx); const snapshot = await this.deps.opendota.getMatch(ctx.job.matchId, { fresh: true, signal: ctx.controller.signal }); this.guard(ctx);
    if (artifacts.prepared && (!artifacts.snapshot || !this.sameInput(artifacts.snapshot, snapshot))) return this.finish(ctx, 'failed', 'input-changed');
    const eligibility = classify(snapshot.data, ctx.job.settings, ctx.job.origin, ctx.job.origin === 'manual' ? ctx.job.side : undefined);
    if (eligibility.status !== 'eligible' || eligibility.side !== ctx.job.side) return this.finish(ctx, 'failed', 'eligibility-changed');
    if (artifacts.prepared) {
      if (snapshot.parseState !== 'parsed') { this.checkpoint(ctx, 'wait-parse'); return this.waitParse(ctx); }
      this.checkpoint(ctx, 'analyze'); return this.analyze(ctx, artifacts);
    }
    this.saveInputs(ctx, { snapshot });
    if (snapshot.parseState !== 'parsed') { this.checkpoint(ctx, 'wait-parse'); return this.waitParse(ctx); }
    this.checkpoint(ctx, 'build-facts'); this.guard(ctx);
    if (ctx.job.analysisProfile === 'gemini') {
      const bundle = prepareCompactMatchFacts({ matchId: ctx.job.matchId, side: ctx.job.side, data: snapshot.data }, { ...this.deps.facts, heroMetricsDictionary: this.deps.heroMetricsDictionary });
      const prepared = prepareGeminiAnalysis(bundle, this.deps.geminiPrompt!);
      this.saveInputs(ctx, { bundle, prepared }); this.checkpoint(ctx, 'analyze');
      return this.analyze(ctx, { analysisProfile: 'gemini', snapshot, bundle, prepared });
    }
    const bundle = prepareMatchFacts({ matchId: ctx.job.matchId, side: ctx.job.side, data: snapshot.data }, this.deps.facts), prepared = prepareAnalysis(bundle, this.deps.prompt);
    this.saveInputs(ctx, { bundle, prepared }); this.checkpoint(ctx, 'analyze');
    return this.analyze(ctx, { analysisProfile: 'legacy', snapshot, bundle, prepared });
  }
  private sameInput(first: MatchSnapshot, fresh: MatchSnapshot): boolean {
    const essential = (snapshot: MatchSnapshot) => ({ duration: snapshot.data.duration, outcome: snapshot.data.radiant_win, mode: snapshot.data.game_mode, lobby: snapshot.data.lobby_type,
      players: snapshot.data.players.map(player => [player.player_slot, player.hero_id]).sort((a, b) => a[0] - b[0]) });
    return JSON.stringify(essential(first)) === JSON.stringify(essential(fresh));
  }
  private async waitParse(ctx: Execution): Promise<Job> {
    const own = this.attempts(ctx).filter(item => item.kind === 'parse' && (!item.released || item.outcome && 'jobId' in item.outcome));
    const other = this.db(() => this.deps.storage.getLatestJob(ctx.job.matchId, ctx.job.side === 'radiant' ? 'dire' : 'radiant'));
    const shared = other ? this.db(() => this.deps.storage.listAttempts(other.id)).filter(item => item.kind === 'parse' && (!item.released && item.unresolved || item.outcome && 'jobId' in item.outcome)) : [];
    const receipt = own.find(item => item.outcome && 'jobId' in item.outcome) ?? shared[0];
    if (receipt) {
      if (this.clock.now() >= receipt.createdAt + this.config.parseTimeoutMs) return this.finish(ctx, 'failed', 'parse-timeout');
      if (receipt.outcome && 'jobId' in receipt.outcome) {
        this.guard(ctx); await this.deps.opendota.getParseJob(receipt.outcome.jobId, { signal: ctx.controller.signal }); this.guard(ctx);
        return this.defer(ctx, 'parse-pending', this.config.parsePollMs);
      }
      return this.defer(ctx, 'shared-parse-unknown', this.config.parsePollMs);
    }
    if (this.config.mode !== 'live') return this.defer(ctx, 'parse-disabled');
    this.guard(ctx); const admission = this.db(() => this.deps.storage.beginParse(ctx.claim, { attemptId: randomUUID() }));
    try {
      this.guard(ctx); const parsed = await this.deps.opendota.requestParse(ctx.job.matchId, { signal: ctx.controller.signal });
      this.db(() => this.deps.storage.saveParseOutcome(admission.id, { jobId: parsed.jobId }));
    } catch (error) {
      if (this.fatal) throw this.fatal;
      const summary: OpenDotaErrorSummary = error instanceof OpenDotaError ? error.toJSON()
        : { code: 'network_error', operation: 'requestParse', requestMayHaveSucceeded: true };
      this.db(() => this.deps.storage.saveParseOutcome(admission.id, { error: summary }));
      this.owned(ctx); return this.finish(ctx, summary.requestMayHaveSucceeded ? 'needs-attention' : 'failed', 'parse-request-failed');
    }
    this.guard(ctx); return this.defer(ctx, 'parse-pending', this.config.parsePollMs);
  }
  private budget(): { limit: number; reason: null } | { limit: 0; reason: string } {
    const billing = this.db(() => this.deps.storage.getBillingSummary());
    if (billing.uncoveredUnknownCount > 0) return { limit: 0, reason: 'budget-unknown' };
    const remaining = this.config.maxTotalCostUsd! - billing.knownCostUsd - billing.reservedCostUsd;
    if (remaining <= 0) return { limit: 0, reason: 'budget-exhausted' };
    return { limit: Math.min(remaining, this.config.maxEstimatedCostPerAttemptUsd!), reason: null };
  }
  private async analyze(ctx: Execution, artifacts: JobArtifacts, retry?: Receipt): Promise<Job> {
    if (this.config.mode !== 'live') return this.defer(ctx, 'live-disabled');
    if (this.attempts(ctx).some(item => item.released && outcome(item)?.status === 'valid')) return this.finish(ctx, 'failed', 'released-analysis-present');
    if (artifacts.prepared!.calibration === 'experimental' && !this.config.allowExperimental) return this.defer(ctx, 'experimental-disabled');
    const budget = this.budget(); if (budget.reason && !retry) return this.defer(ctx, budget.reason);
    this.guard(ctx); const receipt = retry ?? this.db(() => this.deps.storage.reserveAnalysis(ctx.claim, { attemptId: randomUUID(), preparedRef: ctx.job.refs.prepared! }));
    let denial: string | null = null, started = false;
    const dependencies = {
      apiKey: this.deps.apiKey!, fetcher: this.deps.fetcher, signal: ctx.controller.signal,
      beforeSend: async (attempt: import('../match-analysis/index.js').RuntimeStarted) => {
        this.guard(ctx); const current = this.budget();
        if (current.reason || attempt.estimatedCostUsd > current.limit) { denial = current.reason ?? 'estimated-cost-exceeded'; throw new PipelineError('aborted'); }
        this.db(() => this.deps.storage.startAnalysis(ctx.claim, receipt.id, attempt)); started = true;
      },
    };
    const options = { attemptId: receipt.id, maxEstimatedCostUsd: budget.reason ? this.config.maxEstimatedCostPerAttemptUsd! : budget.limit, timeoutMs: this.config.analysisTimeoutMs };
    const result = artifacts.analysisProfile === 'gemini' ? await analyzeGeminiMatch(artifacts.prepared!, artifacts.bundle!, options, dependencies)
      : await analyzeMatch(artifacts.prepared!, artifacts.bundle!, options, dependencies);
    try { this.deps.storage.saveAnalysisOutcome(receipt.id, result); }
    catch (error) {
      if (started && !result.requestSent && error instanceof StorageError && error.code === 'conflict') {
        this.owned(ctx); return this.finish(ctx, 'needs-attention', 'analysis-not-sent-after-start');
      }
      throw this.failStorage();
    }
    if (this.fatal) throw this.fatal;
    this.owned(ctx);
    if (result.status === 'valid') {
      this.checkpoint(ctx, 'publish', receipt.id);
      if (ctx.controller.signal.aborted) return this.defer(ctx, 'aborted');
      return this.publish(ctx, artifacts, result);
    }
    if (artifacts.analysisProfile === 'gemini' && result.requestSent && result.billingState === 'unknown') {
      if (!retry && geminiRecoveryEligible(result)) return this.recoverGemini(ctx, artifacts, this.attempts(ctx).find(item => item.id === receipt.id)!);
      return this.finish(ctx, 'needs-attention', 'external-outcome-unknown');
    }
    if (result.requestSent || retry) return this.finish(ctx, 'failed', `analysis-${result.status}`);
    const retryAt = result.retryAt ? Date.parse(result.retryAt) : 0;
    return this.defer(ctx, denial ?? `analysis-${result.error?.code ?? 'preflight-failed'}`, this.config.pauseMs, Number.isFinite(retryAt) ? retryAt : 0);
  }
  private async recoverGemini(ctx: Execution, artifacts: Extract<JobArtifacts, { analysisProfile: 'gemini' }>, parent: Receipt): Promise<Job> {
    const child = this.attempts(ctx).some(item => outcome(item) && geminiRecoveryEligible(outcome(item)!)
      && this.db(() => this.deps.storage.getGeminiRecovery(item.id))?.retryAttemptId === parent.id);
    if (child) return this.finish(ctx, 'needs-attention', 'gemini-retry-consumed');
    if (this.config.mode !== 'live' || !this.deps.managementKey) return this.finish(ctx, 'needs-attention', 'gemini-recovery-unavailable');
    const attempt = outcome(parent)!;
    if (!geminiRecoveryEligible(attempt) || !artifacts.prepared) return this.finish(ctx, 'needs-attention', 'external-outcome-unknown');
    let saved = this.db(() => this.deps.storage.getGeminiRecovery(parent.id));
    if (!saved) {
      this.guard(ctx);
      const recovery = await checkGeminiRecovery(artifacts.prepared, attempt, { managementKey: this.deps.managementKey, fetcher: this.deps.fetcher,
        signal: ctx.controller.signal, wait: (ms, signal) => this.sleep(ms, signal), now: () => this.clock.now() });
      this.db(() => this.deps.storage.saveGeminiRecovery(parent.id, recovery));
      saved = this.db(() => this.deps.storage.getGeminiRecovery(parent.id));
    }
    this.guard(ctx);
    if (saved!.recovery.status === 'recorded') return this.finish(ctx, 'needs-attention', 'gemini-request-recorded');
    if (saved!.recovery.status !== 'retry-allowed') return this.finish(ctx, 'needs-attention', 'gemini-recovery-unavailable');
    if (saved!.retryAttemptId) return this.finish(ctx, 'needs-attention', 'gemini-retry-consumed');
    const budget = this.budget();
    if (budget.reason || attempt.estimatedCostUsd! > budget.limit) return this.finish(ctx, 'needs-attention', budget.reason ?? 'estimated-cost-exceeded');
    const receipt = this.db(() => this.deps.storage.reserveGeminiRetry(ctx.claim, { parentAttemptId: parent.id, attemptId: randomUUID() }));
    return this.analyze(ctx, artifacts, receipt);
  }
  private publicationOutcome(value: unknown, rejected: boolean): PublicationOutcome {
    if (!rejected && object(value) && snowflake(value.messageId)) return { messageId: value.messageId };
    if (rejected && value instanceof PublicationError && ['not-sent', 'unknown'].includes(value.outcome)
      && ['unavailable', 'forbidden', 'invalid-message', 'rate-limited', 'transport-error'].includes(value.code)) return { state: value.outcome, code: value.code };
    return { state: 'unknown', code: 'publication-unknown' };
  }
  private async publish(ctx: Execution, artifacts: JobArtifacts, analysis: RuntimeAttempt): Promise<Job> {
    const previous = this.attempts(ctx).find(item => item.kind === 'publication' && !item.released);
    if (previous) return this.finish(ctx, previous.unresolved ? 'needs-attention' : 'failed', 'publication-failed');
    if (this.config.publicationMode === 'on-command' && ctx.job.origin === 'automatic' && !this.db(() => this.deps.storage.getJob(ctx.job.id)).publicationRequested) {
      this.owned(ctx); return this.db(() => this.deps.storage.defer(ctx.claim, { nextRunAt: Number.MAX_SAFE_INTEGER, reason: 'publication-ready' }));
    }
    if (this.config.mode !== 'live' || !this.deps.publisher) return this.defer(ctx, 'publisher-unavailable');
    this.guard(ctx); let message: string;
    try {
      const common = { job: structuredClone(ctx.job), snapshot: artifacts.snapshot! };
      if (artifacts.analysisProfile === 'gemini' && isGeminiAttempt(analysis)) message = this.deps.publisher.prepare({ ...common, analysisProfile: 'gemini', analysis: structuredClone(analysis), bundle: artifacts.bundle! });
      else if (artifacts.analysisProfile === 'legacy' && !isGeminiAttempt(analysis)) message = this.deps.publisher.prepare({ ...common, analysis: structuredClone(analysis), bundle: artifacts.bundle! });
      else throw new PipelineError('invalid-input');
      ensure(typeof message === 'string' && object(JSON.parse(message)));
      ensure(Buffer.byteLength(JSON.stringify({ version: 1, guildId: ctx.job.settings.guildId, channelId: ctx.job.settings.channelId,
        analysisAttemptId: ctx.job.resultAttemptId, message }), 'utf8') <= 32 * 1024 * 1024);
    } catch { return this.defer(ctx, 'publication-invalid'); }
    this.guard(ctx); const receipt = this.db(() => this.deps.storage.beginPublication(ctx.claim, { attemptId: randomUUID(), analysisAttemptId: ctx.job.resultAttemptId!, message }));
    const sendController = new AbortController(), signal = AbortSignal.any([ctx.controller.signal, sendController.signal]);
    let expired = false, timer: unknown, cancel!: () => void;
    const deadline = new Promise<null>(resolve => {
      cancel = () => { expired = true; sendController.abort(); resolve(null); };
      timer = this.clock.setTimeout(cancel, this.config.publicationTimeoutMs); ctx.controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const send = Promise.resolve().then(() => {
      this.guard(ctx); return this.deps.publisher!.send(receipt.input as PublicationInput, { signal });
    }).then(value => this.publicationOutcome(value, false), error => this.publicationOutcome(error, true));
    const saved = send.then(value => {
      this.db(() => this.deps.storage.savePublicationOutcome(receipt.id, value)); return value;
    });
    void saved.catch(() => {});
    try {
      const result = await Promise.race([saved, deadline]);
      this.owned(ctx);
      if (this.fatal) throw this.fatal;
      if (result && !expired) return 'messageId' in result ? this.finish(ctx, 'succeeded')
        : this.finish(ctx, result.state === 'unknown' ? 'needs-attention' : 'failed', `publication-${result.code}`);
      const current = this.attempts(ctx).find(item => item.id === receipt.id)!;
      if (current.unresolved) return this.finish(ctx, 'needs-attention', 'publication-pending');
      return this.defer(ctx, 'publication-late-outcome');
    } finally { this.clock.clearTimeout(timer); ctx.controller.signal.removeEventListener('abort', cancel); }
  }
  getStatus(input: { jobId: string }): PipelineStatus {
    fields(input, ['jobId']); ensure(id(input.jobId)); let job: Job;
    try { job = this.deps.storage.getJob(input.jobId); }
    catch (error) { if (error instanceof StorageError && error.code === 'not-found') throw new PipelineError('not-found'); throw this.failStorage(); }
    const billing = this.db(() => this.deps.storage.getBillingSummary({ jobId: job.id })), billingUnknown = billing.unknownCount > 0;
    return { job, result: this.db(() => this.deps.storage.getLatestResult(job.matchId, job.side)), attention: job.state === 'needs-attention' || billingUnknown, billingUnknown,
      knownCostUsd: billing.knownCostUsd, reservedCostUsd: billing.reservedCostUsd, uncoveredUnknownCount: billing.uncoveredUnknownCount, publicationMode: this.config.publicationMode };
  }
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    const until = Math.min(Number.MAX_SAFE_INTEGER, this.clock.now() + ms);
    while (!signal.aborted && this.clock.now() < until) await new Promise<void>(resolve => {
      let timer: unknown;
      const done = () => { this.clock.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      timer = this.clock.setTimeout(done, Math.min(until - this.clock.now(), 2147483647)); signal.addEventListener('abort', done, { once: true });
    });
  }
  run(options: RequestOptions & { automatic?: boolean } = {}): Promise<{ status: 'stopped' | 'already-running' }> {
    return this.track(async () => {
      fields(options, [], ['automatic', 'signal']); ensure(options.signal === undefined || options.signal instanceof AbortSignal);
      this.check(options.signal); if (this.running) return { status: 'already-running' };
      ensure(options.automatic === undefined || typeof options.automatic === 'boolean');
      const automatic = options.automatic ?? true; if (automatic) { this.cutoff(); if (this.config.historySource === 'steam') ensure(this.deps.steam, 'invalid-config'); }
      this.running = true; const signal = this.signal(options.signal);
      const worker = async () => { while (!signal.aborted) { const result = await this.processNext({ signal }); if (result.status !== 'processed') await this.sleep(this.config.workerIdleMs, signal); } };
      const discovery = async () => { while (!signal.aborted) { await this.discoverOnce({ signal }); await this.sleep(this.config.pollIntervalMs, signal); } };
      try {
        this.db(() => this.deps.storage.recoverInterrupted());
        const results = await Promise.allSettled(automatic ? [worker(), discovery()] : [worker()]);
        if (this.fatal) throw this.fatal;
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected' && !signal.aborted) throw failure.reason;
        return { status: 'stopped' };
      } finally { this.running = false; }
    });
  }
  async stop(): Promise<void> { this.stopped = true; this.controller.abort(); await Promise.allSettled([...this.active]); }
}

export function createMatchPipeline(options: PipelineOptions, dependencies: PipelineDependencies): MatchPipeline { return new Pipeline(options, dependencies); }
