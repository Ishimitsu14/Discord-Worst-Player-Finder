import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, digest, id, immutable, isDigest, json, now, object, parse, pointer, positiveInt, readJson, revision, validDate, version, within, atomicWrite } from './files.js';
import type { Corpus, Entry, Labels, Profile, Raw, Side, Split } from './types.js';

export const slotsFor = (side: Side): number[] => side === 'radiant' ? [0, 1, 2, 3, 4] : [128, 129, 130, 131, 132];
export const validSide = (side: unknown): side is Side => side === 'radiant' || side === 'dire';
export const entryKey = (entry: { matchId: number; side: Side }): string => `${entry.matchId}/${entry.side}`;

export function validateCorpus(input: unknown): Corpus {
  const data = version(input);
  check(typeof data.revision === 'string' && Array.isArray(data.entries), 'Некорректный корпус.');
  const keys = new Set<string>();
  const splits = new Map<number, string>();
  for (const item of data.entries) {
    const entry = object(item);
    check(positiveInt(entry.matchId) && validSide(entry.side), 'Некорректный матч или сторона.');
    check(entry.split === 'development' || entry.split === 'holdout', 'Некорректный раздел корпуса.');
    check(isDigest(entry.digest) && typeof entry.snapshot === 'string', 'Некорректная ссылка на снимок.');
    check(entry.retrievedAt === null || validDate(entry.retrievedAt), 'Некорректное время загрузки.');
    check(validDate(entry.importedAt) && typeof entry.usedForTuning === 'boolean', 'Не заданы метаданные корпуса.');
    check(['api', 'import', 'derived-fixture'].includes(String(entry.source)), 'Некорректный источник.');
    check(positiveInt(entry.originalMatchId) && (entry.parentDigest === null || isDigest(entry.parentDigest)), 'Некорректное происхождение.');
    check(entry.source !== 'derived-fixture' || isDigest(entry.parentDigest), 'Производной фикстуре нужен родительский digest.');
    const key = entryKey(entry as unknown as Entry);
    check(!keys.has(key), 'Дубликат матча и стороны в корпусе.');
    keys.add(key);
    for (const matchId of [entry.matchId, entry.originalMatchId]) {
      check(!splits.has(matchId) || splits.get(matchId) === entry.split, 'Стороны или производные одного матча попали в разные разделы.');
      splits.set(matchId, entry.split);
    }
  }
  return data as unknown as Corpus;
}

export function inspectMatch(raw: unknown, entry: Pick<Entry, 'matchId' | 'side'>, profile: Profile): { data: Raw; players: Raw[]; limitations: string[] } {
  const data = object(raw);
  check(data.match_id === entry.matchId, 'ID снимка не совпадает с ID матча.');
  check(validSide(entry.side), 'Нужна сторона radiant или dire.');
  check(typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0 && typeof data.radiant_win === 'boolean', 'Неизвестны длительность или исход.');
  check(typeof data.lobby_type === 'number' && profile.rankedLobbyIds.includes(data.lobby_type), 'Рейтинговый статус не подтверждён.', 'unsupported-mode');
  check(typeof data.game_mode === 'number' && profile.gameModeIds.includes(data.game_mode), typeof data.game_mode === 'number' ? 'Режим не поддерживается.' : 'Режим неизвестен.', typeof data.game_mode === 'number' ? 'unsupported-mode' : 'unknown-mode');
  check(Array.isArray(data.players), 'Нет игроков.');
  const players = data.players.map(object);
  const seen = new Set<number>();
  for (const player of players) {
    check([...slotsFor('radiant'), ...slotsFor('dire')].includes(Number(player.player_slot)) && typeof player.player_slot === 'number', 'Некорректный слот.');
    check(!seen.has(player.player_slot), 'Повторяющийся слот.');
    seen.add(player.player_slot);
    check(positiveInt(player.hero_id), 'Неизвестен герой игрока.');
  }
  check(slotsFor(entry.side).every(slot => seen.has(slot)), 'Нужны пять союзных слотов.');
  const limitations: string[] = [];
  if (players.length !== 10) limitations.push('Неполные данные соперников.');
  if (!(typeof data.version === 'number' && data.version > 0)) limitations.push('Базовый ответ: расширенные данные могут отсутствовать.');
  for (const player of players) {
    for (const field of ['gold_t', 'xp_t', 'lh_t', 'networth_t', 'hero_damage_t', 'purchase_log', 'kills_log', 'deaths_log', 'obs_log', 'sen_log']) {
      if (!Array.isArray(player[field])) limitations.push(`slot ${player.player_slot}: ${field} отсутствует или недоступно.`);
    }
  }
  if (!Array.isArray(data.teamfights)) limitations.push('Логи командных драк недоступны.');
  return { data, players, limitations };
}

export async function loadSnapshot(root: string, entry: Entry): Promise<Raw> {
  const bytes = await readFile(within(root, entry.snapshot));
  check(digest(bytes) === entry.digest, 'Контрольная сумма снимка нарушена.', 'digest-mismatch');
  return object(parse(bytes));
}

export async function collect(options: {
  root: string; matchId: number; side: Side; split?: Split; fromFile?: string;
  retrievedAt?: string; parentDigest?: string; originalMatchId?: number;
}, fetcher: typeof fetch = fetch): Promise<Entry> {
  check(positiveInt(options.matchId) && validSide(options.side), 'Нужны целый match ID и сторона.');
  check(options.retrievedAt === undefined || validDate(options.retrievedAt), 'Некорректное время получения.');
  check(options.split === undefined || options.split === 'development' || options.split === 'holdout', 'Некорректный раздел корпуса.');
  check(options.originalMatchId === undefined || positiveInt(options.originalMatchId), 'Некорректный исходный match ID.');
  check(!options.parentDigest || isDigest(options.parentDigest), 'Некорректный digest родителя.');
  check(!options.parentDigest || options.fromFile, 'Производная фикстура импортируется из файла.');
  let bytes: Buffer;
  let retrievedAt: string | null = options.retrievedAt ?? null;
  if (options.fromFile) bytes = await readFile(options.fromFile);
  else {
    // shortcut: исследовательский GET без повторов; заменить на getMatch(fresh), когда клиент появится.
    const response = await fetcher(`https://api.opendota.com/api/matches/${options.matchId}`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    check(response.ok, `OpenDota HTTP ${response.status}. Сбор остановлен.`, 'api-error');
    bytes = Buffer.from(await response.arrayBuffer());
    retrievedAt = now();
  }
  check(object(parse(bytes)).match_id === options.matchId, 'Импортирован другой матч.');
  let corpus: Corpus;
  try { corpus = validateCorpus(await readJson(join(options.root, 'corpus.json'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    corpus = { version: 1, revision: id(), entries: [] };
  }
  await revision(options.root, 'corpora', corpus);
  const entry: Entry = {
    matchId: options.matchId, side: options.side, split: options.split ?? 'development',
    digest: digest(bytes), snapshot: `snapshots/${options.matchId}/${digest(bytes)}.json`,
    retrievedAt, importedAt: now(), source: options.parentDigest ? 'derived-fixture' : options.fromFile ? 'import' : 'api',
    originalMatchId: options.originalMatchId ?? options.matchId, parentDigest: options.parentDigest ?? null, usedForTuning: false,
  };
  const next: Corpus = { version: 1, revision: id(), entries: [...corpus.entries.filter(item => entryKey(item) !== entryKey(entry)), entry] };
  validateCorpus(next);
  await immutable(within(options.root, entry.snapshot), bytes);
  await revision(options.root, 'corpora', next);
  await atomicWrite(join(options.root, 'corpus.json'), json(next), true);
  return entry;
}

export function validateLabels(input: unknown, corpus: Corpus, snapshots: Map<string, Raw>): Labels {
  const data = version(input);
  check(typeof data.revision === 'string' && validDate(data.createdAt) && (data.previousRevision === null || typeof data.previousRevision === 'string') && Array.isArray(data.entries), 'Некорректная ревизия эталонов.');
  const keys = new Set<string>();
  for (const item of data.entries) {
    const label = object(item);
    check(positiveInt(label.matchId) && validSide(label.side), 'Некорректный матч эталона.');
    const key = entryKey(label as unknown as Entry);
    const entry = corpus.entries.find(item => entryKey(item) === key);
    check(entry && label.snapshotDigest === entry.digest && !keys.has(key), 'Эталон ссылается на другой снимок или повторяется.');
    keys.add(key);
    check(['unlabeled', 'selection', 'insufficient-evidence'].includes(String(label.status)) && typeof label.modelOutputSeen === 'boolean', 'Некорректный статус эталона.');
    check(Array.isArray(label.acceptableSelections) && Array.isArray(label.reasons), 'Нет наборов или оснований эталона.');
    check(label.status === 'unlabeled' || label.reasons.length > 0, 'Оценке нужны фактические или субъективные основания.');
    const slots = slotsFor(entry.side);
    for (const selection of label.acceptableSelections) {
      check(Array.isArray(selection) && selection.length >= 1 && selection.length <= 2 && new Set(selection).size === selection.length && selection.every(slot => slots.includes(slot)), 'Эталон должен выбирать одного/двух уникальных союзников.');
    }
    check(label.status === 'selection' ? label.acceptableSelections.length > 0 : label.acceptableSelections.length === 0, 'Наборы не соответствуют статусу эталона.');
    for (const item of label.reasons) {
      const reason = object(item);
      check((reason.playerSlot === null || slots.includes(Number(reason.playerSlot))) && typeof reason.subjective === 'boolean' && typeof reason.comment === 'string' && Array.isArray(reason.paths), 'Некорректное основание эталона.');
      check(reason.subjective || reason.paths.length > 0, 'Наблюдению нужен путь к данным; впечатление пометьте subjective.');
      for (const path of reason.paths) { check(typeof path === 'string', 'Некорректный путь.'); pointer(snapshots.get(key), path); }
    }
  }
  return data as unknown as Labels;
}
