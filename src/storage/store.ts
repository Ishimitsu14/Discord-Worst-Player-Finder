import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { prepareAnalysis, validateAnalysisBundle, prepareGeminiAnalysis, isGeminiBundle, isGeminiPrepared, isGeminiAttempt, geminiRecoveryEligible,
  type GeminiRecovery, type RuntimeAttempt, type RuntimeBundle, type RuntimePrepared, type RuntimeStarted } from '../match-analysis/index.js';
import { validateCompactBundle } from '../match-facts/index.js';
import { openDatabase, transaction } from './database.js';
import { canonical, digest, encode, ensure, hash, id, integer, keys, object, pair, settings, shortText, translated } from './values.js';
import { validateAttempt, validateParse, validatePublication, validateStarted } from './validation.js';
import { eligibleRecovery, validateRecovery } from './recovery.js';
import type { ArtifactRefs, BillingSummary, Claim, ClaimedJob, EnqueueInput, Inputs, Job, JobArtifacts, MatchRecord, Receipt,
  RevisionInput, Side, Step, StorageOptions, StoredResult, AnalysisAttempt, StartedAttempt, PreparedAnalysis, FactsBundle, ParseInput, PublicationInput, ParseOutcome, PublicationOutcome, ResolutionInput,
  DiscoveryCandidate, DiscoveryObservation, DiscoveryDecision, LegacyJobArtifacts, GeminiJobArtifacts, StoredGeminiRecovery } from './types.js';
import { StorageError } from './types.js';

type Row = Record<string, SQLOutputValue>;
const steps: Step[] = ['load-match', 'wait-parse', 'build-facts', 'analyze', 'publish'];
const unfinished = "('queued','running','waiting','needs-attention')";

export class Storage {
  #db: DatabaseSync;
  #closed = false;
  #clock: { now(): number };
  constructor(options: StorageOptions) { this.#db = openDatabase(options); this.#clock = options.clock ?? { now: Date.now }; }
  private run<T>(operation: string, body: () => T): T {
    try { ensure(!this.#closed, 'closed'); return body(); } catch (error) { throw translated(error, operation); }
  }
  private now(): number { const value = this.#clock.now(); ensure(integer(value) && Number.isSafeInteger(value + 60000)); return value; }
  private get(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...args); }
  private all(sql: string, ...args: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...args); }
  private write(sql: string, ...args: SQLInputValue[]): void { this.#db.prepare(sql).run(...args); }
  private tx<T>(body: () => T): T { return transaction(this.#db, body); }
  close(): void {
    if (this.#closed) return;
    this.run('close', () => { this.#db.close(); this.#closed = true; });
  }
  private put(kind: string, body: string): string {
    const checksum = hash(body), ref = `${kind}:${checksum}`;
    const previous = this.get('SELECT body FROM artifacts WHERE ref=?', ref);
    if (previous) ensure(previous.body === body, 'integrity-error');
    else this.write('INSERT INTO artifacts(ref,kind,version,digest,body) VALUES(?,?,1,?,?)', ref, kind, checksum, body);
    return ref;
  }
  private artifact<T>(ref: string, kind: string): T {
    const row = this.get('SELECT * FROM artifacts WHERE ref=?', ref); ensure(row, 'integrity-error');
    ensure(row.version === 1 && row.kind === kind && typeof row.body === 'string' && hash(row.body) === row.digest && ref === `${kind}:${row.digest}`, 'integrity-error');
    try { const value = JSON.parse(row.body); ensure(object(value), 'integrity-error'); return value as T; } catch { throw new StorageError('integrity-error', 'artifact'); }
  }
  private job(row: Row | undefined): Job {
    ensure(row, 'not-found'); const config = this.verify(() => { const value = JSON.parse(row.settings as string); settings(value); return value; }); ensure(digest(config) === row.settings_digest, 'integrity-error');
    return { id: row.id as string, matchId: row.match_id as number, side: row.side as Side, revision: row.revision as number, origin: row.origin as Job['origin'],
      analysisProfile: row.analysis_profile as Job['analysisProfile'], settings: config, state: row.state as Job['state'], step: row.step as Step, version: row.version as number, createdAt: row.created_at as number,
      updatedAt: row.updated_at as number, nextRunAt: row.next_run_at as number, leaseToken: row.lease_token as string | null,
      leaseUntil: row.lease_until as number | null, reason: row.reason as string | null, resultAttemptId: row.result_attempt_id as string | null,
      refs: { snapshot: row.snapshot_ref as string | null, bundle: row.bundle_ref as string | null, prepared: row.prepared_ref as string | null } };
  }
  private findJob(jobId: string): Job { ensure(id(jobId)); return this.job(this.get('SELECT * FROM jobs WHERE id=?', jobId)); }
  private claim(job: Job): Claim { ensure(job.leaseToken, 'lease-lost'); return { jobId: job.id, token: job.leaseToken, version: job.version }; }
  private owned(claim: Claim): Job {
    keys(claim, ['jobId', 'token', 'version']); ensure(id(claim.jobId) && id(claim.token) && integer(claim.version) && claim.version > 0);
    const job = this.findJob(claim.jobId);
    ensure(job.state === 'running' && job.leaseToken === claim.token && job.version === claim.version && job.leaseUntil! > this.now(), 'lease-lost'); return job;
  }
  private update(job: Job, changes: Partial<Job>): Job {
    const current = { ...job, ...changes, version: job.version + 1, updatedAt: this.now() }; ensure(integer(current.version));
    this.write(`UPDATE jobs SET state=?,step=?,version=?,updated_at=?,next_run_at=?,lease_token=?,lease_until=?,reason=?,
      snapshot_ref=?,bundle_ref=?,prepared_ref=?,result_attempt_id=? WHERE id=? AND version=?`,
    current.state, current.step, current.version, current.updatedAt, current.nextRunAt, current.leaseToken, current.leaseUntil, current.reason,
    current.refs.snapshot, current.refs.bundle, current.refs.prepared, current.resultAttemptId, job.id, job.version);
    ensure(this.get('SELECT changes() AS count')!.count === 1, 'conflict'); return current;
  }
  private record(matchId: number, observedAt: number): MatchRecord {
    this.write(`INSERT INTO matches VALUES(?,?,?) ON CONFLICT(match_id) DO UPDATE SET
      first_seen_at=min(first_seen_at,excluded.first_seen_at),last_seen_at=max(last_seen_at,excluded.last_seen_at)`, matchId, observedAt, observedAt);
    const row = this.get('SELECT * FROM matches WHERE match_id=?', matchId)!;
    return { matchId, firstSeenAt: row.first_seen_at as number, lastSeenAt: row.last_seen_at as number };
  }
  recordMatch(input: { matchId: number; observedAt: number }): MatchRecord {
    return this.run('recordMatch', () => { keys(input, ['matchId', 'observedAt']); ensure(integer(input.matchId) && input.matchId > 0 && integer(input.observedAt)); return this.tx(() => this.record(input.matchId, input.observedAt)); });
  }
  private discoveryKey(contextKey: string, matchId?: number): void {
    ensure(typeof contextKey === 'string' && /^[a-f0-9]{64}$/.test(contextKey));
    if (matchId !== undefined) ensure(integer(matchId) && matchId > 0);
  }
  private candidate(row: Row): DiscoveryCandidate {
    return { contextKey: row.context_key as string, matchId: row.match_id as number, firstSeenAt: row.first_seen_at as number, lastSeenAt: row.last_seen_at as number,
      expiresAt: row.expires_at as number, state: row.state as DiscoveryCandidate['state'], nextCheckAt: row.next_check_at as number | null, reason: row.reason as string | null };
  }
  getDiscoveryCandidate(contextKey: string, matchId: number): DiscoveryCandidate | null {
    return this.run('getDiscoveryCandidate', () => { this.discoveryKey(contextKey, matchId); const row = this.get('SELECT * FROM discovery_candidates WHERE context_key=? AND match_id=?', contextKey, matchId); return row ? this.candidate(row) : null; });
  }
  observeDiscoveryCandidate(input: DiscoveryObservation): DiscoveryCandidate {
    return this.run('observeDiscoveryCandidate', () => {
      keys(input, ['contextKey', 'matchId', 'observedAt', 'expiresAt']); this.discoveryKey(input.contextKey, input.matchId);
      ensure(integer(input.observedAt) && integer(input.expiresAt) && input.expiresAt > input.observedAt);
      return this.tx(() => {
        this.record(input.matchId, input.observedAt);
        this.write(`INSERT INTO discovery_candidates VALUES(?,?,?,?,?,'pending',?,NULL)
          ON CONFLICT(context_key,match_id) DO UPDATE SET last_seen_at=max(last_seen_at,excluded.last_seen_at)`,
        input.contextKey, input.matchId, input.observedAt, input.observedAt, input.expiresAt, input.observedAt);
        return this.candidate(this.get('SELECT * FROM discovery_candidates WHERE context_key=? AND match_id=?', input.contextKey, input.matchId)!);
      });
    });
  }
  listDueDiscoveryCandidates(contextKey: string, limit: number): DiscoveryCandidate[] {
    return this.run('listDueDiscoveryCandidates', () => {
      this.discoveryKey(contextKey); ensure(integer(limit) && limit >= 1 && limit <= 1000); const now = this.now();
      return this.all(`SELECT * FROM discovery_candidates WHERE context_key=? AND state='pending' AND (next_check_at<=? OR expires_at<=?)
        ORDER BY min(next_check_at,expires_at),first_seen_at,match_id LIMIT ?`, contextKey, now, now, limit).map(row => this.candidate(row));
    });
  }
  getDiscoveryCounts(contextKey: string): { pending: number; due: number } {
    return this.run('getDiscoveryCounts', () => {
      this.discoveryKey(contextKey); const now = this.now();
      const row = this.get(`SELECT count(*) AS pending,coalesce(sum(CASE WHEN next_check_at<=? OR expires_at<=? THEN 1 ELSE 0 END),0) AS due
        FROM discovery_candidates WHERE context_key=? AND state='pending'`, now, now, contextKey)!;
      return { pending: row.pending as number, due: row.due as number };
    });
  }
  decideDiscoveryCandidate(input: DiscoveryDecision): DiscoveryCandidate {
    return this.run('decideDiscoveryCandidate', () => {
      keys(input, ['contextKey', 'matchId', 'state', 'nextCheckAt', 'reason']); this.discoveryKey(input.contextKey, input.matchId);
      ensure(['pending', 'admitted', 'ignored', 'needs-attention'].includes(input.state));
      ensure(input.state === 'pending' ? integer(input.nextCheckAt) : input.nextCheckAt === null);
      ensure(input.reason === null || typeof input.reason === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(input.reason));
      return this.tx(() => {
        const current = this.getDiscoveryCandidate(input.contextKey, input.matchId); ensure(current, 'not-found');
        ensure(current.state === 'pending' || current.state === input.state && current.reason === input.reason && current.nextCheckAt === input.nextCheckAt, 'conflict');
        this.write('UPDATE discovery_candidates SET state=?,next_check_at=?,reason=? WHERE context_key=? AND match_id=?', input.state, input.nextCheckAt, input.reason, input.contextKey, input.matchId);
        return this.getDiscoveryCandidate(input.contextKey, input.matchId)!;
      });
    });
  }
  private insertJob(input: EnqueueInput, revision: number, body: string): Job {
    ensure(integer(revision) && revision > 0);
    const now = this.now(), jobId = randomUUID(); this.record(input.matchId, now);
    this.write(`INSERT INTO jobs(id,match_id,side,revision,origin,settings,settings_digest,state,step,version,created_at,updated_at,next_run_at)
      VALUES(?,?,?,?,?,?,?,'queued','load-match',1,?,?,?)`, jobId, input.matchId, input.side, revision, input.origin, body, digest(input.settings), now, now, now);
    this.write('UPDATE jobs SET analysis_profile=? WHERE id=?', input.analysisProfile ?? 'legacy', jobId);
    return this.findJob(jobId);
  }
  enqueueInitial(input: EnqueueInput): Job {
    return this.run('enqueueInitial', () => {
      keys(input, ['matchId', 'side', 'origin', 'settings'], ['analysisProfile']); pair(input.matchId, input.side); settings(input.settings); ensure(['manual', 'automatic'].includes(input.origin)); ensure(input.analysisProfile === undefined || ['legacy', 'gemini'].includes(input.analysisProfile)); const body = encode(input.settings);
      return this.tx(() => { const previous = this.get('SELECT * FROM jobs WHERE match_id=? AND side=? AND revision=1', input.matchId, input.side); return previous ? this.job(previous) : this.insertJob(input, 1, body); });
    });
  }
  createRevision(input: RevisionInput): Job {
    return this.run('createRevision', () => {
      keys(input, ['requestId', 'matchId', 'side', 'settings'], ['analysisProfile']); ensure(id(input.requestId)); pair(input.matchId, input.side); settings(input.settings);
      ensure(input.analysisProfile === undefined || ['legacy', 'gemini'].includes(input.analysisProfile));
      const { analysisProfile, ...oldInput } = input, checksum = digest(analysisProfile === 'gemini' ? input : oldInput), body = encode(input.settings);
      return this.tx(() => {
        const previous = this.get('SELECT * FROM revision_requests WHERE id=?', input.requestId);
        if (previous) { ensure(previous.digest === checksum, 'conflict'); return this.findJob(previous.job_id as string); }
        const latest = this.get('SELECT * FROM jobs WHERE match_id=? AND side=? ORDER BY revision DESC LIMIT 1', input.matchId, input.side); ensure(latest, 'not-found');
        ensure(!this.get(`SELECT id FROM jobs WHERE match_id=? AND side=? AND state IN ${unfinished}`, input.matchId, input.side), 'conflict');
        const job = this.insertJob({ ...input, origin: 'manual' }, (latest.revision as number) + 1, body);
        this.write('INSERT INTO revision_requests VALUES(?,?,?)', input.requestId, checksum, job.id); return job;
      });
    });
  }
  getJob(jobId: string): Job { return this.run('getJob', () => this.findJob(jobId)); }
  getLatestJob(matchId: number, side: Side): Job | null {
    return this.run('getLatestJob', () => { pair(matchId, side); const row = this.get('SELECT * FROM jobs WHERE match_id=? AND side=? ORDER BY revision DESC LIMIT 1', matchId, side); return row ? this.job(row) : null; });
  }
  claimNext(): ClaimedJob | null {
    return this.run('claimNext', () => this.tx(() => {
      const now = this.now(), row = this.get("SELECT * FROM jobs WHERE state IN ('queued','waiting') AND next_run_at<=? ORDER BY next_run_at,created_at,id LIMIT 1", now);
      if (!row) return null;
      const job = this.update(this.job(row), { state: 'running', leaseToken: randomUUID(), leaseUntil: now + 60000 }); return { job, claim: this.claim(job) };
    }));
  }
  renewClaim(claim: Claim): Claim { return this.run('renewClaim', () => this.tx(() => this.claim(this.update(this.owned(claim), { leaseUntil: this.now() + 60000 })))); }
  checkpoint(claim: Claim, input: { step: Step; artifactRefs?: Partial<ArtifactRefs>; resultAttemptId?: string }): ClaimedJob {
    return this.run('checkpoint', () => {
      keys(input, ['step'], ['artifactRefs', 'resultAttemptId']); ensure(steps.includes(input.step));
      return this.tx(() => {
        const job = this.owned(claim);
        if (input.artifactRefs) { keys(input.artifactRefs, [], ['snapshot', 'bundle', 'prepared']); ensure(Object.entries(input.artifactRefs).every(([kind, ref]) => job.refs[kind as keyof ArtifactRefs] === ref), 'conflict'); }
        if (input.resultAttemptId !== undefined) {
          ensure(id(input.resultAttemptId)); const receipt = this.receipt(input.resultAttemptId);
          ensure(receipt.jobId === job.id && receipt.kind === 'analysis' && !receipt.released && receipt.state === 'finished' && (receipt.outcome as { status?: string })?.status === 'valid', 'conflict');
          ensure(!job.resultAttemptId || job.resultAttemptId === receipt.id, 'conflict');
        }
        const current = this.update(job, { step: input.step, resultAttemptId: input.resultAttemptId ?? job.resultAttemptId }); return { job: current, claim: this.claim(current) };
      });
    });
  }
  defer(claim: Claim, input: { nextRunAt: number; reason: string }): Job {
    return this.run('defer', () => { keys(input, ['nextRunAt', 'reason']); ensure(integer(input.nextRunAt) && shortText(input.reason)); return this.tx(() => {
      const job = this.owned(claim); ensure(!this.hasUnresolved(job.id) && !this.get("SELECT id FROM external_attempts WHERE job_id=? AND state='prepared'", job.id), 'conflict'); return this.update(job, { state: 'waiting', nextRunAt: input.nextRunAt, reason: input.reason, leaseToken: null, leaseUntil: null });
    }); });
  }
  finish(claim: Claim, input: { state: 'succeeded' | 'failed' | 'needs-attention'; reason?: string }): Job {
    return this.run('finish', () => { keys(input, ['state'], ['reason']); ensure(['succeeded', 'failed', 'needs-attention'].includes(input.state) && (input.reason === undefined || shortText(input.reason)));
      return this.tx(() => {
        const job = this.owned(claim), unresolved = this.hasUnresolved(job.id);
        ensure(!this.get("SELECT id FROM external_attempts WHERE job_id=? AND state='prepared'", job.id), 'conflict');
        const recovery = job.analysisProfile === 'gemini' && this.get('SELECT r.parent_attempt_id FROM gemini_recoveries r JOIN external_attempts a ON a.id=r.parent_attempt_id WHERE a.job_id=?', job.id);
        ensure(input.state === 'needs-attention' ? unresolved || recovery : !unresolved, 'conflict');
        ensure(input.state !== 'succeeded' || job.resultAttemptId, 'conflict'); ensure(input.state === 'succeeded' || shortText(input.reason));
        return this.update(job, { state: input.state, reason: input.reason ?? null, leaseToken: null, leaseUntil: null });
      });
    });
  }
  private inputs(job: Job): JobArtifacts {
    const { refs } = job;
    const snapshot = refs.snapshot ? this.artifact<JobArtifacts['snapshot']>(refs.snapshot, 'snapshot') : null;
    const bundle = refs.bundle ? this.artifact<RuntimeBundle>(refs.bundle, 'bundle') : null;
    const prepared = refs.prepared ? this.artifact<RuntimePrepared>(refs.prepared, 'prepared') : null;
    ensure(!snapshot || snapshot.data.match_id === job.matchId, 'integrity-error');
    if (bundle) ensure(snapshot && bundle.manifest.matchId === job.matchId && bundle.manifest.side === job.side && (isGeminiBundle(bundle) ? bundle.manifest.sourceDataDigest : bundle.manifest.dataDigest) === digest(snapshot.data), 'integrity-error');
    if (prepared) ensure(bundle && prepared.matchId === job.matchId && prepared.side === job.side && prepared.bundleId === bundle.manifest.bundleId && prepared.contextDigest === bundle.manifest.contextDigest && prepared.requestDigest === hash(prepared.body), 'integrity-error');
    if (job.analysisProfile === 'gemini') {
      ensure((bundle === null || isGeminiBundle(bundle)) && (prepared === null || isGeminiPrepared(prepared)), 'integrity-error');
      return { analysisProfile: 'gemini', snapshot, bundle, prepared };
    }
    ensure((bundle === null || !isGeminiBundle(bundle)) && (prepared === null || !isGeminiPrepared(prepared)), 'integrity-error');
    return { analysisProfile: 'legacy', snapshot, bundle, prepared };
  }
  getJobArtifacts(jobId: string, profile: 'legacy'): LegacyJobArtifacts;
  getJobArtifacts(jobId: string, profile: 'gemini'): GeminiJobArtifacts;
  getJobArtifacts(jobId: string): JobArtifacts;
  getJobArtifacts(jobId: string, profile?: Job['analysisProfile']): JobArtifacts { return this.run('getJobArtifacts', () => {
    const result = this.inputs(this.findJob(jobId)); ensure(profile === undefined || profile === result.analysisProfile, 'integrity-error'); return result;
  }); }
  saveInputs(claim: Claim, input: Inputs): { refs: ArtifactRefs; claim: Claim } {
    return this.run('saveInputs', () => {
      keys(input, [], ['snapshot', 'bundle', 'prepared']); ensure(Object.keys(input).length > 0);
      ensure(Object.values(input).every(object));
      const bodies = Object.fromEntries(Object.entries(input).map(([kind, value]) => [kind, encode(value)]));
      const initial = this.owned(claim), existing = this.inputs(initial), merged = { ...existing, ...input };
      if (merged.snapshot) {
        const snapshot = merged.snapshot; keys(snapshot, ['data', 'parseState', 'retrievedAt']);
        ensure(object(snapshot.data) && snapshot.data.match_id === initial.matchId && integer(snapshot.retrievedAt) && Array.isArray(snapshot.data.players));
        ensure(integer(snapshot.data.start_time) && integer(snapshot.data.duration) && typeof snapshot.data.game_mode === 'number' && Number.isSafeInteger(snapshot.data.game_mode)
          && typeof snapshot.data.lobby_type === 'number' && Number.isSafeInteger(snapshot.data.lobby_type) && (snapshot.data.radiant_win === null || typeof snapshot.data.radiant_win === 'boolean'));
        ensure(snapshot.data.version === undefined || snapshot.data.version === null || integer(snapshot.data.version));
        ensure(snapshot.data.players.every(player => object(player) && integer(player.player_slot) && player.player_slot <= 255 && integer(player.hero_id) && player.hero_id > 0)
          && new Set(snapshot.data.players.map(player => player.player_slot)).size === snapshot.data.players.length);
        ensure(snapshot.parseState === (typeof snapshot.data.version === 'number' && snapshot.data.version > 0 ? 'parsed' : 'basic'));
      }
      if (merged.bundle) {
        const bundle = merged.bundle; ensure(merged.snapshot, 'invalid-input'); ensure(isGeminiBundle(bundle) === (initial.analysisProfile === 'gemini'), 'integrity-error');
        this.verify(() => isGeminiBundle(bundle) ? validateCompactBundle(bundle) : validateAnalysisBundle(bundle));
        ensure(bundle.manifest.matchId === initial.matchId && bundle.manifest.side === initial.side && (isGeminiBundle(bundle) ? bundle.manifest.sourceDataDigest : bundle.manifest.dataDigest) === digest(merged.snapshot.data), 'integrity-error');
      }
      if (merged.prepared) {
        const prepared = merged.prepared, bundle = merged.bundle; ensure(bundle, 'invalid-input');
        const expected = this.verify(() => { if (isGeminiPrepared(prepared)) { ensure(isGeminiBundle(bundle), 'integrity-error'); return prepareGeminiAnalysis(bundle, prepared.prompt); }
          ensure(!isGeminiBundle(bundle), 'integrity-error'); return prepareAnalysis(bundle, prepared.prompt); });
        ensure(canonical(expected) === canonical(prepared), 'integrity-error');
      }
      return this.tx(() => {
        const job = this.owned(claim), refs = { ...job.refs };
        for (const [kind, body] of Object.entries(bodies)) {
          const ref = `${kind}:${hash(body)}`, current = refs[kind as keyof ArtifactRefs];
          ensure(!job.refs.prepared || current === ref, 'conflict'); refs[kind as keyof ArtifactRefs] = this.put(kind, body);
        }
        const current = this.update(job, { refs }); return { refs, claim: this.claim(current) };
      });
    });
  }
  private hasUnresolved(jobId: string, except?: string): boolean {
    return !!this.get('SELECT id FROM external_attempts WHERE job_id=? AND unresolved=1 AND released=0 AND id!=? LIMIT 1', jobId, except ?? '');
  }
  private verify<T>(body: () => T): T { try { return body(); } catch { throw new StorageError('integrity-error', 'validate'); } }
  private available(jobId: string, kind: Receipt['kind']): void {
    ensure(!this.get("SELECT id FROM external_attempts WHERE job_id=? AND kind=? AND released=0 AND (state='prepared' OR unresolved=1)", jobId, kind), 'conflict');
    for (const row of this.all('SELECT id FROM external_attempts WHERE job_id=? AND kind=? AND outcome_ref IS NOT NULL', jobId, kind)) {
      const outcome = this.receipt(row.id as string).outcome!;
      ensure(!(kind === 'parse' && 'jobId' in outcome || kind === 'publication' && 'messageId' in outcome || kind === 'analysis' && 'status' in outcome && outcome.status === 'valid'), 'conflict');
    }
  }
  private insertAttempt(job: Job, attemptId: string, kind: Receipt['kind'], inputRef: string, state: Receipt['state']): Receipt {
    ensure(id(attemptId));
    ensure(!this.get('SELECT id FROM external_attempts WHERE id=?', attemptId), 'attempt-already-started'); this.available(job.id, kind);
    ensure(!this.hasUnresolved(job.id), 'conflict');
    const now = this.now();
    this.write('INSERT INTO external_attempts(id,job_id,kind,state,input_ref,unresolved,released,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)',
      attemptId, job.id, kind, state, inputRef, state === 'started' ? 1 : 0, now, now); return this.receipt(attemptId);
  }
  reserveAnalysis(claim: Claim, input: { attemptId: string; preparedRef: string }): Receipt {
    return this.run('reserveAnalysis', () => { keys(input, ['attemptId', 'preparedRef']); ensure(id(input.attemptId) && typeof input.preparedRef === 'string');
      return this.tx(() => {
        const job = this.owned(claim); ensure(job.refs.prepared && input.preparedRef === job.refs.prepared, 'conflict');
        if (job.analysisProfile === 'gemini') ensure(!this.listAttempts(job.id).some(receipt => receipt.kind === 'analysis' && (receipt.started || receipt.outcome && 'requestSent' in receipt.outcome && receipt.outcome.requestSent)), 'conflict');
        return this.insertAttempt(job, input.attemptId, 'analysis', input.preparedRef, 'prepared');
      });
    });
  }
  startAnalysis(claim: Claim, reservationId: string, started: RuntimeStarted): void {
    return this.run('startAnalysis', () => {
      const body = encode(started), receipt = this.receipt(reservationId); ensure(receipt.kind === 'analysis');
      validateStarted(started, this.artifact<RuntimePrepared>(receipt.inputRef, 'prepared'), receipt.id);
      this.tx(() => {
        const job = this.owned(claim), current = this.receipt(reservationId); ensure(current.jobId === job.id, 'conflict'); ensure(current.state === 'prepared', 'attempt-already-started');
        ensure(!this.hasUnresolved(job.id, reservationId), 'conflict');
        this.write("UPDATE external_attempts SET state='started',unresolved=1,started_ref=?,updated_at=? WHERE id=?", this.put('analysis-started', body), this.now(), reservationId);
      });
    });
  }
  private outcome(attemptId: string, kind: Receipt['kind'], value: NonNullable<Receipt['outcome']>, body: string, unresolved: boolean): Receipt {
    const receipt = this.receipt(attemptId); ensure(receipt.kind === kind);
    if (receipt.outcome !== null) { ensure(canonical(receipt.outcome) === canonical(value), 'conflict'); return receipt; }
    this.write("UPDATE external_attempts SET state='finished',outcome_ref=?,unresolved=?,updated_at=? WHERE id=?", this.put(`${kind}-outcome`, body), unresolved ? 1 : 0, this.now(), attemptId);
    return this.receipt(attemptId);
  }
  private checkAnalysis(receipt: Receipt, attempt: RuntimeAttempt): void {
    ensure(receipt.kind === 'analysis'); const prepared = this.artifact<RuntimePrepared>(receipt.inputRef, 'prepared');
    const bundle = this.inputs(this.findJob(receipt.jobId)).bundle; ensure(bundle, 'integrity-error');
    validateAttempt(attempt, prepared, bundle, receipt.id, receipt.started);
  }
  saveAnalysisOutcome(reservationId: string, attempt: RuntimeAttempt): Receipt {
    return this.run('saveAnalysisOutcome', () => {
      const body = encode(attempt), receipt = this.receipt(reservationId); this.checkAnalysis(receipt, attempt);
      return this.tx(() => {
        const current = this.receipt(reservationId);
        if (current.outcome === null) {
          ensure(!current.started || attempt.requestSent, 'conflict');
          ensure(current.state !== 'finished', 'conflict');
        }
        return this.outcome(reservationId, 'analysis', attempt, body, isGeminiAttempt(attempt) && attempt.requestSent && attempt.status !== 'valid' && attempt.billingState === 'unknown');
      });
    });
  }
  beginParse(claim: Claim, input: { attemptId: string }): Receipt {
    return this.run('beginParse', () => { keys(input, ['attemptId']); ensure(id(input.attemptId)); return this.tx(() => {
      const job = this.owned(claim), inputRef = this.put('parse-input', encode({ version: 1, matchId: job.matchId })); return this.insertAttempt(job, input.attemptId, 'parse', inputRef, 'started');
    }); });
  }
  saveParseOutcome(attemptId: string, outcome: ParseOutcome): Receipt {
    return this.run('saveParseOutcome', () => { validateParse(outcome); const body = encode(outcome); return this.tx(() => {
      const receipt = this.receipt(attemptId); ensure(receipt.state !== 'prepared'); return this.outcome(attemptId, 'parse', outcome, body, 'error' in outcome && outcome.error.requestMayHaveSucceeded);
    }); });
  }
  beginPublication(claim: Claim, input: { attemptId: string; analysisAttemptId: string; message: string }): Receipt {
    return this.run('beginPublication', () => {
      keys(input, ['attemptId', 'analysisAttemptId', 'message']); ensure(id(input.attemptId) && id(input.analysisAttemptId) && typeof input.message === 'string');
      let message: unknown; try { message = JSON.parse(input.message); } catch { ensure(false); } ensure(object(message));
      const job = this.owned(claim); ensure(job.resultAttemptId === input.analysisAttemptId, 'conflict');
      const body = encode({ version: 1, guildId: job.settings.guildId, channelId: job.settings.channelId, analysisAttemptId: input.analysisAttemptId, message: input.message });
      return this.tx(() => {
        const current = this.owned(claim), result = this.receipt(input.analysisAttemptId); ensure(result.jobId === current.id && result.kind === 'analysis' && (result.outcome as AnalysisAttempt)?.status === 'valid', 'conflict');
        return this.insertAttempt(current, input.attemptId, 'publication', this.put('publication-input', body), 'started');
      });
    });
  }
  savePublicationOutcome(attemptId: string, outcome: PublicationOutcome): Receipt {
    return this.run('savePublicationOutcome', () => { validatePublication(outcome); const body = encode(outcome); return this.tx(() => this.outcome(attemptId, 'publication', outcome, body, 'state' in outcome && outcome.state === 'unknown')); });
  }
  getGeminiRecovery(parentAttemptId: string): StoredGeminiRecovery | null {
    return this.run('getGeminiRecovery', () => {
      ensure(id(parentAttemptId)); const row = this.get('SELECT * FROM gemini_recoveries WHERE parent_attempt_id=?', parentAttemptId);
      if (!row) return null;
      const parent = this.receipt(parentAttemptId), attempt = parent.outcome; ensure(attempt && 'requestSent' in attempt && eligibleRecovery(attempt), 'integrity-error');
      const recovery = this.artifact<GeminiRecovery>(row.recovery_ref as string, 'gemini-recovery');
      validateRecovery(recovery, attempt, parentAttemptId, attempt.identity!.requestDigest);
      return { parentAttemptId, recovery, retryAttemptId: row.retry_attempt_id as string | null, createdAt: row.created_at as number };
    });
  }
  saveGeminiRecovery(parentAttemptId: string, recovery: GeminiRecovery): StoredGeminiRecovery {
    return this.run('saveGeminiRecovery', () => this.tx(() => {
      const parent = this.receipt(parentAttemptId), attempt = parent.outcome, job = this.findJob(parent.jobId);
      ensure(job.analysisProfile === 'gemini' && parent.kind === 'analysis' && attempt && 'requestSent' in attempt && eligibleRecovery(attempt), 'conflict');
      ensure(!this.get('SELECT parent_attempt_id FROM gemini_recoveries WHERE retry_attempt_id=?', parentAttemptId), 'conflict');
      validateRecovery(recovery, attempt, parentAttemptId, attempt.identity!.requestDigest);
      const previous = this.getGeminiRecovery(parentAttemptId);
      if (previous) { ensure(canonical(previous.recovery) === canonical(recovery), 'conflict'); return previous; }
      this.write('INSERT INTO gemini_recoveries VALUES(?,?,NULL,?)', parentAttemptId, this.put('gemini-recovery', encode(recovery)), this.now());
      if (recovery.status === 'recorded' && recovery.costUsd !== null) this.write('UPDATE external_attempts SET unresolved=0,updated_at=? WHERE id=?', this.now(), parentAttemptId);
      return this.getGeminiRecovery(parentAttemptId)!;
    }));
  }
  reserveGeminiRetry(claim: Claim, input: { parentAttemptId: string; attemptId: string }): Receipt {
    return this.run('reserveGeminiRetry', () => {
      keys(input, ['parentAttemptId', 'attemptId']); ensure(id(input.parentAttemptId) && id(input.attemptId) && input.parentAttemptId !== input.attemptId);
      return this.tx(() => {
        const job = this.owned(claim), parent = this.receipt(input.parentAttemptId), decision = this.getGeminiRecovery(parent.id);
        ensure(job.analysisProfile === 'gemini' && parent.jobId === job.id && parent.kind === 'analysis' && decision?.recovery.status === 'retry-allowed' && decision.retryAttemptId === null, 'conflict');
        ensure(!this.get('SELECT parent_attempt_id FROM gemini_recoveries WHERE retry_attempt_id=?', parent.id), 'conflict');
        ensure(job.refs.prepared === parent.inputRef, 'integrity-error');
        this.write('UPDATE external_attempts SET released=1,unresolved=0,updated_at=? WHERE id=?', this.now(), parent.id);
        const child = this.insertAttempt(job, input.attemptId, 'analysis', parent.inputRef, 'prepared');
        this.write('UPDATE gemini_recoveries SET retry_attempt_id=? WHERE parent_attempt_id=?', child.id, parent.id); return child;
      });
    });
  }
  recoverInterrupted(): { resumed: number; attention: number } {
    return this.run('recoverInterrupted', () => this.tx(() => {
      const now = this.now(); let resumed = 0, attention = 0;
      for (const row of this.all("SELECT * FROM jobs WHERE state='running' AND lease_until<=?", now)) {
        const job = this.job(row);
        this.write("UPDATE external_attempts SET state='finished',updated_at=? WHERE job_id=? AND state='prepared'", now, job.id);
        this.write("UPDATE external_attempts SET state='interrupted',updated_at=? WHERE job_id=? AND state='started' AND outcome_ref IS NULL", now, job.id);
        const unresolved = this.hasUnresolved(job.id);
        const canCheck = job.analysisProfile === 'gemini' && this.listAttempts(job.id).filter(item => item.unresolved && !item.released).every(item => {
          const value = item.outcome; if (item.kind !== 'analysis' || !value || !('requestSent' in value) || !eligibleRecovery(value)) return false;
          if (this.get('SELECT parent_attempt_id FROM gemini_recoveries WHERE retry_attempt_id=?', item.id)) return false;
          const saved = this.getGeminiRecovery(item.id); return saved === null || saved.recovery.status === 'retry-allowed' && saved.retryAttemptId === null;
        });
        const consumed = this.get('SELECT a.id FROM gemini_recoveries r JOIN external_attempts a ON a.id=r.retry_attempt_id WHERE a.job_id=? AND a.outcome_ref IS NULL', job.id);
        const needsAttention = Boolean(consumed) || unresolved && !canCheck;
        this.update(job, { state: needsAttention ? 'needs-attention' : 'waiting', leaseToken: null, leaseUntil: null, nextRunAt: now });
        if (needsAttention) attention++; else resumed++;
      }
      return { resumed, attention };
    }));
  }
  resolveUncertain(input: ResolutionInput): Job {
    return this.run('resolveUncertain', () => {
      keys(input, ['resolutionId', 'jobId', 'expectedVersion', 'attemptId', 'decision', 'state', 'reason', 'evidenceRef'], ['notSentOutcome']);
      ensure(id(input.resolutionId) && id(input.jobId) && id(input.attemptId) && integer(input.expectedVersion) && input.expectedVersion > 0 && shortText(input.reason) && shortText(input.evidenceRef));
      ensure(['allow-new-attempt', 'accept-outcome'].includes(input.decision) && ['waiting', 'failed'].includes(input.state)); const body = encode(input), checksum = digest(input);
      return this.tx(() => {
        const previous = this.get('SELECT * FROM resolutions WHERE id=?', input.resolutionId);
        if (previous) { ensure(previous.digest === checksum, 'conflict'); return this.findJob(input.jobId); }
        const job = this.findJob(input.jobId), receipt = this.receipt(input.attemptId);
        ensure(job.state === 'needs-attention' && job.version === input.expectedVersion && receipt.jobId === job.id, 'conflict');
        ensure(receipt.unresolved || receipt.outcome !== null, 'conflict');
        if (input.notSentOutcome !== undefined) {
          ensure(input.decision === 'accept-outcome' && receipt.kind === 'analysis' && receipt.started && !input.notSentOutcome.requestSent && receipt.outcome === null, 'conflict');
          this.checkAnalysis(receipt, input.notSentOutcome); this.outcome(receipt.id, 'analysis', input.notSentOutcome, encode(input.notSentOutcome), false);
        } else if (input.decision === 'accept-outcome') ensure(receipt.outcome !== null && !receipt.unresolved, 'conflict');
        if (input.decision === 'allow-new-attempt') {
          ensure(receipt.unresolved, 'conflict'); this.write('UPDATE external_attempts SET released=1,unresolved=0,updated_at=? WHERE id=?', this.now(), receipt.id);
        }
        ensure(!this.hasUnresolved(job.id, receipt.id), 'conflict');
        this.write('INSERT INTO resolutions VALUES(?,?,?,?,?)', input.resolutionId, receipt.id, body, checksum, this.now());
        return this.update(job, { state: input.state, reason: input.reason, nextRunAt: this.now() });
      });
    });
  }
  getBillingSummary(input: { jobId?: string } = {}): BillingSummary {
    return this.run('getBillingSummary', () => {
      keys(input, [], ['jobId']); if (input.jobId !== undefined) this.findJob(input.jobId);
      const rows = input.jobId ? this.all("SELECT id FROM external_attempts WHERE kind='analysis' AND job_id=?", input.jobId) : this.all("SELECT id FROM external_attempts WHERE kind='analysis'");
      const summary: BillingSummary = { knownCostUsd: 0, unknownCount: 0, unfinishedEstimatedCostUsd: 0, reservedCostUsd: 0, uncoveredUnknownCount: 0 };
      for (const row of rows) {
        const receipt = this.receipt(row.id as string), outcome = receipt.outcome as RuntimeAttempt | null;
        const recovery = outcome && isGeminiAttempt(outcome) && eligibleRecovery(outcome) ? this.getGeminiRecovery(receipt.id)?.recovery : undefined;
        if (outcome?.billingState === 'known') summary.knownCostUsd += outcome.usage.costUsd!;
        else if (recovery?.costUsd !== null && recovery?.costUsd !== undefined) summary.knownCostUsd += recovery.costUsd;
        else if (outcome?.billingState === 'unknown' || !outcome && receipt.started) {
          summary.unknownCount++;
          if (recovery?.reserveUsd) summary.reservedCostUsd += recovery.reserveUsd;
          if (recovery?.status !== 'retry-allowed' || !recovery.reserveUsd) summary.uncoveredUnknownCount++;
        }
        if (!outcome && receipt.started) summary.unfinishedEstimatedCostUsd += receipt.started.estimatedCostUsd;
      }
      return summary;
    });
  }
  private receipt(attemptId: string): Receipt {
    ensure(id(attemptId)); const row = this.get('SELECT * FROM external_attempts WHERE id=?', attemptId); ensure(row, 'not-found');
    const job = this.findJob(row.job_id as string), inputRef = row.input_ref as string;
    const input = row.kind === 'analysis' ? this.artifact<RuntimePrepared>(inputRef, 'prepared')
      : row.kind === 'parse' ? this.artifact<ParseInput>(inputRef, 'parse-input') : this.artifact<PublicationInput>(inputRef, 'publication-input');
    if ('matchId' in input) ensure(input.matchId === job.matchId, 'integrity-error');
    if ('side' in input) ensure(input.side === job.side && job.refs.prepared === inputRef, 'integrity-error');
    if ('guildId' in input) ensure(input.guildId === job.settings.guildId && input.channelId === job.settings.channelId, 'integrity-error');
    const resolutions = this.all('SELECT * FROM resolutions WHERE attempt_id=? ORDER BY created_at,id', attemptId).map(item => {
      const value = JSON.parse(item.input as string); ensure(digest(value) === item.digest, 'integrity-error'); return { ...value, createdAt: item.created_at as number };
    });
    return { id: attemptId, jobId: row.job_id as string, kind: row.kind as Receipt['kind'], state: row.state as Receipt['state'], inputRef, input,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number, unresolved: row.unresolved === 1, released: row.released === 1,
      started: row.started_ref ? this.artifact(row.started_ref as string, 'analysis-started') : null,
      outcome: row.outcome_ref ? this.artifact(row.outcome_ref as string, `${row.kind}-outcome`) : null, resolutions };
  }
  listAttempts(jobId: string): Receipt[] { return this.run('listAttempts', () => { this.findJob(jobId); return this.all('SELECT id FROM external_attempts WHERE job_id=? ORDER BY created_at,id', jobId).map(row => this.receipt(row.id as string)); }); }
  getLatestResult(matchId: number, side: Side, profile: 'legacy'): Extract<StoredResult, { analysisProfile: 'legacy' }> | null;
  getLatestResult(matchId: number, side: Side, profile: 'gemini'): Extract<StoredResult, { analysisProfile: 'gemini' }> | null;
  getLatestResult(matchId: number, side: Side): StoredResult | null;
  getLatestResult(matchId: number, side: Side, profile?: 'legacy' | 'gemini'): StoredResult | null {
    return this.run('getLatestResult', () => {
      pair(matchId, side); const row = this.get('SELECT * FROM jobs WHERE match_id=? AND side=? AND result_attempt_id IS NOT NULL ORDER BY revision DESC LIMIT 1', matchId, side); if (!row) return null;
      const job = this.job(row), receipt = this.receipt(job.resultAttemptId!); ensure(profile === undefined || job.analysisProfile === profile, 'integrity-error');
      ensure(receipt.kind === 'analysis' && (receipt.outcome as { status?: string })?.status === 'valid', 'integrity-error');
      const attempt = receipt.outcome; ensure(attempt && 'requestSent' in attempt, 'integrity-error');
      const publications = this.all("SELECT id FROM external_attempts WHERE job_id=? AND kind='publication' ORDER BY created_at,id", job.id).map(item => this.receipt(item.id as string));
      if (isGeminiAttempt(attempt)) { ensure(job.analysisProfile === 'gemini', 'integrity-error'); return { analysisProfile: 'gemini', job, attempt, publications }; }
      ensure(job.analysisProfile === 'legacy', 'integrity-error'); return { analysisProfile: 'legacy', job, attempt, publications };
    });
  }
}

export function openStorage(options: StorageOptions): Storage { return new Storage(options); }
