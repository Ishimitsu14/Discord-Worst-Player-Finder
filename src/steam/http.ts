import { SteamHistoryError, type ClientDependencies, type Clock, type ErrorCode } from './types.js';

export const nativeClock: Clock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
export function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SteamHistoryError('aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export class Http {
  #key: string;
  #fetcher: typeof fetch;
  #clock: Clock;
  #random: () => number;
  #usage: number[] = [];
  #cooldown = 0;
  constructor(key: string, deps: ClientDependencies) { this.#key = key; this.#fetcher = deps.fetcher ?? fetch; this.#clock = deps.clock ?? nativeClock; this.#random = deps.random ?? Math.random; }
  private admit(): void {
    const now = this.#clock.now(); this.#usage = this.#usage.filter(at => at + 60000 > now);
    const retryAt = Math.max(this.#cooldown, this.#usage.length >= 60 ? this.#usage[0] + 60000 : 0);
    if (retryAt > now) throw new SteamHistoryError('rate-limited', 'getMatchHistory', { retryAt });
    this.#usage.push(now);
  }
  async request<T>(params: URLSearchParams, validate: (payload: unknown) => T, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new SteamHistoryError('aborted');
      const scope = new AbortController(), abort = () => scope.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = this.#clock.setTimeout(abort, 10000);
      let failure: SteamHistoryError;
      try {
        this.admit(); const query = new URLSearchParams(params); query.set('key', this.#key);
        const response = await abortable(() => this.#fetcher(`https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/?${query}`, { signal: scope.signal, redirect: 'error' }), scope.signal);
        if (!response.ok) {
          const status = response.status;
          const code: ErrorCode = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate-limited' : status >= 500 ? 'upstream-error' : 'api-error';
          if (status === 429) {
            const value = response.headers.get('Retry-After'), now = this.#clock.now();
            const parsed = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : value ? Date.parse(value) : NaN;
            this.#cooldown = Math.max(this.#cooldown, Number.isSafeInteger(Math.ceil(parsed)) ? Math.max(now, Math.ceil(parsed)) : now + 60000);
          }
          void response.body?.cancel().catch(() => {});
          throw new SteamHistoryError(code, 'getMatchHistory', { httpStatus: status, ...(status === 429 ? { retryAt: this.#cooldown } : {}) });
        }
        let payload: unknown;
        try { payload = await abortable(() => response.json(), scope.signal); }
        catch (error) { if (scope.signal.aborted) throw error; throw new SteamHistoryError(error instanceof SyntaxError ? 'invalid-response' : 'network-error'); }
        if (JSON.stringify(payload).includes(this.#key)) throw new SteamHistoryError('invalid-response');
        return validate(payload);
      } catch (error) {
        failure = signal?.aborted ? new SteamHistoryError('aborted') : scope.signal.aborted ? new SteamHistoryError('timeout')
          : error instanceof SteamHistoryError ? error : new SteamHistoryError('network-error');
      } finally { this.#clock.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      if (attempt >= 2 || !['network-error', 'timeout', 'upstream-error'].includes(failure.code)) throw failure;
      const delay = 1000 * (attempt + 1) + Math.floor(this.#random() * 251), wait = new AbortController();
      const cancel = () => wait.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) wait.abort();
      let pending: unknown;
      try { await abortable(() => new Promise<void>(resolve => { pending = this.#clock.setTimeout(resolve, delay); }), wait.signal); }
      finally { if (pending !== undefined) this.#clock.clearTimeout(pending); signal?.removeEventListener('abort', cancel); }
    }
  }
}
