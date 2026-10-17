import { readFile } from 'node:fs/promises';
import { dictionary, match } from './helpers.js';
import { prepareCompactMatchFacts } from '../src/match-facts/index.js';
import type { CompactFactsOptions, Raw, Side } from '../src/match-facts/index.js';
import { loadGeminiPromptPackage } from '../src/match-analysis/gemini-package.js';
import type { GeminiAnalysisV1, GeminiAnalysisV2 } from '../src/match-analysis/gemini-types.js';
import type { CompactFactsBundle } from '../src/match-facts/index.js';

export const compactOptions: CompactFactsOptions = { dictionary, heroMetricsDictionary: JSON.parse(await readFile('evaluation/dictionaries/hero-metrics-v1.json', 'utf8')) };
export function compactData(): Raw {
  const data = match(101, false);
  data.duration = 2400; data.radiant_score = 40; data.dire_score = 30;
  (data.players as Raw[]).forEach((player, index) => {
    player.position_est = index % 5 + 1; player.personaname = `Игрок ${index}`;
    player.net_worth = 15000 + index; player.denies = 10; player.last_hits = 200;
    player.obs_placed = 1; player.sen_placed = 2; player.observer_kills = 0; player.sentry_kills = 0;
    player.camps_stacked = 0; player.stuns = 20; player.hero_healing = 0; player.lane_role = 1;
    player.kills = 6; player.assists = 1;
    player.benchmarks = { gold_per_min: { raw: 350, pct: 0.45 }, hero_damage_per_min: { raw: 300, pct: 0.3 } };
  });
  const lc = (data.players as Raw[])[7]; lc.hero_id = 104; lc.permanent_buffs = [{ permanent_buff: 5, stack_count: 100 }];
  lc.purchase_log = [{ key: 'blink', time: 858 }, { key: 'black_king_bar', time: 1476 }, { key: 'swift_blink', time: 1800 }];
  data.chat = [{ type: 'chat', slot: 7, player_slot: 130, time: 1200, key: 'Сейчас покажу как надо' }, { type: 'chat', slot: 0, time: 1300, key: 'Обвинение соперника' }];
  return data;
}
export const compactInput = (data = compactData(), side: Side = 'dire') => ({ matchId: Number(data.match_id), side, data });
export const compactBundle = (data = compactData(), side: Side = 'dire') => prepareCompactMatchFacts(compactInput(data, side), compactOptions);
export const geminiPrompt = await loadGeminiPromptPackage('analysis/prompts/gemini-v1');
export const geminiPromptV2 = await loadGeminiPromptPackage('analysis/prompts/gemini-v2');
export function geminiAnswer(bundle: CompactFactsBundle, count = 3): GeminiAnalysisV1 {
  const player = bundle.context.players.find(player => player.core.value.hero_id === 104) ?? bundle.context.players[0];
  return { version: 1, format: 'gemini-match-analysis-v1', selectedPlayerSlot: player.core.value.player_slot, nomination: 'Синтетический чемпион',
    facts: Array.from({ length: count }, (_, i) => ({ claim: `Синтетическое основание ${i + 1}.`, evidenceIds: [player.core.id] })),
    quoteId: bundle.context.chat.find(row => row.value.player_slot === player.core.value.player_slot)?.id ?? null, verdict: 'Синтетический игровой панчлайн.', confidence: 'low', limitations: ['Синтетический ответ проверяет контракт, не качество модели.'] };
}
export function geminiAnswerV2(bundle: CompactFactsBundle): GeminiAnalysisV2 {
  return { ...geminiAnswer(bundle), version: 2, format: 'gemini-match-analysis-v2',
    teamFacts: bundle.context.players.slice(0, 3).map((player, index) => ({ claim: `Синтетический командный фактор ${index + 1}.`, evidenceIds: [player.core.id] })) };
}
export const geminiMetadata = () => ({ data: { id: 'google/gemini-3.8-flash', endpoints: [{ name: 'Google AI Studio', tag: 'google-ai-studio', provider_name: 'Google AI Studio',
  context_length: 1048576, max_completion_tokens: 65536, supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs', 'reasoning'],
  pricing: { prompt: '0.000001', completion: '0.000002' } }] } });
export function geminiEvents(bundle: CompactFactsBundle, settings: { answer?: unknown; finish?: string; done?: boolean; usage?: unknown; suffix?: string } = {}): string {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
  const content = typeof settings.answer === 'string' ? settings.answer : JSON.stringify(settings.answer ?? geminiAnswer(bundle));
  return ': keepalive\r\n\r\n' + event({ id: 'gen-synthetic', model: 'google/gemini-3.8-flash', provider: 'Google', choices: [{ index: 0, delta: { role: 'assistant', content: content.slice(0, 10) } }] })
    + event({ id: 'gen-synthetic', choices: [{ index: 0, delta: { content: content.slice(10) }, finish_reason: settings.finish ?? 'stop' }] })
    + event({ choices: [], usage: settings.usage === undefined ? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 } : settings.usage })
    + (settings.done === false ? '' : 'data: [DONE]\r\n\r\n') + (settings.suffix ?? '');
}
export function geminiStreamResponse(text: string, fragmentBytes?: number): Response {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } const end = Math.min(bytes.length, offset + (fragmentBytes ?? bytes.length)); controller.enqueue(bytes.slice(offset, end)); offset = end; } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
