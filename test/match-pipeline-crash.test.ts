import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, appendFile } from 'node:fs/promises';
import { fixture, live } from './match-pipeline-helpers.js';

async function crash(path: string, phase: string): Promise<{ jobId: string; now: number }> {
  const child = spawn(process.execPath, ['dist/test/match-pipeline-crash-worker.js', path, phase], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      let delivered = false; const timer = setTimeout(() => reject(new Error(`crash worker timed out: ${stderr}`)), 60000);
      lines.once('line', line => { delivered = true; clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (!delivered) reject(new Error(`crash worker exited ${code}: ${stderr}`)); });
    });
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; lines.close(); }
}
for (const phase of ['prepared', 'after-analysis', 'before-publication', 'publication-admitted', 'publication-sent', 'publication-saved']) {
  test(`pipeline crash ${phase}: journal survives SIGKILL and prevents duplicate external effects`, async t => {
    const fx = await fixture(t), report = await crash(fx.path, phase); fx.clock.time = report.now + 60001; fx.reopen();
    const saved = fx.storage.getJobArtifacts(report.jobId).prepared!.body;
    const pipeline = fx.pipe(live, { publisher: { prepare: () => '{}', send: async () => { await appendFile(fx.path + '.effects', 'publication\n'); return { messageId: '123456' }; } } });
    const result = await pipeline.processNext();
    if (phase === 'publication-admitted' || phase === 'publication-sent') {
      assert.equal(result.status, 'idle'); assert.equal(fx.storage.getJob(report.jobId).state, 'needs-attention');
    } else if (phase === 'prepared') {
      const processed = result.status === 'processed' ? result.job : assert.fail(); assert.equal(processed.state, 'succeeded'); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.posts('analysis')[0].body, saved);
      const receipts = fx.storage.listAttempts(report.jobId).filter(item => item.kind === 'analysis'); assert.equal(receipts.length, 2); assert.equal(receipts.filter(item => item.started).length, 1);
    } else { assert.equal(result.status, 'processed'); assert.equal(fx.storage.getJob(report.jobId).state, 'succeeded'); assert.equal(fx.posts('analysis').length, 0); }
    let effects = ''; try { effects = await readFile(fx.path + '.effects', 'utf8'); } catch {}
    assert.equal(effects.split('\n').filter(value => value === 'analysis').length + fx.posts('analysis').length, 1);
    const expectedMessages = phase === 'publication-admitted' ? 0 : 1;
    assert.equal(effects.split('\n').filter(value => value === 'publication').length, expectedMessages);
    assert.equal((await pipeline.processNext()).status, 'idle');
  });
}
