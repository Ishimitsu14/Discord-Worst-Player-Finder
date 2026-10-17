import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect } from './corpus.js';
import { check, LabError } from './files.js';
import { prepare } from './prepare.js';
import { report } from './report.js';
import { run } from './run.js';
import { prepareFacts } from './facts.js';
import { FactsError } from '../match-facts/index.js';
import { AnalysisError } from '../match-analysis/index.js';
import { prepareGeminiExperiment, runGeminiExperiment } from './gemini.js';
import type { Side, Split } from './types.js';

export const help = `Лаборатория оценки (сначала npm run build)
  npm run lab -- collect --match-id ID --side radiant|dire [--from-file FILE] [--split development|holdout]
  npm run lab -- prepare --experiment FILE
  npm run lab -- run --plan DIRECTORY --budget-usd NUMBER [--max-requests 6] [--timeout-ms 180000]
  npm run lab -- report --plan DIRECTORY [--reviews FILE] [--run-id ID,ID]
  npm run lab -- facts --match-id ID --side radiant|dire [--roles FILE] [--brief-format match-brief-v1|match-brief-v2|gemini-compact-v1]
  npm run lab -- gemini-prepare --match-id ID --side radiant|dire [--roles FILE]
  npm run lab -- gemini-run --plan DIRECTORY --budget-usd NUMBER [--timeout-ms 180000] [--reserve-unknown-usd NUMBER]
Общие флаги: --root .local/evaluation, --help
collect: --retrieved-at ISO_DATE; для производных данных --parent-digest SHA256 [--original-match-id ID]
run: --reserve-unknown-usd NUMBER (на каждую неизвестную попытку), --reconciliation FILE
Только collect без --from-file, run и gemini-run обращаются к сети. run/gemini-run требуют OPENROUTER_API_KEY из окружения.
OPENROUTER_MANAGEMENT_KEY включает для gemini-run сверку сетевого обрыва и максимум один повтор.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, root: { type: 'string' }, 'match-id': { type: 'string' }, side: { type: 'string' }, roles: { type: 'string' }, 'brief-format': { type: 'string' },
    split: { type: 'string' }, 'from-file': { type: 'string' }, 'retrieved-at': { type: 'string' },
    'parent-digest': { type: 'string' }, 'original-match-id': { type: 'string' }, experiment: { type: 'string' }, plan: { type: 'string' },
    'budget-usd': { type: 'string' }, 'max-requests': { type: 'string' }, 'timeout-ms': { type: 'string' },
    'reserve-unknown-usd': { type: 'string' }, reconciliation: { type: 'string' }, reviews: { type: 'string' }, 'run-id': { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  check(positionals.length === 1, 'Ожидалась одна операция.');
  check(values['brief-format'] === undefined || positionals[0] === 'facts', '--brief-format доступен только для facts.');
  const required = (key: keyof typeof values): string => { check(typeof values[key] === 'string' && values[key].length > 0, `Не задан --${key}.`); return values[key] as string; };
  const root = resolve(values.root ?? '.local/evaluation');
  switch (positionals[0]) {
    case 'collect': {
      const entry = await collect({ root, matchId: Number(required('match-id')), side: required('side') as Side, split: values.split as Split | undefined,
        fromFile: values['from-file'], retrievedAt: values['retrieved-at'], parentDigest: values['parent-digest'],
        originalMatchId: values['original-match-id'] ? Number(values['original-match-id']) : undefined });
      console.log(`Сохранён ${entry.matchId}/${entry.side}, SHA-256 ${entry.digest}.`); break;
    }
    case 'prepare': {
      const result = await prepare(root, required('experiment'));
      console.log(`План: ${result.path}\nЗапросов: ${result.plan.requests.length}. Сеть не использовалась.`);
      for (const request of result.plan.requests) console.log(`${request.index}: ${request.matchId}/${request.side} ${request.variant}, ${request.bytes} UTF-8 bytes, оценка входа ~${request.estimatedInputTokens} токенов (${result.plan.tokenEstimation}).`);
      break;
    }
    case 'run': {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await run({ root, planPath: required('plan'), budgetUsd: Number(required('budget-usd')),
          maxRequests: values['max-requests'] ? Number(values['max-requests']) : undefined,
          timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
          reserveUnknownUsd: values['reserve-unknown-usd'] ? Number(values['reserve-unknown-usd']) : undefined,
          reconciliation: values.reconciliation, signal: controller.signal });
        console.log(`Запуск: ${result.path}\nОтправок: ${result.sent}. Остановка: ${result.stopReason}.`);
        if (result.stopReason !== 'completed') process.exitCode = 2;
      } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
      break;
    }
    case 'report': {
      const result = await report({ root, planPath: required('plan'), reviewsFile: values.reviews, runIds: values['run-id']?.split(',') });
      console.log(`Отчёт: ${result.path}\nСтадия: ${result.report.stage}.`); break;
    }
    case 'facts': {
      const format = values['brief-format'];
      check(format === undefined || format === 'match-brief-v1' || format === 'match-brief-v2' || format === 'gemini-compact-v1', 'Неизвестный формат отчёта.', 'invalid-input');
      const result = await prepareFacts({ root, matchId: Number(required('match-id')), side: required('side') as Side, rolesFile: values.roles, briefFormat: format });
      const sizes = result.diagnostics.sizes as Record<string, number>;
      const compact = format === 'gemini-compact-v1';
      console.log(`Факты: ${result.path}\nПакет: ${result.bundle.manifest.bundleId}\nФормат: ${result.bundle.context.format}\nОтчёт ИИ: ${sizes.brief} UTF-8 bytes; ${compact ? `ядро ${sizes.core}, ` : ''}цель ${compact ? 4096 : 32768}: ${result.diagnostics.targetMet ? 'достигнута' : 'не достигнута'}, предел ${compact ? 16384 : 65536} соблюдён.\nПолные факты: ${sizes.facts}; реестр: ${sizes.evidence}.\nВремя этапов (мс): ${JSON.stringify(result.diagnostics.timings)}\nСеть и ИИ не использовались.`);
      break;
    }
    case 'gemini-prepare': {
      const result = await prepareGeminiExperiment({ root, matchId: Number(required('match-id')), side: required('side') as Side, rolesFile: values.roles });
      console.log(`План Gemini: ${result.path}\nЗапрос: ${result.requestBytes} UTF-8 bytes. Сеть и ИИ не использовались.`); break;
    }
    case 'gemini-run': {
      check(values['max-requests'] === undefined, 'gemini-run выполняет одну попытку и максимум один повтор после management-сверки; --max-requests не используется.');
      const controller = new AbortController(), cancel = (): void => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const apiKey = process.env.OPENROUTER_API_KEY; check(typeof apiKey === 'string' && apiKey.trim().length > 0, 'Задайте OPENROUTER_API_KEY в окружении.', 'missing-key');
        const result = await runGeminiExperiment({ root, planPath: required('plan'), budgetUsd: Number(required('budget-usd')), timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
          reserveUnknownUsd: values['reserve-unknown-usd'] === undefined ? undefined : Number(values['reserve-unknown-usd']), signal: controller.signal }, { apiKey, managementKey: process.env.OPENROUTER_MANAGEMENT_KEY || undefined });
        console.log(`Попытка Gemini: ${result.path}\nСтатус: ${result.attempt.status}; POST: ${result.attempts.filter(row => row.attempt.requestSent).length}; расход итоговой попытки: ${result.attempt.usage.costUsd ?? 'unknown'}.`);
        if (result.recovery) console.log(`Сверка: ${result.recovery.status}; подтверждённый расход первой попытки: ${result.recovery.costUsd ?? 'unknown'}; резерв: ${result.recovery.reserveUsd}.`);
        if (result.attempt.status !== 'valid') process.exitCode = 2;
      } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
      break;
    }
    default: throw new LabError('invalid-command', 'Неизвестная операция. Используйте --help.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof FactsError || error instanceof AnalysisError ? `${error.code}: ${JSON.stringify(error.details)}` : error instanceof LabError ? `${error.code}: ${error.message}` : 'Операция не завершена: проверьте пути, JSON, доступ к файлам и сеть.');
    process.exitCode = 1;
  });
}
