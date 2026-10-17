export type Raw = Record<string, unknown>;
export type Operation = 'createClient' | 'getPlayerMatches' | 'getMatch' | 'requestParse' | 'getParseJob' | 'waitForParsedMatch';
export type ErrorCode = 'invalid_argument' | 'not_found' | 'unauthorized' | 'forbidden' | 'bad_request' | 'rate_limited'
  | 'network_error' | 'timeout' | 'upstream_error' | 'invalid_response' | 'aborted';

export interface OpenDotaErrorSummary {
  code: ErrorCode; operation: Operation; httpStatus?: number; retryAt?: number; requestMayHaveSucceeded: boolean;
}
const messages: Record<ErrorCode, string> = {
  invalid_argument: 'Некорректные параметры OpenDota.', not_found: 'Ресурс OpenDota не найден.',
  unauthorized: 'OpenDota отклонил авторизацию.', forbidden: 'OpenDota запретил доступ.', bad_request: 'OpenDota отклонил запрос.',
  rate_limited: 'Достигнут лимит запросов OpenDota.', network_error: 'Сетевая ошибка OpenDota.', timeout: 'Истёк срок запроса OpenDota.',
  upstream_error: 'Временная ошибка OpenDota.', invalid_response: 'Некорректный ответ OpenDota.', aborted: 'Операция OpenDota отменена.',
};
export class OpenDotaError extends Error implements OpenDotaErrorSummary {
  readonly httpStatus?: number;
  readonly retryAt?: number;
  readonly requestMayHaveSucceeded: boolean;
  constructor(public readonly code: ErrorCode, public readonly operation: Operation, details: Partial<Pick<OpenDotaErrorSummary, 'httpStatus' | 'retryAt' | 'requestMayHaveSucceeded'>> = {}) {
    super(messages[code]);
    this.name = 'OpenDotaError';
    this.httpStatus = details.httpStatus; this.retryAt = details.retryAt;
    this.requestMayHaveSucceeded = details.requestMayHaveSucceeded ?? false;
  }
  toJSON(): OpenDotaErrorSummary {
    return { code: this.code, operation: this.operation, ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }), requestMayHaveSucceeded: this.requestMayHaveSucceeded };
  }
}

export interface MatchBase extends Raw {
  match_id: number; start_time: number; duration: number; game_mode: number; lobby_type: number; radiant_win: boolean | null;
}
export interface PlayerMatch extends MatchBase { player_slot: number; hero_id: number }
export interface MatchPlayer extends Raw { player_slot: number; hero_id: number }
export interface MatchData extends MatchBase { players: MatchPlayer[]; version?: number | null }
export interface MatchSnapshot { data: MatchData; parseState: 'basic' | 'parsed'; retrievedAt: number }
export interface ParseRequest { matchId: number; jobId: string }
export type ParseJob = { state: 'present'; data: Raw & { jobId: string | number } } | { state: 'missing' };
export type ParsedMatchResult =
  | { state: 'parsed'; matchId: number; jobId: string; snapshot: MatchSnapshot }
  | { state: 'timed-out'; matchId: number; jobId: string; snapshot: MatchSnapshot | null; lastError: OpenDotaErrorSummary | null };
export interface ReadOptions { signal?: AbortSignal }
export interface PlayerMatchesOptions extends ReadOptions { limit?: number; offset?: number }
export interface MatchOptions extends ReadOptions { fresh?: boolean }
export interface WaitOptions extends ReadOptions { timeoutMs?: number }
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface ClientOptions { apiKey?: string }
export interface ClientDependencies { fetcher?: typeof fetch; clock?: Clock; random?: () => number }
