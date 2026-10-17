import type { Clock } from '../opendota/index.js';

export type { Clock };
export type ErrorCode = 'invalid-input' | 'history-private' | 'api-error' | 'unauthorized' | 'forbidden' | 'rate-limited'
  | 'network-error' | 'timeout' | 'upstream-error' | 'invalid-response' | 'aborted';
export class SteamHistoryError extends Error {
  constructor(public readonly code: ErrorCode, public readonly operation = 'getMatchHistory',
    public readonly details: { httpStatus?: number; apiStatus?: number; retryAt?: number } = {}) {
    super(`Steam history: ${code}`); this.name = 'SteamHistoryError';
  }
  toJSON() { return { code: this.code, operation: this.operation, ...this.details, message: this.message }; }
}
export interface SteamHistoryPage { matches: { matchId: number; startTime: number }[]; nextStartAtMatchId: number | null }
export interface HistoryOptions { limit?: number; startAtMatchId?: number; signal?: AbortSignal }
export interface ClientDependencies { fetcher?: typeof fetch; clock?: Clock; random?: () => number }
