import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analysisClaims, validateAnalysis, validateProfile, variantsFor } from './context.js';
import { entryKey, slotsFor, validateCorpus, validateLabels } from './corpus.js';
import { atomicWrite, check, digest, id, isDigest, json, newDirectory, nonnegative, now, object, parse, readJson, revision, validDate, version, within } from './files.js';
import { loadPlan } from './prepare.js';
import { history } from './run.js';
import type { Analysis, Attempt, Context, Label, Raw, RequestEntry, Review, Reviews, Variant } from './types.js';

type Row = {
  runId: string; index: number; matchId: number; side: string; variant: Variant; repeat: number; split: string;
  status: string; error: string | null; provider: string | null; model: string | null;
  responseDigest: string | null; analysis: Analysis | null; labelKind: string;
  dataQuality: { source: string; parseState: string; limitations: string[] };
  exactMatch: boolean | null; partialOverlap: boolean | null;
  elapsedMs: number | null; usage: Attempt['usage']; review: Review | null;
};

function sameSelection(analysis: Analysis, label: Label): boolean {
  if (label.status === 'insufficient-evidence') return analysis.status === 'insufficient-evidence';
  const selected = analysis.selectedPlayers.map(player => player.playerSlot).sort((a, b) => a - b).join(',');
  return label.acceptableSelections.some(slots => [...slots].sort((a, b) => a - b).join(',') === selected);
}

export function validateReviews(input: unknown, attempts: Attempt[], labelsRevision: string, analyses: Map<string, Analysis>): Reviews {
  const data = version(input);
  check(typeof data.revision === 'string' && validDate(data.createdAt) && (data.previousRevision === null || typeof data.previousRevision === 'string') && Array.isArray(data.entries), 'Некорректная ревизия отзывов.');
  const seen = new Set<string>();
  for (const item of data.entries) {
    const review = object(item);
    const key = `${review.runId}/${review.index}`;
    const attempt = attempts.find(attempt => attempt.runId === review.runId && attempt.index === review.index);
    check(attempt && !seen.has(key) && isDigest(review.responseDigest) && review.responseDigest === attempt.responseDigest && review.labelsRevision === labelsRevision, 'Ревью повторяется или относится к другому ответу/эталону.');
    seen.add(key);
    check(['unreviewed', 'reviewed'].includes(String(review.status)) && ['agree', 'partly', 'disagree', 'cannot-assess'].includes(String(review.agreement)) && ['usable', 'needs-edit', 'unusable'].includes(String(review.roast)), 'Некорректные статусы ревью.');
    check(typeof review.roleError === 'boolean' && typeof review.causalityError === 'boolean' && typeof review.comment === 'string' && Array.isArray(review.claims), 'Неполное ревью.');
    const analysis = analyses.get(key);
    const expectedClaims = analysis ? analysisClaims(analysis) : [];
    const claims = new Set<string>();
    for (const item of review.claims) {
      const claim = object(item);
      check(Number.isSafeInteger(claim.playerSlot) && Number.isSafeInteger(claim.reasonIndex) && Number(claim.reasonIndex) >= 0 && ['supported', 'unsupported', 'uncertain'].includes(String(claim.verdict)), 'Некорректное ревью утверждения.');
      const claimKey = `${claim.playerSlot}/${claim.section ?? 'selected'}/${claim.reasonIndex}`;
      check(expectedClaims.some(({ address }) => address.playerSlot === claim.playerSlot && address.reasonIndex === claim.reasonIndex && (address.section ?? 'selected') === (claim.section ?? 'selected')) && !claims.has(claimKey), 'Ревью ссылается на отсутствующее/повторное утверждение.');
      claims.add(claimKey);
    }
    if (review.status === 'reviewed') check(analysis && claims.size === expectedClaims.length, 'Нужно проверить все основания ответа.');
  }
  if (data.recommendation !== null) {
    const recommendation = object(data.recommendation);
    check(['full-v1', 'compact-v1', 'full-v2', 'compact-v2'].includes(String(recommendation.variant)) && ['candidate', 'not-confirmed'].includes(String(recommendation.conclusion)), 'Некорректная рекомендация.');
    for (const key of ['matchFacts', 'matchAnalysis', 'limitations']) check(Array.isArray(recommendation[key]) && (recommendation[key] as unknown[]).every(item => typeof item === 'string' && item.trim().length > 0), 'Выводы должны быть списком непустых строк.');
    check((recommendation.matchFacts as unknown[]).length > 0 && (recommendation.matchAnalysis as unknown[]).length > 0, 'Нужны отдельные выводы для двух модулей.');
  }
  return data as unknown as Reviews;
}

const timing = (values: number[]) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { count: sorted.length, minMs: sorted[0], medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, maxMs: sorted.at(-1) };
};

function metrics(rows: Row[]) {
  const valid = rows.filter(row => row.status === 'valid');
  const labeled = rows.filter(row => row.labelKind !== 'unlabeled');
  const reviewed = valid.filter(row => row.review?.status === 'reviewed');
  const claims = reviewed.flatMap(row => row.review!.claims);
  const labelMetrics = (kind: string) => {
    const all = labeled.filter(row => row.labelKind === kind);
    return { sent: all.length, valid: all.filter(row => row.status === 'valid').length, exactMatches: all.filter(row => row.exactMatch === true).length, partialOverlaps: all.filter(row => row.partialOverlap === true).length };
  };
  const costs = rows.map(row => row.usage.costUsd).filter(nonnegative);
  const tokenTotals = (key: keyof Omit<Attempt['usage'], 'costUsd'>) => ({ knownSum: rows.reduce((sum, row) => sum + (row.usage[key] ?? 0), 0), knownAttempts: rows.filter(row => row.usage[key] !== null).length, totalAttempts: rows.length });
  return {
    uniqueMatches: new Set(rows.map(row => row.matchId)).size, sent: rows.length, valid: valid.length,
    statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
    unlabeled: rows.filter(row => row.labelKind === 'unlabeled').length,
    independentLabels: labelMetrics('independent'), afterOutputLabels: labelMetrics('after-output'),
    reviewed: reviewed.length, unreviewed: valid.length - reviewed.length,
    claims: Object.fromEntries(['supported', 'unsupported', 'uncertain'].map(verdict => [verdict, claims.filter(claim => claim.verdict === verdict).length])),
    roleErrors: reviewed.filter(row => row.review!.roleError).length, causalityErrors: reviewed.filter(row => row.review!.causalityError).length,
    roast: Object.fromEntries(['usable', 'needs-edit', 'unusable'].map(value => [value, reviewed.filter(row => row.review!.roast === value).length])),
    timing: { successful: timing(valid.map(row => row.elapsedMs).filter(nonnegative)), failed: timing(rows.filter(row => row.status !== 'valid').map(row => row.elapsedMs).filter(nonnegative)) },
    tokens: { prompt: tokenTotals('promptTokens'), completion: tokenTotals('completionTokens'), total: tokenTotals('totalTokens'), reasoning: tokenTotals('reasoningTokens'), cached: tokenTotals('cachedTokens') },
    cost: { knownSubtotalUsd: costs.reduce((sum, value) => sum + value, 0), knownAttempts: costs.length, unknownAttempts: rows.length - costs.length, totalUsd: costs.length === rows.length ? costs.reduce((sum, value) => sum + value, 0) : null },
  };
}

export async function report(options: { root: string; planPath: string; reviewsFile?: string; runIds?: string[] }): Promise<{ path: string; report: Record<string, unknown> }> {
  const plan = await loadPlan(options.planPath);
  const corpus = validateCorpus(await readJson(join(options.planPath, 'corpus.json')));
  const snapshots = new Map<string, Raw>();
  for (const entry of corpus.entries) {
    if (plan.artifacts[`snapshots/${entry.digest}.json`]) snapshots.set(entryKey(entry), object(await readJson(join(options.planPath, `snapshots/${entry.digest}.json`))));
  }
  const labels = validateLabels(await readJson(join(options.planPath, 'labels.json')), corpus, snapshots);
  const schema = object(await readJson(join(options.planPath, 'package/response.schema.json')));
  const variants = variantsFor(validateProfile(await readJson(join(options.planPath, 'package/profile.json'))));
  const attempts = (await history(options.root)).filter(attempt => attempt.planId === plan.planId && (!options.runIds || options.runIds.includes(attempt.runId)));
  const analyses = new Map<string, Analysis>();
  const contexts = new Map<number, Context>();
  const requestFor = (attempt: Attempt): RequestEntry => {
    const request = plan.requests.find(request => request.index === attempt.index);
    check(request && attempt.requestDigest === request.requestDigest, 'Попытка относится к другому запросу.');
    return request;
  };
  for (const attempt of attempts) {
    const request = requestFor(attempt);
    const context = await readJson(within(options.planPath, request.context)) as Context;
    contexts.set(request.index, context);
    check(attempt.content === null ? attempt.responseDigest === null : digest(attempt.content) === attempt.responseDigest, 'Нарушен digest ответа.');
    if (attempt.status === 'valid') {
      analyses.set(`${attempt.runId}/${attempt.index}`, validateAnalysis(parse(attempt.content!), context, schema));
    }
  }
  let reviews: Reviews = { version: 1, revision: id(), previousRevision: null, createdAt: now(), entries: [], recommendation: null };
  if (options.reviewsFile) {
    const bytes = await readFile(options.reviewsFile, 'utf8');
    reviews = validateReviews(parse(bytes), attempts, labels.revision, analyses);
    check(reviews.recommendation === null || variants.includes(reviews.recommendation.variant), 'Рекомендация относится к другой версии эксперимента.');
    if (reviews.previousRevision !== null) {
      check(reviews.previousRevision !== reviews.revision, 'Ревизия отзыва не может ссылаться на себя.');
      await readFile(within(options.root, `reviews/${reviews.previousRevision}.json`));
    }
    await revision(options.root, 'reviews', reviews, bytes);
  }
  const rows: Row[] = attempts.map(attempt => {
    const request = requestFor(attempt);
    const context = contexts.get(request.index)!;
    const entry = corpus.entries.find(entry => entry.matchId === request.matchId && entry.side === request.side)!;
    const label = labels.entries.find(label => label.matchId === request.matchId && label.side === request.side);
    const analysis = analyses.get(`${attempt.runId}/${attempt.index}`) ?? null;
    const exactMatch = analysis && label && label.status !== 'unlabeled' ? sameSelection(analysis, label) : null;
    const partialOverlap = exactMatch === false && analysis && label?.status === 'selection' ? label.acceptableSelections.some(slots => analysis.selectedPlayers.some(player => slots.includes(player.playerSlot))) : null;
    return {
      runId: attempt.runId, index: request.index, matchId: request.matchId, side: request.side, variant: request.variant, repeat: request.repeat, split: request.split,
      status: attempt.status === 'started' ? 'interrupted' : attempt.status, error: attempt.error, provider: attempt.provider, model: attempt.model,
      responseDigest: attempt.responseDigest, analysis, labelKind: !label || label.status === 'unlabeled' ? 'unlabeled' : label.modelOutputSeen ? 'after-output' : 'independent',
      dataQuality: { source: entry.source, parseState: context.parseState, limitations: context.limitations },
      exactMatch, partialOverlap, elapsedMs: attempt.elapsedMs, usage: attempt.usage,
      review: reviews.entries.find(review => review.runId === attempt.runId && review.index === attempt.index) ?? null,
    };
  });
  const pairKeys = new Set(rows.map(row => `${row.runId}/${row.matchId}/${row.side}/${row.repeat}`));
  const pairs = [...pairKeys].map(key => {
    const pair = rows.filter(row => `${row.runId}/${row.matchId}/${row.side}/${row.repeat}` === key);
    const full = pair.find(row => row.variant === variants[0]);
    const compact = pair.find(row => row.variant === variants[1]);
    const complete = full?.status === 'valid' && compact?.status === 'valid';
    return { key, complete, isolatedContextEffect: complete && full.provider !== null && full.provider === compact.provider && full.model === compact.model,
      fullExactMatch: full?.exactMatch ?? null, compactExactMatch: compact?.exactMatch ?? null,
      reason: !complete ? 'incomplete-pair' : full.provider === null || compact.provider === null ? 'unknown-provider' : full.provider !== compact.provider ? 'different-providers' : null };
  });
  const stabilityKeys = new Set(rows.map(row => `${row.matchId}/${row.side}/${row.variant}/${row.provider ?? 'unknown'}`));
  const stability = [...stabilityKeys].map(key => {
    const group = rows.filter(row => `${row.matchId}/${row.side}/${row.variant}/${row.provider ?? 'unknown'}` === key);
    const valid = group.filter(row => row.status === 'valid');
    const values = valid.map(row => row.analysis!.status === 'insufficient-evidence' ? 'insufficient-evidence' : row.analysis!.selectedPlayers.map(player => player.playerSlot).toSorted((a, b) => a - b).join(','));
    return { key, sent: group.length, valid: valid.length, modalMatches: valid.length < 2 ? null : Math.max(...values.map(value => values.filter(item => item === value).length)), measured: valid.length >= 2, providerKnown: group[0].provider !== null };
  });
  const selected = rows.filter(row => row.variant === reviews.recommendation?.variant);
  const holdout = selected.filter(row => row.split === 'holdout');
  const unresolved = (row: Row): boolean => row.review?.status !== 'reviewed' || row.review.roleError || row.review.causalityError || row.review.agreement !== 'agree' || row.review.roast !== 'usable' || row.review.claims.some(claim => claim.verdict !== 'supported');
  const realMatchCount = new Set(corpus.entries.filter(entry => entry.source !== 'derived-fixture' && rows.some(row => row.matchId === entry.matchId)).map(entry => entry.originalMatchId)).size;
  const allHoldoutRequestsReviewed = plan.requests.filter(request => request.variant === reviews.recommendation?.variant && request.split === 'holdout').every(request => rows.some(row => row.index === request.index && row.status === 'valid' && !unresolved(row)));
  const candidate = reviews.recommendation?.conclusion === 'candidate' && realMatchCount >= 10 && new Set(holdout.map(row => row.matchId)).size >= 3 && plan.holdoutUntouched && allHoldoutRequestsReviewed && holdout.every(row => row.status === 'valid' && row.labelKind === 'independent' && !unresolved(row)) && corpus.entries.filter(entry => entry.split === 'holdout').every(entry => !entry.usedForTuning && entry.source !== 'derived-fixture');
  const reviewedDevelopment = new Set(rows.filter(row => row.split === 'development' && row.status === 'valid' && row.review?.status === 'reviewed' && row.labelKind !== 'unlabeled').map(row => row.matchId));
  const hypotheses = [...reviewedDevelopment].filter(matchId => variants.every(variant => rows.some(row => row.matchId === matchId && row.variant === variant && row.status === 'valid' && row.review?.status === 'reviewed'))).length >= 3;
  const stage = candidate ? 'candidate' : hypotheses ? 'hypotheses' : 'tool-ready';
  const result = {
    version: 1, createdAt: now(), planId: plan.planId, planDigest: digest(await readFile(join(options.planPath, 'plan.json'))),
    packageDigest: plan.packageDigest, corpusRevision: corpus.revision, labelsRevision: labels.revision, reviewsRevision: reviews.revision,
    plannedRequests: plan.requests.length, neverSentIndices: plan.requests.filter(request => !rows.some(row => row.index === request.index)).map(request => request.index), realMatchCount,
    stage, recommendation: candidate ? reviews.recommendation : reviews.recommendation?.conclusion === 'not-confirmed' && hypotheses ? reviews.recommendation : null,
    nextExperiment: candidate ? 'Проверить перенос контракта отдельными спеками.' : !hypotheses ? 'Получить разметку и ручное ревью трёх development матчей и первые пары full/compact.' : 'Расширить корпус до 10–15 матчей, зафиксировать пакет и проверить минимум три независимых holdout матча; устранить бездоказательные обвинения.',
    overall: metrics(rows), variants: Object.fromEntries(variants.map(variant => [variant, metrics(rows.filter(row => row.variant === variant))])),
    splits: Object.fromEntries(['development', 'holdout'].map(split => [split, metrics(rows.filter(row => row.split === split))])),
    pairs, stability, rows,
    transfer: {
      matchFacts: reviews.recommendation?.matchFacts ?? [], matchAnalysis: reviews.recommendation?.matchAnalysis ?? [], limitations: reviews.recommendation?.limitations ?? [],
      note: 'Рекомендация пользователя привязана к этому пакету. Смысл фактов и русский язык проверяются вручную; количество матчей не доказывает качество.',
    },
    inputDigests: Object.fromEntries(attempts.map(attempt => [`${attempt.runId}/${attempt.index}`, digest(json(attempt))])),
  };
  const directory = await newDirectory(options.root, 'reports');
  await atomicWrite(join(directory.path, 'report.json'), json(result));
  await atomicWrite(join(directory.path, 'reviews.json'), json(reviews));
  const reviewTemplate: Reviews = {
    version: 1, revision: id(), previousRevision: options.reviewsFile ? reviews.revision : null, createdAt: now(), recommendation: null,
    entries: rows.filter(row => row.analysis && row.responseDigest).map(row => ({
      runId: row.runId, index: row.index, responseDigest: row.responseDigest!, labelsRevision: labels.revision,
      status: 'unreviewed', agreement: 'cannot-assess', roleError: false, causalityError: false, roast: 'unusable', comment: '',
      claims: analysisClaims(row.analysis!).map(({ address }) => ({ ...address, verdict: 'uncertain' })),
    })),
  };
  await atomicWrite(join(directory.path, 'reviews-template.json'), json(reviewTemplate));
  const m = result.overall;
  const lines = [
    '# Отчёт лаборатории', '', `Стадия: ${stage}. План: ${plan.planId}.`, '',
    `Уникальных матчей: ${m.uniqueMatches}. Отправок: ${m.sent}. Валидных: ${m.valid}/${m.sent}. Просмотрено вручную: ${m.reviewed}/${m.valid}.`,
    `Независимый эталон: точных совпадений ${m.independentLabels.exactMatches}/${m.independentLabels.valid} валидных и ${m.independentLabels.exactMatches}/${m.independentLabels.sent} всех отправок с таким эталоном.`,
    `Эталон после просмотра: ${m.afterOutputLabels.exactMatches}/${m.afterOutputLabels.valid} валидных. Без эталона: ${m.unlabeled}.`,
    `Известные расходы: $${m.cost.knownSubtotalUsd}. Неизвестных попыток: ${m.cost.unknownAttempts}. Полный расход: ${m.cost.totalUsd === null ? 'неизвестен' : '$' + m.cost.totalUsd}.`, '',
    '| Вариант | Матчи | Валидные / отправки | Просмотрено | Известные USD |', '|---|---:|---:|---:|---:|',
    ...Object.entries(result.variants).map(([variant, metric]) => `| ${variant} | ${metric.uniqueMatches} | ${metric.valid}/${metric.sent} | ${metric.reviewed} | ${metric.cost.knownSubtotalUsd} |`), '',
    `Пар с двумя валидными ответами: ${pairs.filter(pair => pair.complete).length}/${pairs.length}; без различия известного провайдера: ${pairs.filter(pair => pair.isolatedContextEffect).length}.`,
    'Стабильность не измеряется по одному ответу. Детальные знаменатели, токены, время, ревью и попытки — в report.json.', '',
    `Рекомендация: ${result.recommendation ? result.recommendation.conclusion : 'нет'}.`, result.nextExperiment, '',
    '## Для match-facts', '', ...(result.transfer.matchFacts.length ? result.transfer.matchFacts.map(value => `- ${value}`) : ['Реальные выводы ещё не получены.']), '',
    '## Для match-analysis', '', ...(result.transfer.matchAnalysis.length ? result.transfer.matchAnalysis.map(value => `- ${value}`) : ['Реальные выводы ещё не получены.']), '',
    '## Ограничения', '', ...result.transfer.limitations.map(value => `- ${value}`), result.transfer.note, '',
  ];
  await atomicWrite(join(directory.path, 'report.md'), lines.join('\n'));
  return { path: directory.path, report: result };
}
