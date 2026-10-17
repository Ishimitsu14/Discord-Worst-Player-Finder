import type { CompactFactsBundle } from '../match-facts/index.js';
import { presentGeminiAnalysis } from './gemini-analysis.js';

function text(value: string): string {
  return value.replace(/[\s]+/gu, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '')
    .replaceAll('@', '@\u200b').replace(/[\\`*_{}\[\]()<>~|]/g, '\\$&').trim();
}
export function renderGeminiAnalysis(input: unknown, bundle: CompactFactsBundle): string {
  const result = presentGeminiAnalysis(input, bundle);
  const lines = [`**${text(result.playerName)} — ${text(result.heroName ?? `слот ${result.playerSlot}`)}**`, '', `Номинация: **${text(result.nomination)}**`, '',
    ...result.facts.map(fact => `- ${text(fact.claim)}`), ''];
  if (result.quote) {
    const seconds = result.quote.time_sec, time = seconds === null ? 'время неизвестно' : `${seconds < 0 ? '-' : ''}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.abs(seconds) % 60).padStart(2, '0')}`;
    lines.push(`> ${text(result.quote.text)}${result.quote.truncated ? ' [сокращено]' : ''}`, '', `— ${text(result.playerName)}, ${time}`, '');
  }
  lines.push(text(result.verdict), '');
  if (result.limitations.length) lines.push(`Оговорки: ${result.limitations.map(text).join(' ')}`, '');
  const confidence = { low: 'низкая', medium: 'средняя', high: 'высокая' }[result.confidence];
  lines.push(`${result.won ? 'Победа' : 'Поражение'} ${result.side === 'radiant' ? 'Radiant' : 'Dire'} · Уверенность: ${confidence} · [Матч ${result.matchId}](https://www.opendota.com/matches/${result.matchId})`);
  if (result.teamFacts) lines.push('', `**${result.won ? 'Где накосячили, несмотря на победу' : 'Почему проебали'}**`, '', ...result.teamFacts.map((fact, index) => `${index + 1}. ${text(fact.claim)}`));
  return lines.join('\n') + '\n';
}
