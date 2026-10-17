import { prepareMatchFacts } from '../src/match-facts/index.js';
import { loadPromptPackage, type FactsBundle, type MatchAnalysis, type PromptPackage, type Raw, type Side } from '../src/match-analysis/index.js';
import { dictionary, match } from './helpers.js';

export const prompt = await loadPromptPackage('analysis/prompts/v1');
export function bundle(side: Side = 'radiant', win = true, matchId = 101): FactsBundle {
  const data = match(matchId, win);
  (data.players as Raw[]).forEach((player, index) => { player.position_est = index % 5 + 1; player.net_worth = 5000; });
  data.teamfights = [{ start: 710, end: 740, last_death: 720, deaths: 5, players: Array.from({ length: 10 }, (_, index) => ({
    deaths: index < 5 ? 1 : 0, buybacks: 0, damage: 100 * index, healing: 0, gold_delta: index - 4,
  })) }];
  data.objectives = [{ time: 750, type: 'building_kill', key: 'npc_dota_badguys_tower1_mid', player_slot: 0 }];
  return prepareMatchFacts({ matchId, side, data }, { dictionary });
}
export function analysis(bundle: FactsBundle, slots = [bundle.context.allies[0].playerSlot]): MatchAnalysis {
  const claim = () => ({ claim: 'Синтетическое основание, не оценка реальной игры.', evidenceIds: [bundle.context.allies[0].metrics.id] });
  return {
    version: 1, format: 'match-analysis-v1', status: 'selected', confidence: 'low',
    playerAssessments: bundle.context.allies.map(player => ({
      playerSlot: player.playerSlot, position: 'id' in player.role.position ? player.role.position.value : null, positionSource: player.role.source,
      resources: claim(), contributions: [claim()], concerns: [claim()], counterargument: claim(), limitations: [],
    })),
    comparison: claim(), selectedPlayers: slots.map(playerSlot => ({ playerSlot, reasons: [claim(), claim()], roast: 'Синтетическая игровая шутка для теста.' })),
    closestAlternative: slots.length === 1 ? { playerSlot: bundle.context.allies.find(player => !slots.includes(player.playerSlot))!.playerSlot, reason: claim() } : null,
    limitations: ['Синтетическая фикстура.'],
  };
}
export function metadata(settings: PromptPackage = prompt) {
  return { data: { id: settings.profile.model, endpoints: settings.profile.provider.only.map(provider => ({
    name: provider, provider_name: provider, tag: `${provider}/fp8`, context_length: 10000000,
    max_prompt_tokens: 10000000, max_completion_tokens: 20000,
    supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'], pricing: { prompt: '0.000001', completion: '0.000002' },
  })) } };
}
export function payload(bundle: FactsBundle) {
  return { id: 'gen-synthetic', model: prompt.profile.model, provider: 'deepinfra',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(analysis(bundle)) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 },
  };
}
