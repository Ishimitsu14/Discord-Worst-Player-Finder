import { Http, abortable, checkAbort, deadline, delay, temporary } from './http.js';
import { jobId, match, object, parseJob, parseRequest, playerMatches, positive, requireArgument } from './validation.js';
import { OpenDotaError, type ClientDependencies, type ClientOptions, type MatchOptions, type MatchSnapshot, type OpenDotaErrorSummary,
  type Operation, type ParsedMatchResult, type ParseJob, type ParseRequest, type PlayerMatch, type PlayerMatchesOptions, type ReadOptions, type WaitOptions } from './types.js';

interface SharedParse { promise: Promise<ParseRequest>; controller: AbortController; subscribers: number; sent: boolean }

export class OpenDotaClient {
  private readonly http: Http;
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly reads = new Map<string, Promise<unknown>>();
  private readonly parses = new Map<number, SharedParse>();
  private cacheEpoch = 0;
  constructor(options: ClientOptions = {}, dependencies: ClientDependencies = {}) {
    requireArgument(object(options), 'createClient');
    requireArgument(options.apiKey === undefined || typeof options.apiKey === 'string' && options.apiKey.trim().length > 0, 'createClient');
    this.http = new Http(options.apiKey?.trim(), dependencies);
  }
  private readOptions(options: ReadOptions, operation: Operation): void {
    requireArgument(object(options), operation);
    requireArgument(options.signal === undefined || options.signal instanceof AbortSignal, operation);
    checkAbort(options.signal, operation);
  }
  private read<T>(key: string, signal: AbortSignal | undefined, fresh: boolean, ttl: (value: T) => number, load: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.expires > this.http.clock.now()) return Promise.resolve(structuredClone(cached.value) as T);
    const pending = !signal && this.reads.get(key);
    if (pending) return pending.then(value => structuredClone(value) as T);
    const epoch = this.cacheEpoch;
    const promise = load().then(value => {
      const lifetime = ttl(value);
      if (lifetime > 0 && epoch === this.cacheEpoch) {
        this.cache.delete(key);
        this.cache.set(key, { value: structuredClone(value), expires: this.http.clock.now() + lifetime });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return value;
    });
    if (!signal) this.reads.set(key, promise);
    return promise.then(value => structuredClone(value)).finally(() => {
      if (!signal && this.reads.get(key) === promise) this.reads.delete(key);
    });
  }
  async getPlayerMatches(accountId: number, options: PlayerMatchesOptions = {}): Promise<PlayerMatch[]> {
    const operation = 'getPlayerMatches';
    this.readOptions(options, operation);
    const { limit = 20, offset = 0, signal } = options;
    requireArgument(positive(accountId) && accountId < 4294967295 && positive(limit) && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0, operation);
    const path = `/players/${accountId}/matches?limit=${limit}&offset=${offset}&significant=0`;
    return this.read(path, signal, false, () => 30000, () => this.http.request(operation, path, 'GET', playerMatches, signal));
  }
  async getMatch(matchId: number, options: MatchOptions = {}): Promise<MatchSnapshot> {
    const operation = 'getMatch';
    this.readOptions(options, operation);
    requireArgument(positive(matchId) && (options.fresh === undefined || typeof options.fresh === 'boolean'), operation);
    return this.read(`match/${matchId}`, options.signal, options.fresh ?? false, value => value.parseState === 'parsed' ? 900000 : 15000,
      () => this.http.request(operation, `/matches/${matchId}`, 'GET', value => {
        const data = match(value, matchId);
        return { data, parseState: data.version && data.version > 0 ? 'parsed' : 'basic', retrievedAt: this.http.clock.now() } as MatchSnapshot;
      }, options.signal));
  }
  async getParseJob(inputJobId: string, options: ReadOptions = {}): Promise<ParseJob> {
    const operation = 'getParseJob';
    this.readOptions(options, operation);
    const id = jobId(inputJobId, operation);
    return this.read(`job/${id}`, options.signal, true, () => 0,
      () => this.http.request(operation, `/request/${id}`, 'GET', value => parseJob(value, id), options.signal));
  }
  async requestParse(matchId: number, options: ReadOptions = {}): Promise<ParseRequest> {
    const operation = 'requestParse';
    this.readOptions(options, operation);
    requireArgument(positive(matchId), operation);
    let shared = this.parses.get(matchId);
    if (!shared) {
      const entry: SharedParse = { controller: new AbortController(), subscribers: 0, sent: false, promise: undefined! };
      entry.promise = Promise.resolve().then(() => this.http.request(operation, `/request/${matchId}`, 'POST', value => parseRequest(value, matchId), entry.controller.signal, () => {
        entry.sent = true; this.cacheEpoch++; this.cache.delete(`match/${matchId}`);
      })).finally(() => {
        if (entry.sent) { this.cacheEpoch++; this.cache.delete(`match/${matchId}`); }
        if (this.parses.get(matchId) === entry) this.parses.delete(matchId);
      });
      void entry.promise.catch(() => {});
      this.parses.set(matchId, entry); shared = entry;
    }
    const entry = shared;
    entry.subscribers++;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
      entry.subscribers--;
      if (entry.subscribers === 0 && !entry.sent) {
        entry.controller.abort();
        if (this.parses.get(matchId) === entry) this.parses.delete(matchId);
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try { return structuredClone(await abortable(() => entry.promise, controller.signal)); }
    catch (error) {
      if (options.signal?.aborted) throw new OpenDotaError('aborted', operation, { requestMayHaveSucceeded: entry.sent });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (!options.signal?.aborted) entry.subscribers--;
    }
  }
  async waitForParsedMatch(matchId: number, inputJobId: string, options: WaitOptions = {}): Promise<ParsedMatchResult> {
    const operation = 'waitForParsedMatch';
    this.readOptions(options, operation);
    const id = jobId(inputJobId, operation), timeoutMs = options.timeoutMs === undefined ? 900000 : options.timeoutMs;
    requireArgument(positive(matchId) && positive(timeoutMs), operation);
    const scope = deadline(this.http.clock, timeoutMs, options.signal), end = this.http.clock.now() + timeoutMs;
    let snapshot: MatchSnapshot | null = null, lastError: OpenDotaErrorSummary | null = null;
    try {
      while (!scope.signal.aborted && this.http.clock.now() < end) {
        let retryAt = 0;
        try {
          snapshot = await this.getMatch(matchId, { fresh: true, signal: scope.signal });
          if (scope.signal.aborted || this.http.clock.now() >= end) break;
          if (snapshot.parseState === 'parsed') return { state: 'parsed', matchId, jobId: id, snapshot };
          const job = await this.getParseJob(id, { signal: scope.signal });
          if (job.state === 'present' && object(job.data.data) && Object.hasOwn(job.data.data, 'match_id') && job.data.data.match_id !== matchId) {
            throw new OpenDotaError('invalid_response', operation);
          }
        } catch (error) {
          if (scope.signal.aborted || this.http.clock.now() >= end) break;
          if (!(error instanceof OpenDotaError)) throw new OpenDotaError('invalid_response', operation);
          if (!temporary(error.code)) throw new OpenDotaError(error.code, operation, error.toJSON());
          lastError = error.toJSON(); retryAt = error.retryAt ?? 0;
        }
        if (scope.signal.aborted || this.http.clock.now() >= end) break;
        try { await delay(this.http.clock, Math.min(end - this.http.clock.now(), Math.max(15000, retryAt - this.http.clock.now())), scope.signal); }
        catch { break; }
      }
      checkAbort(options.signal, operation);
      return { state: 'timed-out', matchId, jobId: id, snapshot, lastError };
    } finally { scope.dispose(); }
  }
}
