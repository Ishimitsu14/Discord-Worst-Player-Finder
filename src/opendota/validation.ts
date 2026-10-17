import { OpenDotaError, type MatchData, type Operation, type ParseJob, type PlayerMatch, type Raw } from './types.js';

export const object = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
export const integer = (value: unknown): value is number => Number.isSafeInteger(value);
export const positive = (value: unknown): value is number => integer(value) && value > 0;
const nonnegative = (value: unknown): value is number => integer(value) && value >= 0;
const slot = (value: unknown): value is number => nonnegative(value) && value <= 255;
export function requireArgument(value: unknown, operation: Operation): asserts value {
  if (!value) throw new OpenDotaError('invalid_argument', operation);
}
function requireResponse(value: unknown, operation: Operation): asserts value {
  if (!value) throw new OpenDotaError('invalid_response', operation);
}
export function jobId(value: unknown, operation: Operation, response = false): string {
  const valid = (typeof value === 'string' && /^\d+$/.test(value) || response && typeof value === 'number') && positive(Number(value));
  if (!valid) throw new OpenDotaError(response ? 'invalid_response' : 'invalid_argument', operation);
  return String(Number(value));
}
function base(value: unknown): value is Raw {
  return object(value) && positive(value.match_id) && nonnegative(value.start_time) && nonnegative(value.duration)
    && integer(value.game_mode) && integer(value.lobby_type) && (typeof value.radiant_win === 'boolean' || value.radiant_win === null);
}
export function playerMatches(value: unknown): PlayerMatch[] {
  requireResponse(Array.isArray(value), 'getPlayerMatches');
  requireResponse(value.every(row => base(row) && slot(row.player_slot) && positive(row.hero_id)), 'getPlayerMatches');
  return value as PlayerMatch[];
}
export function match(value: unknown, matchId: number): MatchData {
  requireResponse(base(value) && value.match_id === matchId && Array.isArray(value.players), 'getMatch');
  const players = value.players as unknown[];
  requireResponse(players.every(player => object(player) && slot(player.player_slot) && positive(player.hero_id)), 'getMatch');
  requireResponse(new Set(players.map(player => (player as Raw).player_slot)).size === players.length, 'getMatch');
  requireResponse(value.version === undefined || value.version === null || nonnegative(value.version), 'getMatch');
  return value as unknown as MatchData;
}
export function parseRequest(value: unknown, matchId: number): { matchId: number; jobId: string } {
  requireResponse(object(value) && object(value.job), 'requestParse');
  return { matchId, jobId: jobId(value.job.jobId, 'requestParse', true) };
}
export function parseJob(value: unknown, expected: string): ParseJob {
  if (value === null) return { state: 'missing' };
  requireResponse(object(value), 'getParseJob');
  requireResponse(jobId(value.jobId, 'getParseJob', true) === expected, 'getParseJob');
  return { state: 'present', data: value as Raw & { jobId: string | number } };
}
