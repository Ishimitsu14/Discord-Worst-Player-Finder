import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, data, live } from './match-pipeline-helpers.js';

test('parse retries once after two minutes, journals before POST and uses the second job ID after reopen', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); let pipeline = fx.pipe(live);
  const job = await fx.request(pipeline);
  fx.hooks.opendota = (url, init) => {
    if (init.method === 'POST') {
      const posts = fx.posts('parse').length, receipts = fx.storage.listAttempts(job.id);
      assert.equal(receipts.length, posts); assert.equal(receipts.at(-1)!.state, 'started');
      return Response.json({ job: { jobId: 12344 + posts } });
    }
    return url.pathname.includes('/request/') ? Response.json({ jobId: Number(url.pathname.split('/').at(-1)) }) : undefined;
  };
  await fx.process(pipeline); const first = fx.storage.listAttempts(job.id)[0];
  await pipeline.stop(); fx.reopen(); pipeline = fx.pipe(live);
  await fx.clock.tick(first.createdAt + 118000 - fx.clock.now()); await fx.process(pipeline); assert.equal(fx.posts('parse').length, 1);
  await fx.clock.tick(first.createdAt + 120000 - fx.clock.now()); await fx.process(pipeline);
  const retry = fx.storage.listAttempts(job.id)[1];
  assert.equal(fx.posts('parse').length, 2); assert.ok(retry.createdAt - first.createdAt >= 120000);
  assert.deepEqual(retry.input, { version: 1, matchId: 101, retryOf: { attemptId: first.id, createdAt: first.createdAt } });
  await pipeline.stop(); fx.reopen(); pipeline = fx.pipe(live); await fx.clock.tick(120000); await fx.process(pipeline);
  assert.equal(fx.posts('parse').length, 2); assert.ok(fx.calls.some(call => call.url === '/api/request/12346'));
  fx.matches.set(101, data()); await fx.clock.tick(15000); const ready = await fx.process(pipeline);
  assert.equal(ready.reason, 'publisher-unavailable'); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.posts('parse').length, 2);
});

test('fresh parsed data at the retry boundary continues without another parse POST', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live), job = await fx.request(pipeline);
  await fx.process(pipeline); const first = fx.storage.listAttempts(job.id)[0];
  fx.matches.set(101, data()); await fx.clock.tick(first.createdAt + 120000 - fx.clock.now()); await fx.process(pipeline);
  assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 1);
});

test('opposite sides share the retry and its original overall deadline across restart', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); let pipeline = fx.pipe(live);
  const radiant = await fx.request(pipeline); await fx.process(pipeline); const first = fx.storage.listAttempts(radiant.id)[0];
  const dire = await fx.request(pipeline, 101, 'dire'); await fx.process(pipeline);
  await fx.clock.tick(first.createdAt + 120000 - fx.clock.now()); await fx.process(pipeline); await fx.process(pipeline);
  assert.equal(fx.posts('parse').length, 2);
  assert.equal([...fx.storage.listAttempts(radiant.id), ...fx.storage.listAttempts(dire.id)].filter(item => item.kind === 'parse').length, 2);
  await pipeline.stop(); fx.reopen(); pipeline = fx.pipe(live); await fx.clock.tick(first.createdAt + 900001 - fx.clock.now());
  assert.equal((await fx.process(pipeline)).reason, 'parse-timeout'); assert.equal((await fx.process(pipeline)).reason, 'parse-timeout');
  assert.equal(fx.posts('parse').length, 2); assert.equal(fx.posts('analysis').length, 0);
});

test('prepare-only never sends the retry for a previously accepted parse', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const livePipeline = fx.pipe(live), job = await fx.request(livePipeline);
  await fx.process(livePipeline); const first = fx.storage.listAttempts(job.id)[0]; await livePipeline.stop();
  fx.reopen(); const pipeline = fx.pipe(); await fx.clock.tick(first.createdAt + 120000 - fx.clock.now());
  assert.equal((await fx.process(pipeline)).reason, 'parse-pending'); assert.equal(fx.posts('parse').length, 1);
});

test('unknown second POST blocks further retries, including the opposite side after restart', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); let pipeline = fx.pipe(live), job = await fx.request(pipeline);
  await fx.process(pipeline); const first = fx.storage.listAttempts(job.id)[0];
  fx.hooks.opendota = (_url, init) => { if (init.method === 'POST') throw Error('synthetic lost response'); return undefined; };
  await fx.clock.tick(first.createdAt + 120000 - fx.clock.now()); const unknown = await fx.process(pipeline);
  assert.equal(unknown.state, 'needs-attention'); assert.equal(fx.storage.listAttempts(job.id)[1].unresolved, true);
  await pipeline.stop(); fx.reopen(); pipeline = fx.pipe(live); await fx.request(pipeline, 101, 'dire');
  assert.equal((await fx.process(pipeline)).reason, 'shared-parse-unknown'); await fx.clock.tick(120000); await fx.process(pipeline);
  assert.equal(fx.posts('parse').length, 2); assert.equal(fx.posts('analysis').length, 0);
});

test('definite second POST failure terminates both sides without a third request', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live), job = await fx.request(pipeline);
  await fx.process(pipeline); const first = fx.storage.listAttempts(job.id)[0];
  fx.hooks.opendota = (_url, init) => init.method === 'POST' ? Response.json({}, { status: 403 }) : undefined;
  await fx.clock.tick(first.createdAt + 120000 - fx.clock.now());
  const failed = await fx.process(pipeline); assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'parse-request-failed');
  await fx.request(pipeline, 101, 'dire'); assert.equal((await fx.process(pipeline)).reason, 'parse-request-failed');
  assert.equal(fx.posts('parse').length, 2); assert.equal(fx.posts('analysis').length, 0);
});

test('crash after durable retry admission cannot send an unrecorded retry on recovery', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); let pipeline = fx.pipe(live), job = await fx.request(pipeline);
  await fx.process(pipeline); const first = fx.storage.listAttempts(job.id)[0]; await pipeline.stop();
  await fx.clock.tick(first.createdAt + 120000 - fx.clock.now());
  const claim = fx.storage.claimNext()!.claim; fx.storage.beginParse(claim, { attemptId: 'interrupted-retry', retryOf: first.id });
  await fx.clock.tick(60001); fx.reopen(); pipeline = fx.pipe(live); await fx.request(pipeline, 101, 'dire');
  assert.equal((await fx.process(pipeline)).reason, 'shared-parse-unknown');
  assert.equal(fx.storage.getJob(job.id).state, 'needs-attention'); assert.equal(fx.storage.listAttempts(job.id).length, 2);
  assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 0);
});
