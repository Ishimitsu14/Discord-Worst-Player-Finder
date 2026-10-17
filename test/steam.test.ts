import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SteamHistoryClient, SteamHistoryError, type ErrorCode } from '../src/steam/index.js';
import { TestClock, flush } from './opendota-helpers.js';

const key = 'synthetic-steam-secret';
export const steamPage = (ids: number[] = [105, 104], remaining = 0) => ({ result: { status: 1, num_results: ids.length, total_results: ids.length + remaining, results_remaining: remaining, matches: ids.map(match_id => ({ match_id, start_time: 123 })) } });
function fixture(handler: (url: URL, index: number) => Response | Promise<Response>) {
  const clock = new TestClock(), calls: URL[] = [];
  const client = new SteamHistoryClient({ apiKey: key }, { clock, random: () => 0, fetcher: async (input, init) => {
    assert.equal(init?.redirect, 'error'); const url = new URL(String(input)); calls.push(url); return handler(url, calls.length - 1);
  } });
  return { client, calls, clock };
}
const errorIs = (code: ErrorCode) => (error: unknown) => {
  assert.ok(error instanceof SteamHistoryError); assert.equal(error.code, code); assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes(key)); assert.ok(!error.stack?.includes(key)); return true;
};

test('Steam: inert creation and validation before any HTTP', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const environment = process.env;
    process.env = new Proxy(environment, { get(target, name) { if (name === 'STEAM_API_KEY') throw Error('unexpected env'); return Reflect.get(target, name); } });
    globalThis.fetch = () => { throw Error('unexpected HTTP'); };
    const api = await import('./dist/src/steam/index.js');
    assert.deepEqual(Object.keys(api).sort(), ['SteamHistoryClient', 'SteamHistoryError']);
    new api.SteamHistoryClient({apiKey: 'synthetic-import-key'});
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const fx = fixture(() => assert.fail('unexpected HTTP')); assert.equal(fx.clock.timers.size, 0);
  assert.throws(() => new SteamHistoryClient({ apiKey: '' }), errorIs('invalid-input'));
  for (const id of [0, -1, 4294967295, 1.5, '1', NaN]) await assert.rejects(fx.client.getMatchHistory(id as number), errorIs('invalid-input'));
  for (const options of [{ limit: 0 }, { limit: 101 }, { startAtMatchId: 0 }, { startAtMatchId: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }, null]) {
    await assert.rejects(fx.client.getMatchHistory(1, options as never), errorIs('invalid-input'));
  }
  assert.equal(fx.calls.length, 0); assert.equal(fx.clock.timers.size, 0);
});

test('Steam: compact pages, explicit cursor and empty available history', async () => {
  const fx = fixture(url => Response.json(url.searchParams.has('start_at_match_id') ? steamPage([103]) : steamPage([105, 104], 1)));
  assert.deepEqual(await fx.client.getMatchHistory(98341323), { matches: [{ matchId: 105, startTime: 123 }, { matchId: 104, startTime: 123 }], nextStartAtMatchId: 103 });
  assert.equal(fx.calls[0].origin, 'https://api.steampowered.com'); assert.equal(fx.calls[0].searchParams.get('key'), key); assert.equal(fx.calls[0].searchParams.get('matches_requested'), '20');
  assert.equal((await fx.client.getMatchHistory(1, { startAtMatchId: 103, limit: 1 })).nextStartAtMatchId, null);
  assert.deepEqual(await fixture(() => Response.json(steamPage([]))).client.getMatchHistory(1), { matches: [], nextStartAtMatchId: null });
  assert.equal(fx.clock.timers.size, 0);
});

test('Steam: API errors differ from empty history and never retry', async () => {
  for (const [status, code] of [[15, 'history-private'], [2, 'api-error']] as const) {
    const fx = fixture(() => Response.json({ result: { status } })); await assert.rejects(fx.client.getMatchHistory(1), errorIs(code)); assert.equal(fx.calls.length, 1);
  }
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [302, 'api-error']] as const) {
    const fx = fixture(() => new Response(null, { status })); await assert.rejects(fx.client.getMatchHistory(1), errorIs(code)); assert.equal(fx.calls.length, 1);
  }
});

test('Steam: malformed, unsafe, inconsistent and nonadvancing pages fail closed', async () => {
  const a = steamPage();
  for (const payload of [{}, { result: { status: '1' } }, { result: { ...a.result, num_results: 3 } }, steamPage([], 1), steamPage([1], 1),
    steamPage([105, 105]), steamPage([Number.MAX_SAFE_INTEGER + 1]), { result: { ...a.result, matches: [{ match_id: 105, start_time: null }, a.result.matches[1]] } }]) {
    const fx = fixture(() => Response.json(payload)); await assert.rejects(fx.client.getMatchHistory(1), errorIs('invalid-response')); assert.equal(fx.calls.length, 1);
  }
  await assert.rejects(fixture(() => Response.json(steamPage([106]))).client.getMatchHistory(1, { startAtMatchId: 105 }), errorIs('invalid-response'));
});

test('Steam: transient retries are bounded and every HTTP attempt is counted', async () => {
  const fx = fixture((_url, index) => index < 2 ? new Response(null, { status: 503 }) : Response.json(steamPage()));
  const result = fx.client.getMatchHistory(1); await fx.clock.tick(1000); await fx.clock.tick(2000); assert.equal((await result).matches.length, 2); assert.equal(fx.calls.length, 3);
  const failed = fixture(() => { throw Error(`URL with ${key}`); }); const pending = assert.rejects(failed.client.getMatchHistory(1), errorIs('network-error'));
  await failed.clock.tick(3000); await pending; assert.equal(failed.calls.length, 3); assert.equal(failed.clock.timers.size, 0);
});

test('Steam: global Retry-After supports seconds, dates and fallback', async () => {
  for (const kind of ['seconds', 'date', 'missing']) {
    const fx = fixture(() => new Response(null, { status: 429, headers: kind === 'missing' ? {} : { 'Retry-After': kind === 'seconds' ? '60' : new Date(1800000060000).toUTCString() } }));
    await assert.rejects(fx.client.getMatchHistory(1), errorIs('rate-limited'));
    await assert.rejects(fx.client.getMatchHistory(2), errorIs('rate-limited')); assert.equal(fx.calls.length, 1);
    await fx.clock.tick(60000); await assert.rejects(fx.client.getMatchHistory(2), errorIs('rate-limited')); assert.equal(fx.calls.length, 2);
  }
});

test('Steam: local rolling quota covers different accounts', async () => {
  const fx = fixture(() => Response.json(steamPage()));
  for (let index = 0; index < 60; index++) await fx.client.getMatchHistory(index + 1);
  await assert.rejects(fx.client.getMatchHistory(100), errorIs('rate-limited')); assert.equal(fx.calls.length, 60);
  await fx.clock.tick(60000); await fx.client.getMatchHistory(100); assert.equal(fx.calls.length, 61);
});

test('Steam: timeout includes body and abort stops retry waits and HTTP', async () => {
  const timed = fixture(() => new Promise(() => {})); const timeout = assert.rejects(timed.client.getMatchHistory(1), errorIs('timeout'));
  await timed.clock.tick(33000); await timeout; assert.equal(timed.calls.length, 3); assert.equal(timed.clock.timers.size, 0);
  const fx = fixture(() => { throw Error('temporary'); }), controller = new AbortController();
  const stopped = assert.rejects(fx.client.getMatchHistory(1, { signal: controller.signal }), errorIs('aborted'));
  await flush(); controller.abort(); await stopped; await fx.clock.tick(10000); assert.equal(fx.calls.length, 1); assert.equal(fx.clock.timers.size, 0);
  const body = fixture(() => { const response = Response.json({}); response.json = () => new Promise(() => {}); return response; });
  const cancel = new AbortController(), pending = assert.rejects(body.client.getMatchHistory(1, { signal: cancel.signal }), errorIs('aborted'));
  await flush(); cancel.abort(); await pending; assert.equal(body.clock.timers.size, 0);
});

test('Steam: reflected secrets and invalid JSON are never exported', async () => {
  for (const handler of [() => Response.json({ reflected: key }), () => new Response('{invalid')]) {
    const fx = fixture(handler); await assert.rejects(fx.client.getMatchHistory(1), errorIs('invalid-response')); assert.equal(fx.calls.length, 1);
  }
});
