import { Http } from './http.js';
import { SteamHistoryError, type ClientDependencies, type HistoryOptions, type SteamHistoryPage } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
function ensure(value: unknown, response = false): asserts value { if (!value) throw new SteamHistoryError(response ? 'invalid-response' : 'invalid-input'); }
export class SteamHistoryClient {
  #http: Http;
  constructor(options: { apiKey: string }, deps: ClientDependencies = {}) {
    ensure(object(options) && typeof options.apiKey === 'string' && options.apiKey.trim().length > 0 && object(deps));
    ensure(deps.fetcher === undefined || typeof deps.fetcher === 'function');
    ensure(deps.random === undefined || typeof deps.random === 'function');
    ensure(deps.clock === undefined || deps.clock && ['now', 'setTimeout', 'clearTimeout'].every(key => typeof (deps.clock as unknown as Record<string, unknown>)[key] === 'function'));
    this.#http = new Http(options.apiKey.trim(), deps);
  }
  async getMatchHistory(accountId: number, options: HistoryOptions = {}): Promise<SteamHistoryPage> {
    ensure(integer(accountId, 1, 4294967294) && object(options) && Object.keys(options).every(key => ['limit', 'startAtMatchId', 'signal'].includes(key)));
    const limit = options.limit ?? 20; ensure(integer(limit, 1, 100));
    const cursor = options.startAtMatchId; ensure(cursor === undefined || integer(cursor, 1));
    ensure(options.signal === undefined || options.signal instanceof AbortSignal);
    const params = new URLSearchParams({ account_id: String(accountId), matches_requested: String(limit) });
    if (cursor !== undefined) params.set('start_at_match_id', String(cursor));
    return this.#http.request(params, payload => {
      ensure(object(payload) && object(payload.result), true); const result = payload.result;
      ensure(integer(result.status), true);
      if (result.status !== 1) throw new SteamHistoryError(result.status === 15 ? 'history-private' : 'api-error', 'getMatchHistory', { apiStatus: result.status });
      ensure(Array.isArray(result.matches) && integer(result.num_results) && integer(result.total_results) && integer(result.results_remaining), true);
      ensure(result.num_results === result.matches.length && result.num_results <= limit && result.total_results >= result.num_results
        && result.results_remaining === result.total_results - result.num_results, true);
      const matches = result.matches.map(row => {
        ensure(object(row) && integer(row.match_id, 1) && integer(row.start_time) && (cursor === undefined || row.match_id <= cursor), true);
        return { matchId: row.match_id, startTime: row.start_time };
      });
      ensure(new Set(matches.map(row => row.matchId)).size === matches.length, true);
      const next = result.results_remaining > 0 ? Math.min(...matches.map(row => row.matchId)) - 1 : null;
      ensure(next === null || integer(next, 1) && matches.length > 0 && (cursor === undefined || next < cursor), true);
      return { matches, nextStartAtMatchId: next };
    }, options.signal);
  }
}
