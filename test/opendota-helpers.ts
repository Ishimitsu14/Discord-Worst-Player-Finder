import assert from 'node:assert/strict';
import { OpenDotaClient, OpenDotaError, type Clock, type ErrorCode } from '../src/opendota/index.js';

export const flush = async (): Promise<void> => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
export class TestClock implements Clock {
  time = 1800000000000;
  private sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): number => {
    const id = ++this.sequence; this.timers.set(id, { at: this.time + ms, callback }); return id;
  };
  clearTimeout = (id: unknown): void => { this.timers.delete(id as number); };
  async tick(ms: number): Promise<void> {
    await flush();
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = end; await flush();
  }
}
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const errorIs = (code: ErrorCode, extra: Partial<OpenDotaError> = {}) => (error: unknown): boolean => {
  assert.ok(error instanceof OpenDotaError);
  assert.equal(error.code, code);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key as keyof OpenDotaError], value);
  return true;
};
export function upstream(handler: (url: URL, init: RequestInit, index: number) => Response | Promise<Response>, key?: string) {
  const clock = new TestClock(), calls: { url: URL; init: RequestInit; at: number }[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    assert.equal(init.redirect, 'error');
    const parsed = new URL(String(url)); calls.push({ url: parsed, init, at: clock.now() });
    return handler(parsed, init, calls.length - 1);
  };
  const client = new OpenDotaClient(key ? { apiKey: key } : {}, { clock, fetcher, random: () => 0 });
  return { client, calls, clock };
}
