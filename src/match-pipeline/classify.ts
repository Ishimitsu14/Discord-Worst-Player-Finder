import type { MatchData, MatchBase } from '../opendota/index.js';
import { integer } from './config.js';
import type { GroupSettings, Side } from './types.js';

const lobbies = new Set([5, 6, 7]), modes = new Set([1, 2, 3, 4, 5, 12, 16, 17, 22]);
const slots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
export type Classification = { status: 'eligible'; side: Side } | { status: 'rejected'; code: string } | { status: 'requires-side'; code: string };
export function supported(data: MatchBase): boolean { return lobbies.has(data.lobby_type) && modes.has(data.game_mode) && integer(data.duration, 1) && typeof data.radiant_win === 'boolean'; }
export function endAt(data: MatchBase, now: number): number | null {
  if (!integer(data.start_time) || !integer(data.duration, 1)) return null;
  const end = (data.start_time + data.duration) * 1000;
  return integer(end, 0, now) ? end : null;
}
export function classify(data: MatchData, settings: GroupSettings, origin: 'manual' | 'automatic', explicit?: Side): Classification {
  const reject = (code: string): Classification => ({ status: 'rejected', code });
  if (!supported(data)) return reject('unsupported-match');
  if (!Array.isArray(data.players) || data.players.some(player => !slots.includes(player.player_slot) || !integer(player.hero_id, 1))
    || new Set(data.players.map(player => player.player_slot)).size !== data.players.length) return reject('invalid-players');
  const groups = { radiant: new Set<number>(), dire: new Set<number>() };
  for (const player of data.players) {
    if (integer(player.account_id, 1, 4294967294) && settings.steamAccountIds.includes(player.account_id)) groups[player.player_slot < 128 ? 'radiant' : 'dire'].add(player.account_id);
  }
  if ([...groups.radiant].some(account => groups.dire.has(account))) return { status: 'requires-side', code: 'ambiguous-side' };
  let side = explicit;
  if (!side) {
    const minimum = origin === 'automatic' ? 2 : 1;
    const candidates = (['radiant', 'dire'] as const).filter(team => groups[team].size >= minimum);
    if (candidates.length !== 1) return candidates.length === 0 && origin === 'automatic' ? reject('not-group-match') : { status: 'requires-side', code: 'ambiguous-side' };
    side = candidates[0];
  }
  if (slots.filter(slot => (slot < 128) === (side === 'radiant')).some(slot => !data.players.some(player => player.player_slot === slot))) return reject('incomplete-allies');
  return { status: 'eligible', side };
}
