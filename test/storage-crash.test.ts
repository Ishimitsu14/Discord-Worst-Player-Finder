import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fixture, jobInput, errorIs } from './storage-helpers.js';

async function worker(path: string, phase: string, kind = 'analysis') {
  const child = spawn(process.execPath, ['dist/test/storage-worker.js', path, phase, kind], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  const lines = createInterface({ input: child.stdout });
  try {
    const result = await new Promise<Record<string, string | null>>((resolve, reject) => {
      let delivered = false;
      const timer = setTimeout(() => reject(Error('worker timed out: ' + stderr)), 15000);
      lines.once('line', line => { delivered = true; clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (!delivered) reject(Error(`worker exited (${code}): ` + stderr)); });
    });
    return result;
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; lines.close(); }
}

for (const kind of ['analysis', 'parse', 'publication']) {
  for (const phase of ['before-admission', 'after-admission', 'after-send', 'before-result-commit', 'after-result']) {
    test(`storage: kill процесса ${kind} / ${phase}`, async t => {
      const f = await fixture(t), report = await worker(f.path, phase, kind); f.advance(); const store = f.open();
      const interrupted = phase !== 'before-admission' && phase !== 'after-result';
      assert.deepEqual(store.recoverInterrupted(), { resumed: interrupted ? 0 : 1, attention: interrupted ? 1 : 0 });
      const job = store.getJob(report.jobId!); assert.equal(job.state, interrupted ? 'needs-attention' : 'waiting');
      const countBefore = phase === 'before-admission' || phase === 'after-admission' ? 0 : 1;
      let sent: string;
      try { sent = await readFile(f.path + '.sent', 'utf8'); } catch { sent = ''; }
      assert.equal(sent.split('\n').filter(Boolean).length, countBefore);
      assert.deepEqual(store.recoverInterrupted(), { resumed: 0, attention: 0 });
      if (interrupted) assert.equal(store.claimNext(), null);
      const attempts = store.listAttempts(job.id), receipt = attempts.find(item => item.kind === kind);
      if (kind === 'analysis') {
        assert.equal(store.getBillingSummary().unknownCount, interrupted ? 1 : 0);
        assert.equal(store.getBillingSummary().knownCostUsd, phase === 'after-result' ? 0.01 : 0);
      }
      if (phase === 'before-admission') assert.ok(!receipt?.started);
      else if (phase === 'after-result') {
        assert.equal(receipt!.state, 'finished'); assert.equal(receipt!.unresolved, false);
        const next = store.claimNext()!;
        if (kind === 'parse') assert.throws(() => store.beginParse(next.claim, { attemptId: 'new-parse' }), errorIs('conflict'));
        if (kind === 'publication') assert.throws(() => store.beginPublication(next.claim, { attemptId: 'new-publication', analysisAttemptId: job.resultAttemptId!, message: '{}' }), errorIs('conflict'));
      } else assert.equal(receipt!.state, 'interrupted');
      let sentAfter: string; try { sentAfter = await readFile(f.path + '.sent', 'utf8'); } catch { sentAfter = ''; } assert.equal(sentAfter, sent);
    });
  }
}

test('storage: два процесса получают одну задачу без двух владельцев', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(jobInput());
  const results = await Promise.all([worker(f.path, 'race-claim'), worker(f.path, 'race-claim')]);
  assert.equal(results.filter(item => item.value === job.id).length, 1); assert.equal(results.filter(item => item.value === null).length, 1);
});

test('storage: два процесса создают только одну следующую ревизию', async t => {
  const f = await fixture(t), store = f.open(); store.enqueueInitial(jobInput()); store.finish(store.claimNext()!.claim, { state: 'failed', reason: 'test' });
  const results = await Promise.all([worker(f.path, 'race-revision'), worker(f.path, 'race-revision')]);
  assert.equal(results.filter(item => item.value).length, 1); assert.equal(results.filter(item => item.error === 'conflict').length, 1);
  assert.equal(store.getLatestJob(101, 'radiant')!.revision, 2);
});
