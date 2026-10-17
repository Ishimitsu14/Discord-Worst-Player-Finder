import { randomUUID } from 'node:crypto';
import { analyzeMatch, type AnalyzeDependencies } from '../src/match-analysis/index.js';
import type { Claim, Storage } from '../src/storage/index.js';

export async function analyzeStored(storage: Storage, claim: Claim, maxEstimatedCostUsd: number, dependencies: Omit<AnalyzeDependencies, 'beforeSend'>) {
  const { prepared, bundle } = storage.getJobArtifacts(claim.jobId), job = storage.getJob(claim.jobId);
  if (!prepared || !bundle || !job.refs.prepared) throw Error('Prepare inputs first');
  const attemptId = randomUUID(), reservation = storage.reserveAnalysis(claim, { attemptId, preparedRef: job.refs.prepared });
  const attempt = await analyzeMatch(prepared, bundle, { attemptId, maxEstimatedCostUsd }, {
    ...dependencies, beforeSend: async started => storage.startAnalysis(claim, reservation.id, started),
  });
  storage.saveAnalysisOutcome(reservation.id, attempt);
  const current = attempt.status === 'valid' ? storage.checkpoint(claim, { step: 'publish', resultAttemptId: reservation.id }) : null;
  return { attempt, claim: current?.claim ?? claim };
}
