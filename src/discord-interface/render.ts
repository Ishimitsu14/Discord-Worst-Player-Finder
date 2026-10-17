import { createHash } from 'node:crypto';
import { validateMatchAnalysis } from '../match-analysis/index.js';
import { DiscordInterfaceError, type APIEmbed, type PublicationContext } from './types.js';
import { allowedMentions, ensure, id, integer, keys, object } from './values.js';

const domain = /(?:[a-z\d][a-z\d-]*\.)+[a-z]{2,63}(?=[:/\s?#]|$)/giu;
const activeUrl = /[a-z][a-z\d+.-]*:\/\/|www\.(?!\u200b)|(?:[a-z\d][a-z\d-]*\.)+[a-z]{2,63}(?=[:/\s?#]|$)/iu;
export function cleanText(value: string): string {
  return value.replace(/[\ud800-\udfff]/gu, '�').replace(/[\s]+/gu, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '')
    .replace(domain, token => token.replaceAll('.', '.\u200b')).replace(/([a-z][a-z\d+.-]*:)(?=\/\/)/giu, '$1\u200b')
    .replaceAll('@', '@\u200b').replace(/[\\`*_{}\[\]()<>~|]/g, '\\$&').trim();
}
export function shorten(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let prefix = ''; for (const point of value) { if (prefix.length + point.length > limit - 1) break; prefix += point; }
  const boundary = prefix.lastIndexOf(' '); if (boundary >= limit / 2) prefix = prefix.slice(0, boundary);
  else if (!/\s/u.test(value[prefix.length] ?? ' ') && /\S*\d\S*$/u.test(prefix)) prefix = prefix.replace(/\S*\d\S*$/u, '');
  return prefix.replace(/\\+$/u, '').trimEnd() + '…';
}
function safeText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\ud800-\udfff]/u.test(value) || activeUrl.test(value) || /@(?!\u200b)/u.test(value)
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\') { index++; if (index === value.length) return false; }
    else if ('`*_{}[]()<>~|'.includes(value[index])) return false;
  }
  return true;
}
export function validateEmbed(value: unknown): asserts value is APIEmbed {
  const check = (ok: unknown) => ensure(ok, 'invalid-message', 'render');
  keys(value, ['title', 'url', 'description', 'fields', 'footer'], ['color'], 'invalid-message', 'render');
  check(safeText(value.title, 256) && safeText(value.description, 4096));
  check(typeof value.url === 'string' && /^https:\/\/www\.opendota\.com\/matches\/[1-9][0-9]{0,15}$/.test(value.url) && integer(Number(value.url.split('/').at(-1)), 1));
  check(value.color === undefined || integer(value.color, 0, 0xffffff));
  check(Array.isArray(value.fields) && value.fields.length <= 25);
  let sum = (value.title as string).length + (value.description as string).length;
  for (const field of value.fields as unknown[]) {
    keys(field, ['name', 'value'], [], 'invalid-message', 'render'); check(safeText(field.name, 256) && safeText(field.value, 1024));
    sum += (field.name as string).length + (field.value as string).length;
  }
  keys(value.footer, ['text'], [], 'invalid-message', 'render'); check(safeText(value.footer.text, 2048)); sum += (value.footer.text as string).length; check(sum <= 6000);
}
export const publicationNonce = (attemptId: string): string => createHash('sha256').update(attemptId, 'utf8').digest('hex').slice(0, 25);

export function renderAnalysis(input: PublicationContext): APIEmbed {
  try {
    const { job, analysis: attempt, bundle, snapshot } = input;
    ensure(attempt.status === 'valid' && id(attempt.attemptId) && job.resultAttemptId === attempt.attemptId && integer(job.matchId, 1) && integer(job.revision, 1), 'invalid-result', 'render');
    ensure(attempt.identity?.matchId === job.matchId && attempt.identity.side === job.side && attempt.identity.bundleId === bundle.manifest.bundleId
      && bundle.manifest.matchId === job.matchId && bundle.manifest.side === job.side && snapshot.data.match_id === job.matchId
      && ['radiant', 'dire'].includes(job.side) && typeof snapshot.data.radiant_win === 'boolean' && integer(snapshot.data.duration, 1), 'invalid-result', 'render');
    const analysis = validateMatchAnalysis(attempt.analysis, bundle);
    ensure('value' in bundle.context.match.duration && bundle.context.match.duration.value === snapshot.data.duration
      && 'value' in bundle.context.match.radiant_win && bundle.context.match.radiant_win.value === snapshot.data.radiant_win, 'invalid-result', 'render');
    let shortened = false;
    const text = (value: string, limit: number): string => { const cleaned = cleanText(value), result = shorten(cleaned, limit); shortened ||= result !== cleaned; ensure(result.trim(), 'invalid-result', 'render'); return result; };
    const side = job.side === 'radiant' ? 'Radiant' : 'Dire', won = snapshot.data.radiant_win === (job.side === 'radiant');
    const duration = `${Math.floor(snapshot.data.duration / 60)}:${String(snapshot.data.duration % 60).padStart(2, '0')}`;
    const fields: { name: string; value: string }[] = [];
    for (const selected of analysis.selectedPlayers) {
      const player = bundle.context.allies.find(row => row.playerSlot === selected.playerSlot)!, raw = snapshot.data.players.find(row => row.player_slot === selected.playerSlot);
      ensure(raw && raw.hero_id === player.heroId, 'invalid-result', 'render');
      const hero = player.heroName || `Герой #${player.heroId}`;
      const rawNickname = typeof raw.personaname === 'string' ? raw.personaname : '', boundedNickname = shorten(rawNickname, 512);
      shortened ||= rawNickname !== boundedNickname;
      const nickname = cleanText(boundedNickname) ? boundedNickname : `Игрок, слот ${player.playerSlot}`;
      fields.push({ name: `${text(nickname, 50)} — ${text(hero, 40)}`, value: text(selected.roast, 400) });
      selected.reasons.forEach((reason, index) => fields.push({ name: text(`Основание ${index + 1} — ${hero}`, 40), value: text(reason.claim, 600) }));
    }
    if (analysis.limitations.length) fields.push({ name: 'Ограничения', value: text(analysis.limitations.join(' • '), 389) });
    const description = `${text(analysis.status === 'insufficient-evidence' ? 'Недостаточно данных для обоснованного выбора.' : analysis.comparison!.claim, 450 - duration.length - 3)} • ${duration}`;
    const confidence = { low: 'низкая', medium: 'средняя', high: 'высокая' }[analysis.confidence];
    const embed: APIEmbed = {
      title: `${analysis.status === 'insufficient-evidence' ? 'Недостаточно данных' : 'Разбор'} #${job.matchId} — ${side}: ${won ? 'победа' : 'поражение'}`,
      url: `https://www.opendota.com/matches/${job.matchId}`, description, fields, color: 0x5865f2,
      footer: { text: `Версия ${job.revision} • уверенность ${confidence}${attempt.identity!.calibration === 'experimental' ? ' • экспериментально' : ''}${shortened ? ' • текст сокращён' : ''}` },
    };
    validateEmbed(embed); return embed;
  } catch (error) { if (error instanceof DiscordInterfaceError) throw error; throw new DiscordInterfaceError('invalid-result', 'render'); }
}

export function publicationMessage(input: PublicationContext): string {
  return JSON.stringify({ embeds: [renderAnalysis(input)], allowed_mentions: allowedMentions, nonce: publicationNonce(input.analysis.attemptId!), enforce_nonce: true });
}
export function validateMessage(message: string, attemptId: string): void {
  try {
    ensure(typeof message === 'string' && Buffer.byteLength(message) <= 64 * 1024 && id(attemptId), 'invalid-message', 'render');
    const value: unknown = JSON.parse(message); keys(value, ['embeds', 'allowed_mentions', 'nonce', 'enforce_nonce'], [], 'invalid-message', 'render');
    ensure(Array.isArray(value.embeds) && value.embeds.length === 1 && value.nonce === publicationNonce(attemptId) && value.enforce_nonce === true, 'invalid-message', 'render');
    keys(value.allowed_mentions, ['parse', 'users', 'roles', 'replied_user'], [], 'invalid-message', 'render');
    const mentions = value.allowed_mentions;
    ensure(['parse', 'users', 'roles'].every(key => Array.isArray(mentions[key]) && mentions[key].length === 0) && mentions.replied_user === false, 'invalid-message', 'render');
    validateEmbed(value.embeds[0]);
  } catch { throw new DiscordInterfaceError('invalid-message', 'render'); }
}
