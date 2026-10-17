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
import type { Side, Split } from './types.js';

export const help = `Лаборатория оценки (сначала npm run build)
  npm run lab -- collect --match-id ID --side radiant|dire [--from-file FILE] [--split development|holdout]
  npm run lab -- prepare --experiment FILE
  npm run lab -- run --plan DIRECTORY --budget-usd NUMBER [--max-requests 6] [--timeout-ms 180000]
  npm run lab -- report --plan DIRECTORY [--reviews FILE] [--run-id ID,ID]
  npm run lab -- facts --match-id ID --side radiant|dire [--roles FILE]
Общие флаги: --root .local/evaluation, --help
collect: --retrieved-at ISO_DATE; для производных данных --parent-digest SHA256 [--original-match-id ID]
run: --reserve-unknown-usd NUMBER (на каждую неизвестную попытку), --reconciliation FILE
Только collect без --from-file и run обращаются к сети. run требует OPENROUTER_API_KEY из окружения.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, root: { type: 'string' }, 'match-id': { type: 'string' }, side: { type: 'string' }, roles: { type: 'string' },
    split: { type: 'string' }, 'from-file': { type: 'string' }, 'retrieved-at': { type: 'string' },
    'parent-digest': { type: 'string' }, 'original-match-id': { type: 'string' }, experiment: { type: 'string' }, plan: { type: 'string' },
    'budget-usd': { type: 'string' }, 'max-requests': { type: 'string' }, 'timeout-ms': { type: 'string' },
    'reserve-unknown-usd': { type: 'string' }, reconciliation: { type: 'string' }, reviews: { type: 'string' }, 'run-id': { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  check(positionals.length === 1, 'Ожидалась одна операция.');
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
      const result = await prepareFacts({ root, matchId: Number(required('match-id')), side: required('side') as Side, rolesFile: values.roles });
      const sizes = result.diagnostics.sizes as Record<string, number>;
      console.log(`Факты: ${result.path}\nПакет: ${result.bundle.manifest.bundleId}\nОтчёт ИИ: ${sizes.brief} UTF-8 bytes; цель 32768: ${result.diagnostics.targetMet ? 'достигнута' : 'не достигнута'}, предел 65536 соблюдён.\nПолные факты: ${sizes.facts}; реестр: ${sizes.evidence}.\nВремя этапов (мс): ${JSON.stringify(result.diagnostics.timings)}\nСеть и ИИ не использовались.`);
      break;
    }
    default: throw new LabError('invalid-command', 'Неизвестная операция. Используйте --help.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof FactsError ? `${error.code}: ${JSON.stringify(error.details)}` : error instanceof LabError ? `${error.code}: ${error.message}` : 'Операция не завершена: проверьте пути, JSON, доступ к файлам и сеть.');
    process.exitCode = 1;
  });
}
