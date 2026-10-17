import { appendFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openStorage, StorageError } from '../src/storage/index.js';
import { analyze, setup, started, invalidAttempt, settings } from './storage-helpers.js';

const [path, phase, kind = 'analysis'] = process.argv.slice(2);
const store = openStorage({ path, clock: { now: () => 1000 } });
function pause(value: unknown): never {
  writeSync(1, JSON.stringify(value) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); process.exit(2);
}
if (phase === 'race-claim' || phase === 'race-revision') {
  await new Promise<void>(resolve => { process.once('message', () => resolve()); process.send?.('ready'); });
  try {
    const value = phase === 'race-claim' ? store.claimNext()?.job.id ?? null
      : store.createRevision({ requestId: `request-${process.pid}`, matchId: 101, side: 'radiant', settings }).id;
    store.close(); writeSync(1, JSON.stringify({ value }) + '\n');
  } catch (error) { if (!(error instanceof StorageError)) throw error; store.close(); writeSync(1, JSON.stringify({ error: error.code }) + '\n'); }
} else {
  const current = setup(store); let claim = current.claim, attemptId: string;
  if (kind === 'publication') {
    const analysis = await analyze(store, claim); store.saveAnalysisOutcome(analysis.attemptId, analysis.attempt);
    claim = store.checkpoint(claim, { step: 'publish', resultAttemptId: analysis.attemptId }).claim;
  }
  if (phase === 'before-admission') {
    const original = DatabaseSync.prototype.exec; let commits = 0;
    DatabaseSync.prototype.exec = function(sql: string) {
      if (sql === 'COMMIT' && ++commits === (kind === 'analysis' ? 2 : 1)) pause({ jobId: current.job.id });
      return original.call(this, sql);
    };
  }
  if (kind === 'analysis') attemptId = started(store, claim).attemptId;
  else if (kind === 'parse') { attemptId = 'parse-crash'; store.beginParse(claim, { attemptId }); }
  else { attemptId = 'publication-crash'; store.beginPublication(claim, { attemptId, analysisAttemptId: store.getJob(current.job.id).resultAttemptId!, message: '{}' }); }
  if (phase === 'after-admission') pause({ jobId: current.job.id, attemptId });
  appendFileSync(path + '.sent', kind + '\n');
  if (phase === 'after-send') pause({ jobId: current.job.id, attemptId });
  if (phase === 'before-result-commit') {
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === 'COMMIT') pause({ jobId: current.job.id, attemptId }); return original.call(this, sql); };
  }
  if (kind === 'analysis') {
    const receipt = store.listAttempts(current.job.id).find(item => item.id === attemptId)!;
    if (receipt.started!.responseFormat !== 'match-analysis-v1') throw Error('unexpected profile');
    store.saveAnalysisOutcome(attemptId, invalidAttempt({ ...receipt.started!, responseFormat: 'match-analysis-v1' }));
  } else if (kind === 'parse') store.saveParseOutcome(attemptId, { jobId: '588786891' });
  else store.savePublicationOutcome(attemptId, { messageId: '18446744073709551615' });
  pause({ jobId: current.job.id, attemptId });
}
