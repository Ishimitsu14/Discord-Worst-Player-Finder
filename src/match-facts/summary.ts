import type { Brief, Group, Observation } from './types.js';

const cell = (value: unknown): string => {
  if (value !== null && typeof value === 'object') {
    if ('unavailable' in value) return `недоступно (${String(value.unavailable)}${'reason' in value ? ': ' + String(value.reason) : ''})`;
    return JSON.stringify(value);
  }
  return typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 1000) / 1000) : String(value);
};
const observation = (value: Observation<unknown>): string => 'id' in value ? `${cell(value.value)} [${value.id}]` : cell(value);
const group = (value: Group): string => Object.entries(value.value).map(([field, value]) => `${field}: ${cell(value)}`).join('; ') + ` [${value.id}]`;

export function renderMatchBrief(context: Brief): string {
  const lines = [
    `# Матч ${context.matchId} — ${context.side}`, '',
    `Формат: ${context.format}. Это шаблонное представление входа ИИ; полные локальные подробности сюда не добавлены. Числа округлены только для отображения.`, '',
    ...Object.entries(context.match).map(([field, value]) => `- ${field}: ${observation(value)}`), '',
    '## Союзники', '',
    '| Слот | Герой | Позиция / источник | Ресурсы и вклад |', '|---|---|---|---|',
    ...context.allies.map(player => `| ${player.playerSlot} | ${player.heroName ?? `hero ${player.heroId}`} [${player.hero.id}] | ${observation(player.role.position)} / ${player.role.source} | ${group(player.metrics)} |`), '',
    '## Соперники', '',
    ...context.opponents.map(player => `- slot ${player.playerSlot}, ${player.heroName ?? `hero ${player.heroId}`} [${player.hero.id}], позиция ${observation(player.role.position)} (${player.role.source}): ${group(player.metrics)}`), '',
    '## Экономика обеих команд', '',
  ];
  for (const player of [...context.allies, ...context.opponents]) {
    lines.push(`### Слот ${player.playerSlot}`, '');
    for (const [minute, values] of Object.entries(player.economy)) lines.push(`- ${minute} мин: ${group(values)}`);
    if (player.comparisons) {
      lines.push(`- Разница с позицией соперника: ${player.comparisons.opponentSlot ?? player.comparisons.reason}. Знак: союзник минус соперник.`);
      for (const [minute, values] of Object.entries(player.comparisons.values)) lines.push(`- Разница на ${minute} мин: ${group(values)}`);
    }
    if (player.items) lines.push('- Финальные слоты: ' + Object.entries(player.items).map(([field, value]) => `${field}=${observation(value)}`).join('; '));
    for (const item of player.itemTypes ?? []) lines.push(`- ${item.name ?? `item ${item.itemId}`}: первая известная покупка типа ${observation(item.firstPurchase)}, применения ${observation(item.uses)}.`);
    if (player.abilities) lines.push('- Плоские применения способностей: ' + JSON.stringify(player.abilities));
    for (const phase of player.phases ?? []) lines.push(`- Фаза ${phase.from}–${phase.to} с (${phase.reached ? 'достигнута' : 'не достигнута'}): ${group(phase.counts)}; убийцы ${JSON.stringify(phase.killers)}; неизвестные причины ${phase.unknownKillers}.`);
    if (player.connection) lines.push('- Подключения: ' + Object.entries(player.connection).map(([field, value]) => `${field}: ${observation(value)}`).join('; '));
    lines.push('- Coverage: ' + JSON.stringify(player.coverage), '');
  }
  lines.push('## Все карточки драк', '');
  for (const fight of context.fights) {
    lines.push(`### Драка ${fight.index}`, '', ...Object.entries(fight.header).map(([field, value]) => `- ${field}: ${observation(value)}`), `- Сумма смертей участников: ${observation(fight.participantDeaths)}; quality: ${JSON.stringify(fight.quality)}`);
    for (const [metric, values] of Object.entries(fight.metrics)) lines.push(`- ${metric} по слотам: ${group(values)}`);
    lines.push('- Известное пересечение окон смерти: ' + Object.entries(fight.deadOverlap).map(([slot, value]) => `slot ${slot}: ${observation(value.seconds)}, lower-bound=${value.lowerBound}`).join('; '), '');
  }
  lines.push('## Объекты и выкупы', '', ...context.objectives.map(event => `- Объект ${event.index}: ${Object.entries(event.fields).map(([field, value]) => `${field}: ${observation(value)}`).join('; ')}; actor: ${observation(event.actor)}`), ...context.buybacks.map(event => `- Buyback slot ${event.playerSlot}: ${observation(event.time)}`), '', '## Покрытие и ограничения', '',
    '- Покрытие: ' + JSON.stringify(context.coverage), '- Представление групп: ' + JSON.stringify(context.representations), '- Quality: ' + JSON.stringify(context.quality),
    ...context.limitations.map(text => '- ' + text), '', '## Каталог единиц', '', ...Object.entries(context.catalog).map(([field, value]) => `- ${field}: ${value.unit}; ${value.meaning}`), '');
  return lines.join('\n');
}
