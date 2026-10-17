import { OpenDotaError, type ClientDependencies, type Clock, type ErrorCode, type Operation } from './types.js';

export const baseUrl = 'https://api.opendota.com/api';
export const systemClock: Clock = {
  now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export const temporary = (code: ErrorCode): boolean => ['network_error', 'timeout', 'upstream_error', 'rate_limited'].includes(code);
export function checkAbort(signal: AbortSignal | undefined, operation: Operation): void {
  if (signal?.aborted) throw new OpenDotaError('aborted', operation);
}
export function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function deadline(clock: Clock, ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController(), end = clock.now() + ms;
  let timer: unknown;
  const arm = (): void => {
    const remaining = end - clock.now();
    if (remaining <= 0) controller.abort();
    else timer = clock.setTimeout(arm, Math.min(remaining, 2147483647));
  };
  const abort = (): void => controller.abort();
  if (parent?.aborted) abort();
  else { parent?.addEventListener('abort', abort, { once: true }); arm(); }
  return { signal: controller.signal, dispose() { if (timer !== undefined) clock.clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
export function delay(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: unknown;
    const dispose = (): void => { if (timer !== undefined) clock.clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = (): void => { dispose(); reject(signal?.reason); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = clock.setTimeout(() => { dispose(); resolve(); }, ms);
  });
}
function retryAfter(value: string | null, now: number): number {
  let retryAt = NaN;
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) retryAt = now + Number(value) * 1000;
  else if (value && /[a-z]/i.test(value)) retryAt = Date.parse(value);
  return Number.isSafeInteger(Math.ceil(retryAt)) ? Math.max(now, Math.ceil(retryAt)) : now + 60000;
}

export class Http {
  readonly clock: Clock;
  #fetcher: typeof fetch;
  #apiKey?: string;
  #random: () => number;
  #usage: { at: number; cost: number }[] = [];
  #cooldown = 0;
  constructor(apiKey: string | undefined, dependencies: ClientDependencies) {
    this.#apiKey = apiKey; this.#fetcher = dependencies.fetcher ?? fetch;
    this.clock = dependencies.clock ?? systemClock; this.#random = dependencies.random ?? Math.random;
  }
  private availableAt(cost: number): number {
    const now = this.clock.now();
    this.#usage = this.#usage.filter(entry => entry.at + 60000 > now);
    let excess = this.#usage.reduce((sum, entry) => sum + entry.cost, cost) - 60;
    let retryAt = this.#cooldown;
    for (const entry of this.#usage) {
      if (excess <= 0) break;
      excess -= entry.cost; retryAt = Math.max(retryAt, entry.at + 60000);
    }
    return Math.max(now, retryAt);
  }
  private admit(operation: Operation, cost: number): void {
    const now = this.clock.now(), retryAt = this.availableAt(cost);
    if (retryAt > now) throw new OpenDotaError('rate_limited', operation, { retryAt });
    this.#usage.push({ at: now, cost });
  }
  async request<T>(operation: Operation, path: string, method: 'GET' | 'POST', validate: (value: unknown) => T, signal?: AbortSignal, onSend?: () => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal, operation);
      const startedAt = this.clock.now();
      const scope = deadline(this.clock, 10000, signal);
      let sent = false;
      let failure: OpenDotaError;
      try {
        const response = await abortable(() => {
          this.admit(operation, method === 'POST' ? 10 : 1);
          onSend?.(); sent = true;
          return this.#fetcher(baseUrl + path, { method, signal: scope.signal, redirect: 'error',
            headers: this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {} });
        }, scope.signal);
        if (!response.ok) {
          const status = response.status;
          const code = status === 400 ? 'bad_request' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden'
            : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_error' : 'bad_request';
          if (status === 429) this.#cooldown = Math.max(this.#cooldown, retryAfter(response.headers.get('Retry-After'), this.clock.now()));
          void response.body?.cancel().catch(() => {});
          throw new OpenDotaError(code, operation, { httpStatus: status, ...(status === 429 ? { retryAt: this.availableAt(method === 'POST' ? 10 : 1) } : {}) });
        }
        let payload: unknown;
        try { payload = await abortable(() => response.json(), scope.signal); }
        catch (error) { throw new OpenDotaError(error instanceof SyntaxError ? 'invalid_response' : 'network_error', operation); }
        if (this.clock.now() - startedAt >= 10000) throw new OpenDotaError('timeout', operation);
        if (this.#apiKey) JSON.stringify(payload, (name, value) => {
          if (name.includes(this.#apiKey!) || typeof value === 'string' && value.includes(this.#apiKey!)) throw new OpenDotaError('invalid_response', operation);
          return value;
        });
        return validate(payload);
      } catch (error) {
        failure = signal?.aborted ? new OpenDotaError('aborted', operation) : scope.signal.aborted ? new OpenDotaError('timeout', operation)
          : error instanceof OpenDotaError ? error : new OpenDotaError('network_error', operation);
        if (method === 'POST' && sent && ['aborted', 'timeout', 'network_error', 'upstream_error', 'invalid_response'].includes(failure.code)) {
          failure = new OpenDotaError(failure.code, operation, { ...failure.toJSON(), requestMayHaveSucceeded: true });
        }
      } finally { scope.dispose(); }
      if (method === 'POST' || attempt >= 2 || !['network_error', 'timeout', 'upstream_error'].includes(failure.code)) throw failure;
      try { await delay(this.clock, 1000 * (attempt + 1) + Math.floor(this.#random() * 251), signal); }
      catch { throw new OpenDotaError('aborted', operation); }
    }
  }
}
