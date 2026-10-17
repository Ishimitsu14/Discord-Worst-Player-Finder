import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OpenDotaClient, OpenDotaError, type ParsedMatchResult, type PlayerMatch, type Raw } from '../src/opendota/index.js';
import { baseUrl } from '../src/opendota/http.js';
import { matchFixture, fixtureOrigin } from './opendota-fixtures.js';
import { deferred, errorIs, flush, TestClock, upstream } from './opendota-helpers.js';
import { loadParsedMatch } from './opendota-example.js';

const matchId = 9044556864;
function row(): PlayerMatch {
  const { players, version, ...base } = matchFixture();
  return { ...base, ...players[0] };
}
const basic = (): Raw => { const value = { ...matchFixture() } as Raw; delete value.version; return value; };

test('параметры проверяются до сети: ID, Steam32, страницы, job ID и срок', async () => {
  const { client, calls } = upstream(() => { throw new Error('unexpected network'); });
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null]) {
    await assert.rejects(client.getMatch(value as number), errorIs('invalid_argument'));
    await assert.rejects(client.requestParse(value as number), errorIs('invalid_argument'));
  }
  for (const value of [0, 4294967295, 76561198000000000, -1, 1.2, NaN, '1']) await assert.rejects(client.getPlayerMatches(value as number), errorIs('invalid_argument'));
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: Infinity }]) await assert.rejects(client.getPlayerMatches(1, options), errorIs('invalid_argument'));
  for (const id of ['', '0', '-1', '1.2', '1e3', '/1', 'https://example.test', '9007199254740992', 1]) await assert.rejects(client.getParseJob(id as string), errorIs('invalid_argument'));
  for (const timeoutMs of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null as unknown as number]) await assert.rejects(client.waitForParsedMatch(matchId, '1', { timeoutMs }), errorIs('invalid_argument'));
  await assert.rejects(client.getMatch(matchId, { fresh: 'yes' as unknown as boolean }), errorIs('invalid_argument'));
  assert.equal(calls.length, 0);
  await assert.rejects(client.getMatch(1, null as never), errorIs('invalid_argument'));
  assert.throws(() => new OpenDotaClient(null as never), errorIs('invalid_argument'));
});

test('история: явная пагинация, significant=0, пустой ответ, режимы и исходы без фильтра', async () => {
  const a = row(), b = { ...row(), match_id: 9046778399, radiant_win: false, lobby_type: 0, game_mode: 23 };
  const { client, calls } = upstream(url => Response.json(url.searchParams.get('offset') === '40' ? [] : [b, a]));
  assert.deepEqual(await client.getPlayerMatches(1, { limit: 10, offset: 20 }), [b, a]);
  assert.equal(calls[0].url.href, baseUrl + '/players/1/matches?limit=10&offset=20&significant=0');
  assert.deepEqual(await client.getPlayerMatches(1, { offset: 40 }), []);
  assert.equal(calls[1].url.searchParams.get('limit'), '20');
  const invalid = upstream(() => Response.json([a, { ...b, duration: null }]));
  await assert.rejects(invalid.client.getPlayerMatches(1), errorIs('invalid_response'));
  await assert.rejects(invalid.client.getPlayerMatches(1), errorIs('invalid_response'));
  assert.equal(invalid.calls.length, 2);
});

test('матчи: реальные проекции победы/поражения, обе стороны, неполный состав и неизвестные данные', async () => {
  assert.match(fixtureOrigin, /производной/);
  for (const index of [0, 1]) {
    const data = matchFixture(index);
    data.players[0].account_id = null; data.players[1].account_id = 4294967295;
    data.players[0].future_metric = { values: [null, 0, []] };
    delete data.players[2].hero_damage;
    const { client, clock } = upstream(() => Response.json(data));
    const snapshot = await client.getMatch(data.match_id);
    assert.deepEqual(snapshot.data, data); assert.equal(snapshot.parseState, 'parsed');
    assert.equal(snapshot.retrievedAt, clock.now());
    assert.equal(snapshot.data.players.length, 10);
    assert.ok(snapshot.data.players.some(player => player.player_slot >= 128));
    assert.equal(Object.hasOwn(snapshot.data.players[2], 'hero_damage'), false);
    assert.equal(clock.timers.size, 0);
  }
  const data = matchFixture(); data.players = data.players.slice(0, 3);
  assert.equal((await upstream(() => Response.json(data)).client.getMatch(matchId)).data.players.length, 3);
});

test('базовый контракт и версия: неверные поля не кешируются, basic отличается от parsed', async () => {
  for (const version of [undefined, null, 0, 22]) {
    const data = { ...basic(), ...(version === undefined ? {} : { version }) };
    const snapshot = await upstream(() => Response.json(data)).client.getMatch(matchId);
    assert.equal(snapshot.parseState, version ? 'parsed' : 'basic');
    assert.deepEqual(snapshot.data, data);
  }
  for (const change of [
    (data: Raw) => { data.match_id = 1; }, (data: Raw) => { data.duration = -1; }, (data: Raw) => { delete data.start_time; },
    (data: Raw) => { data.radiant_win = 'yes'; }, (data: Raw) => { data.game_mode = 1.5; },
    (data: Raw) => { data.players = [matchFixture().players[0], matchFixture().players[0]]; },
    (data: Raw) => { (data.players as Raw[])[0].player_slot = 256; }, (data: Raw) => { (data.players as Raw[])[0].hero_id = 0; },
    (data: Raw) => { data.version = -1; }, (data: Raw) => { data.version = '22'; }, (data: Raw) => { data.version = 1.5; },
  ]) {
    const data = matchFixture() as Raw; change(data);
    const { client, calls } = upstream(() => Response.json(data));
    await assert.rejects(client.getMatch(matchId), errorIs('invalid_response'));
    await assert.rejects(client.getMatch(matchId), errorIs('invalid_response')); assert.equal(calls.length, 2);
  }
});

test('кеш: TTL basic/parsed/history, копии, retrievedAt и fresh без подмены старым ответом', async () => {
  for (const parsed of [false, true]) {
    let fail = false;
    const { client, calls, clock } = upstream(() => fail ? new Response('', { status: 404 }) : Response.json(parsed ? matchFixture() : basic()));
    const first = await client.getMatch(matchId), loadedAt = first.retrievedAt;
    first.data.players[0].hero_id = 999;
    await clock.tick(parsed ? 899999 : 14999);
    const cached = await client.getMatch(matchId);
    assert.notEqual(cached.data.players[0].hero_id, 999); assert.equal(cached.retrievedAt, loadedAt); assert.equal(calls.length, 1);
    await clock.tick(1); assert.ok((await client.getMatch(matchId)).retrievedAt > loadedAt); assert.equal(calls.length, 2);
    fail = true;
    await assert.rejects(client.getMatch(matchId, { fresh: true }), errorIs('not_found'));
    assert.equal(calls.length, 3);
    assert.equal((await client.getMatch(matchId)).parseState, parsed ? 'parsed' : 'basic');
  }
  const history = upstream(() => Response.json([row()]));
  (await history.client.getPlayerMatches(1))[0].hero_id = 999;
  await history.clock.tick(29999); assert.notEqual((await history.client.getPlayerMatches(1))[0].hero_id, 999); assert.equal(history.calls.length, 1);
  await history.clock.tick(1); await history.client.getPlayerMatches(1); assert.equal(history.calls.length, 2);
});

test('кеш ограничен 100 записями и вытесняет самую старую добавленную', async () => {
  const { client, calls, clock } = upstream(url => Response.json({ ...matchFixture(), match_id: Number(url.pathname.split('/').at(-1)) }));
  for (let id = 1; id <= 101; id++) { if (id % 40 === 0) await clock.tick(60000); await client.getMatch(id); }
  await client.getMatch(2); assert.equal(calls.length, 101);
  await client.getMatch(1); assert.equal(calls.length, 102);
});

test('GET объединяются без сигнала, возвращают копии; с сигналом независимы; job не кешируется', async () => {
  const gate = deferred<Response>(), source = upstream(() => gate.promise);
  const a = source.client.getMatch(matchId), b = source.client.getMatch(matchId);
  await flush(); assert.equal(source.calls.length, 1); gate.resolve(Response.json(matchFixture()));
  const [one, two] = await Promise.all([a, b]); one.data.players.pop(); assert.equal(two.data.players.length, 10);
  const second = upstream(() => Response.json(matchFixture()));
  await Promise.all([second.client.getMatch(matchId, { signal: new AbortController().signal }), second.client.getMatch(matchId, { signal: new AbortController().signal })]);
  assert.equal(second.calls.length, 2);
  const jobs = upstream(() => Response.json(null));
  await Promise.all([jobs.client.getParseJob('1'), jobs.client.getParseJob('1')]); assert.equal(jobs.calls.length, 1);
  await jobs.client.getParseJob('1'); assert.equal(jobs.calls.length, 2);
});

test('предварительная отмена проверяется перед кешем и всеми операциями', async () => {
  const { client, calls } = upstream(() => Response.json(matchFixture()));
  await client.getMatch(matchId);
  const signal = AbortSignal.abort();
  for (const operation of [() => client.getMatch(matchId, { signal }), () => client.getPlayerMatches(1, { signal }), () => client.requestParse(matchId, { signal }), () => client.getParseJob('1', { signal }), () => client.waitForParsedMatch(matchId, '1', { signal })]) {
    await assert.rejects(operation(), errorIs('aborted'));
  }
  assert.equal(calls.length, 1);
});

test('постоянные HTTP ошибки и неверный JSON не повторяются; временные GET имеют ровно два повтора', async () => {
  for (const [status, code] of [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [422, 'bad_request']] as const) {
    const source = upstream(() => new Response('private upstream error', { status }));
    await assert.rejects(source.client.getMatch(matchId), errorIs(code, { httpStatus: status })); assert.equal(source.calls.length, 1);
  }
  const invalid = upstream(() => new Response('{invalid'));
  await assert.rejects(invalid.client.getMatch(matchId), errorIs('invalid_response')); assert.equal(invalid.calls.length, 1);
  for (const kind of ['network', '500', 'timeout']) {
    const source = upstream(() => { if (kind === 'network') throw new Error('private network error'); if (kind === 'timeout') return new Promise<Response>(() => {}); return new Response('', { status: 500 }); });
    const pending = assert.rejects(source.client.getMatch(matchId), errorIs(kind === 'network' ? 'network_error' : kind === '500' ? 'upstream_error' : 'timeout'));
    await source.clock.tick(kind === 'timeout' ? 33000 : 3000); await pending;
    assert.equal(source.calls.length, 3); assert.equal(source.clock.timers.size, 0);
  }
  const recovery = upstream((url, init, index) => index < 2 ? new Response('', { status: 503 }) : Response.json(matchFixture()));
  const pending = recovery.client.getMatch(matchId); await recovery.clock.tick(3000); assert.equal((await pending).parseState, 'parsed');
  assert.deepEqual(recovery.calls.map(call => call.at - recovery.calls[0].at), [0, 1000, 3000]);
});

test('таймаут чтения тела входит в попытку; оборванное тело повторяется как сетевая ошибка', async () => {
  const slow = upstream(() => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response);
  const pending = assert.rejects(slow.client.getMatch(matchId), errorIs('timeout'));
  await slow.clock.tick(33000); await pending; assert.equal(slow.calls.length, 3); assert.equal(slow.clock.timers.size, 0);
  const broken = upstream((url, init, index) => index === 0 ? ({ ok: true, json: () => Promise.reject(new TypeError('socket closed')) }) as unknown as Response : Response.json(matchFixture()));
  const recovered = broken.client.getMatch(matchId); await broken.clock.tick(1000); assert.equal((await recovered).parseState, 'parsed');
});

test('ключ только в Bearer; ошибка, данные и диагностические объекты не раскрывают секрет', async () => {
  const secret = 'synthetic-key-only-in-test';
  const publicApi = upstream(() => Response.json(matchFixture()));
  await publicApi.client.getMatch(matchId); assert.deepEqual(publicApi.calls[0].init.headers, {});
  const source = upstream(() => new Response(secret, { status: 401 }), secret);
  await assert.rejects(source.client.getMatch(matchId), error => {
    assert.ok(error instanceof OpenDotaError); assert.equal(error.code, 'unauthorized');
    for (const text of [String(error), JSON.stringify(error), error.stack!]) assert.equal(text.includes(secret), false);
    assert.equal('cause' in error, false); return true;
  });
  assert.deepEqual(source.calls[0].init.headers, { Authorization: `Bearer ${secret}` });
  assert.equal(source.calls[0].url.searchParams.has('api_key'), false);
  assert.equal(JSON.stringify(source.client).includes(secret), false);
  const reflected = upstream(() => Response.json({ ...matchFixture(), nested: { value: secret } }), secret);
  await assert.rejects(reflected.client.getMatch(matchId), errorIs('invalid_response'));
});

test('429: секунды, HTTP-date и fallback задают общий cooldown без сети до retryAt', async () => {
  for (const header of ['30', 'date', null, 'bad', '-1']) {
    const source = upstream((url, init, index) => index === 0 ? new Response('', { status: 429, headers: header ? { 'Retry-After': header === 'date' ? new Date(source.clock.now() + 45000).toUTCString() : header } : {} }) : Response.json(null));
    const timeout = header === '30' ? 30000 : header === 'date' ? 45000 : 60000;
    const retryAt = source.clock.now() + timeout;
    await assert.rejects(source.client.getParseJob('1'), errorIs('rate_limited', { retryAt }));
    await assert.rejects(source.client.requestParse(matchId), errorIs('rate_limited', { retryAt, requestMayHaveSucceeded: false }));
    await source.clock.tick(timeout - 1);
    await assert.rejects(source.client.getParseJob('2'), errorIs('rate_limited', { retryAt })); assert.equal(source.calls.length, 1);
    await source.clock.tick(1); assert.deepEqual(await source.client.getParseJob('2'), { state: 'missing' });
  }
});

test('скользящий бюджет учитывает вес POST и время освобождения нужного числа единиц', async () => {
  const source = upstream(() => Response.json(null));
  await source.client.getParseJob('1'); await source.clock.tick(1000);
  for (let index = 0; index < 58; index++) await source.client.getParseJob(String(index + 2));
  const now = source.clock.now();
  await assert.rejects(source.client.requestParse(matchId), errorIs('rate_limited', { retryAt: now + 60000, requestMayHaveSucceeded: false }));
  await source.client.getParseJob('100'); assert.equal(source.calls.length, 60);
  await assert.rejects(source.client.getParseJob('101'), errorIs('rate_limited', { retryAt: now + 59000 }));
  await source.clock.tick(59000); await source.client.getParseJob('101'); assert.equal(source.calls.length, 61);
  const posts = upstream(() => Response.json({ job: { jobId: 1 } }));
  for (let index = 1; index <= 6; index++) await posts.client.requestParse(index);
  await assert.rejects(posts.client.requestParse(7), errorIs('rate_limited')); assert.equal(posts.calls.length, 6);
});

test('POST один, без повторов; неопределённый исход явно отмечен', async () => {
  for (const kind of ['network', 'timeout', '500', 'json', 'job', '401']) {
    const source = upstream(() => {
      if (kind === 'network') throw new Error('private');
      if (kind === 'timeout') return new Promise<Response>(() => {});
      if (kind === 'json') return new Response('invalid');
      if (kind === 'job') return Response.json({ job: { jobId: 'url/invalid' } });
      return new Response('', { status: Number(kind) });
    });
    const pending = assert.rejects(source.client.requestParse(matchId), error => {
      assert.ok(error instanceof OpenDotaError); assert.equal(error.requestMayHaveSucceeded, kind !== '401'); return true;
    });
    await source.clock.tick(10000); await pending; assert.equal(source.calls.length, 1); assert.equal(source.clock.timers.size, 0);
  }
});

test('POST объединяет подписчиков, инвалидирует кеш; новый явный вызов создаёт отдельный POST', async () => {
  const gate = deferred<Response>();
  const source = upstream((url, init) => init.method === 'POST' ? gate.promise : Response.json(matchFixture()));
  await source.client.getMatch(matchId);
  const a = source.client.requestParse(matchId), b = source.client.requestParse(matchId);
  await flush(); assert.equal(source.calls.length, 2);
  gate.resolve(Response.json({ job: { jobId: 588786891 } }));
  const [one, two] = await Promise.all([a, b]); assert.deepEqual(one, { matchId, jobId: '588786891' }); one.jobId = '2'; assert.equal(two.jobId, '588786891');
  await source.client.getMatch(matchId); assert.equal(source.calls.length, 3);
  const another = upstream(() => Response.json({ job: { jobId: '5' } }));
  await another.client.requestParse(1); await another.client.requestParse(1); assert.equal(another.calls.length, 2);
});

test('POST: отмена одного подписчика не отменяет остальных; все отменены до отправки — POST отсутствует', async () => {
  const gate = deferred<Response>(), source = upstream(() => gate.promise);
  const controller = new AbortController();
  const a = source.client.requestParse(matchId, { signal: controller.signal }), b = source.client.requestParse(matchId);
  const rejected = assert.rejects(a, errorIs('aborted')); controller.abort(); await rejected;
  await flush(); assert.equal(source.calls.length, 1); assert.equal(source.calls[0].init.signal?.aborted, false);
  gate.resolve(Response.json({ job: { jobId: 1 } })); assert.equal((await b).jobId, '1'); assert.equal(source.clock.timers.size, 0);
  const empty = upstream(() => Response.json({ job: { jobId: 1 } }));
  const x = new AbortController(), y = new AbortController();
  const calls = [empty.client.requestParse(1, { signal: x.signal }), empty.client.requestParse(1, { signal: y.signal })];
  const done = Promise.all(calls.map(promise => assert.rejects(promise, errorIs('aborted', { requestMayHaveSucceeded: false }))));
  x.abort(); y.abort(); await done; await flush(); assert.equal(empty.calls.length, 0); assert.equal(empty.clock.timers.size, 0);
  assert.equal((await empty.client.requestParse(1)).jobId, '1');
});

test('GET: отмена в HTTP и задержке прекращает работу, независимый подписчик продолжает', async () => {
  const source = upstream(() => new Promise<Response>(() => {})), controller = new AbortController();
  const pending = assert.rejects(source.client.getMatch(matchId, { signal: controller.signal }), errorIs('aborted'));
  await flush(); controller.abort(); await pending; assert.equal(source.clock.timers.size, 0);
  await source.clock.tick(60000); assert.equal(source.calls.length, 1);
  const retry = upstream(() => new Response('', { status: 500 })), abort = new AbortController();
  const delayed = assert.rejects(retry.client.getMatch(matchId, { signal: abort.signal }), errorIs('aborted'));
  await flush(); abort.abort(); await delayed; await retry.clock.tick(60000); assert.equal(retry.calls.length, 1); assert.equal(retry.clock.timers.size, 0);
});

test('job: null, номер, строка, неизвестные поля и неверный ID', async () => {
  for (const value of [null, { jobId: 1, data: { match_id: matchId }, future: [] }, { jobId: '1', status: 'not-a-contract' }]) {
    const result = await upstream(() => Response.json(value)).client.getParseJob('01');
    assert.deepEqual(result, value === null ? { state: 'missing' } : { state: 'present', data: value });
  }
  for (const value of [{ jobId: 2 }, { jobId: 'url' }, {}, [], 1]) await assert.rejects(upstream(() => Response.json(value)).client.getParseJob('1'), errorIs('invalid_response'));
});

test('ожидание: basic → missing → parsed, свежие чтения и восстановление с известным job без POST', async () => {
  let reads = 0;
  const source = upstream(url => url.pathname.includes('/matches/') ? Response.json(++reads > 2 ? matchFixture() : basic()) : Response.json(null));
  await source.client.getMatch(matchId);
  const pending = source.client.waitForParsedMatch(matchId, '588786891'); await source.clock.tick(15000);
  const result: ParsedMatchResult = await pending;
  assert.equal(result.state, 'parsed'); if (result.state === 'parsed') assert.equal(result.snapshot.parseState, 'parsed');
  assert.equal(reads, 3); assert.equal(source.calls.length, 4); assert.ok(source.calls.every(call => call.init.method === 'GET')); assert.equal(source.clock.timers.size, 0);
  const restored = await source.client.waitForParsedMatch(matchId, result.jobId); assert.equal(restored.state, 'parsed'); assert.equal(reads, 4);
});

test('ожидание: общий срок ограничивает HTTP, повторы, polling и сохраняет последний снимок/ошибку', async () => {
  const basicOnly = upstream(url => Response.json(url.pathname.includes('/matches/') ? basic() : null));
  const pending = basicOnly.client.waitForParsedMatch(matchId, '1', { timeoutMs: 20000 }); await basicOnly.clock.tick(20000);
  const timedOut = await pending; assert.equal(timedOut.state, 'timed-out');
  if (timedOut.state === 'timed-out') { assert.equal(timedOut.snapshot?.parseState, 'basic'); assert.equal(timedOut.lastError, null); }
  assert.equal(basicOnly.calls.length, 4); assert.equal(basicOnly.clock.timers.size, 0);
  const slow = upstream(() => new Promise<Response>(() => {}));
  const short = slow.client.waitForParsedMatch(matchId, '1', { timeoutMs: 500 }); await slow.clock.tick(500);
  const noSnapshot = await short; assert.equal(noSnapshot.state, 'timed-out'); if (noSnapshot.state === 'timed-out') assert.equal(noSnapshot.snapshot, null);
  assert.equal(slow.calls.length, 1); assert.equal(slow.clock.timers.size, 0);
  const retry = upstream(() => new Response('', { status: 500 }));
  const near = retry.client.waitForParsedMatch(matchId, '1', { timeoutMs: 1500 }); await retry.clock.tick(1500);
  assert.equal((await near).state, 'timed-out'); assert.equal(retry.calls.length, 2); assert.equal(retry.clock.timers.size, 0);
});

test('ожидание: 429 переносит проверку до retryAt; временная ошибка остаётся в timed-out', async () => {
  const source = upstream((url, init, index) => index === 0 ? new Response('', { status: 429, headers: { 'Retry-After': '40' } }) : Response.json(matchFixture()));
  const pending = source.client.waitForParsedMatch(matchId, '1', { timeoutMs: 60000 }); await source.clock.tick(39999); assert.equal(source.calls.length, 1);
  await source.clock.tick(1); assert.equal((await pending).state, 'parsed'); assert.equal(source.calls[1].at - source.calls[0].at, 40000);
  const fail = upstream(url => url.pathname.includes('/matches/') ? Response.json(basic()) : new Response('', { status: 429 }));
  const stopped = fail.client.waitForParsedMatch(matchId, '1', { timeoutMs: 1000 }); await fail.clock.tick(1000);
  const result = await stopped; assert.equal(result.state, 'timed-out');
  if (result.state === 'timed-out') { assert.equal(result.snapshot?.parseState, 'basic'); assert.equal(result.lastError?.code, 'rate_limited'); }
  assert.equal(fail.clock.timers.size, 0);
  const server = upstream(url => url.pathname.includes('/matches/') ? Response.json(basic()) : new Response('', { status: 503 }));
  const expired = server.client.waitForParsedMatch(matchId, '1', { timeoutMs: 5000 }); await server.clock.tick(5000);
  const saved = await expired; assert.equal(saved.state, 'timed-out');
  if (saved.state === 'timed-out') { assert.equal(saved.snapshot?.parseState, 'basic'); assert.equal(saved.lastError?.code, 'upstream_error'); }
  assert.equal(server.clock.timers.size, 0);
});

test('ожидание: постоянные ошибки/неверное задание прекращают операцию; отмена polling очищает таймеры', async () => {
  for (const response of [() => Response.json({ jobId: 1, data: { match_id: 2 } }), () => Response.json({ jobId: 2 }), () => new Response('', { status: 404 })]) {
    const source = upstream(url => url.pathname.includes('/matches/') ? Response.json(basic()) : response());
    await assert.rejects(source.client.waitForParsedMatch(matchId, '1'), error => error instanceof OpenDotaError && ['invalid_response', 'not_found'].includes(error.code));
    assert.equal(source.calls.length, 2); assert.equal(source.clock.timers.size, 0);
  }
  const source = upstream(url => Response.json(url.pathname.includes('/matches/') ? basic() : null)), controller = new AbortController();
  const pending = assert.rejects(source.client.waitForParsedMatch(matchId, '1', { signal: controller.signal }), errorIs('aborted'));
  await flush(); controller.abort(); await pending; await source.clock.tick(60000); assert.equal(source.calls.length, 2); assert.equal(source.clock.timers.size, 0);
});

test('интеграция: история → basic → один POST → временная ошибка → parsed и повторное ожидание', async () => {
  let reads = 0;
  const source = upstream((url, init) => {
    if (url.pathname.includes('/players/')) return Response.json([row()]);
    if (init.method === 'POST') return Response.json({ job: { jobId: 588786891 } });
    if (url.pathname.includes('/request/')) return Response.json({ jobId: 588786891, data: { match_id: matchId } });
    reads++;
    return reads === 2 ? new Response('', { status: 503 }) : Response.json(reads >= 4 ? matchFixture() : basic());
  });
  const history = await source.client.getPlayerMatches(98341323);
  const first = await source.client.getMatch(history[0].match_id); assert.equal(first.parseState, 'basic');
  const queued = await source.client.requestParse(first.data.match_id);
  const pending = source.client.waitForParsedMatch(queued.matchId, queued.jobId); await source.clock.tick(16000);
  assert.equal((await pending).state, 'parsed'); assert.equal(source.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal((await source.client.waitForParsedMatch(queued.matchId, queued.jobId)).state, 'parsed');
  assert.equal(source.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(source.clock.timers.size, 0);
});

test('429 возвращает наиболее поздний срок: cooldown и минутный бюджет действуют совместно', async () => {
  const source = upstream((url, init, index) => index === 59 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json(null));
  const start = source.clock.now();
  for (let index = 0; index < 59; index++) await source.client.getParseJob(String(index + 1));
  await assert.rejects(source.client.getParseJob('60'), errorIs('rate_limited', { retryAt: start + 60000 }));
  await source.clock.tick(1000);
  await assert.rejects(source.client.getParseJob('61'), errorIs('rate_limited', { retryAt: start + 60000 })); assert.equal(source.calls.length, 60);
});

test('повторы расходуют квоту; объединённые чтения/отменённый до отправки POST её не расходуют', async () => {
  const source = upstream(() => new Response('', { status: 503 }));
  const pending = Array.from({ length: 20 }, (_, index) => assert.rejects(source.client.getParseJob(String(index + 1)), errorIs('upstream_error')));
  await source.clock.tick(3000); await Promise.all(pending);
  assert.equal(source.calls.length, 60);
  await assert.rejects(source.client.getParseJob('21'), errorIs('rate_limited'));
  const gate = deferred<Response>(), shared = upstream(() => gate.promise);
  const reads = Array.from({ length: 60 }, () => shared.client.getParseJob('1'));
  await flush(); gate.resolve(Response.json(null)); await Promise.all(reads); assert.equal(shared.calls.length, 1);
  const empty = upstream(() => Response.json({ job: { jobId: 1 } }));
  for (let index = 0; index < 7; index++) {
    const controller = new AbortController();
    const promise = assert.rejects(empty.client.requestParse(1, { signal: controller.signal }), errorIs('aborted'));
    controller.abort(); await promise;
  }
  for (let index = 0; index < 6; index++) await empty.client.requestParse(index + 1);
  assert.equal(empty.calls.length, 6);
});

test('GET с независимыми сигналами: отмена первого не прерывает второй', async () => {
  const first = new AbortController(), second = new AbortController();
  const gate = deferred<Response>(), source = upstream(() => gate.promise);
  const a = assert.rejects(source.client.getMatch(matchId, { signal: first.signal }), errorIs('aborted'));
  const b = source.client.getMatch(matchId, { signal: second.signal });
  await flush(); first.abort(); await a;
  assert.equal(source.calls[1].init.signal?.aborted, false);
  gate.resolve(Response.json(matchFixture())); assert.equal((await b).parseState, 'parsed'); assert.equal(source.clock.timers.size, 0);
});

test('отмена отправленного POST не скрывает возможное создание задания и не отменяет общий HTTP', async () => {
  const gate = deferred<Response>(), source = upstream(() => gate.promise), controller = new AbortController();
  const pending = assert.rejects(source.client.requestParse(1, { signal: controller.signal }), errorIs('aborted', { requestMayHaveSucceeded: true }));
  await flush(); controller.abort(); await pending; assert.equal(source.calls[0].init.signal?.aborted, false);
  const follower = source.client.requestParse(1);
  gate.resolve(Response.json({ job: { jobId: 1 } })); assert.equal((await follower).jobId, '1'); assert.equal(source.calls.length, 1); assert.equal(source.clock.timers.size, 0);
});

test('ожидание не возвращает успех после общего срока, даже если таймер ещё не обработан', async () => {
  const source = upstream(() => { source.clock.time += 600; return Response.json(matchFixture()); });
  const result = await source.client.waitForParsedMatch(matchId, '1', { timeoutMs: 500 });
  assert.equal(result.state, 'timed-out'); assert.equal(source.calls.length, 1); assert.equal(source.clock.timers.size, 0);
  const job = upstream(url => {
    if (url.pathname.includes('/matches/')) return Response.json(basic());
    job.clock.time += 600; return Response.json(null);
  });
  assert.equal((await job.client.waitForParsedMatch(matchId, '1', { timeoutMs: 500 })).state, 'timed-out'); assert.equal(job.clock.timers.size, 0);
});

test('запаздывающий GET не восстанавливает кеш, инвалидированный POST', async () => {
  const gate = deferred<Response>(); let gets = 0;
  const source = upstream((url, init) => init.method === 'POST' ? Response.json({ job: { jobId: 1 } }) : ++gets === 1 ? gate.promise : Response.json(matchFixture()));
  const old = source.client.getMatch(matchId); await flush(); await source.client.requestParse(matchId);
  gate.resolve(Response.json(basic())); assert.equal((await old).parseState, 'basic');
  assert.equal((await source.client.getMatch(matchId)).parseState, 'parsed'); assert.equal(gets, 2);
});

test('случайная добавка к задержке остаётся в 0–250 мс', async () => {
  const clock = new TestClock(), times: number[] = [];
  const client = new OpenDotaClient({}, { clock, random: () => 0.999999, fetcher: async () => { times.push(clock.now()); return new Response('', { status: 503 }); } });
  const pending = assert.rejects(client.getMatch(matchId), errorIs('upstream_error')); await clock.tick(3500); await pending;
  assert.deepEqual(times.map(time => time - times[0]), [0, 1250, 3500]); assert.equal(clock.timers.size, 0);
});

test('пример README совпадает с компилируемым исходником и работает без живой сети; ключи примера пустые', async () => {
  const readme = await readFile('src/opendota/README.md', 'utf8'), example = await readFile('test/opendota-example.ts', 'utf8');
  assert.equal(readme.match(/```ts\n([\s\S]*?)\n```/)![1].trim(), example.trim());
  let reads = 0;
  const source = upstream((url, init) => init.method === 'POST' ? Response.json({ job: { jobId: 1 } }) : Response.json(++reads === 1 ? basic() : matchFixture()));
  assert.equal((await loadParsedMatch(source.client, matchId)).state, 'parsed'); assert.equal(source.calls.length, 3);
  const ready = upstream(() => Response.json(matchFixture()));
  const loaded = await loadParsedMatch(ready.client, matchId);
  assert.equal(loaded.state, 'already-parsed'); assert.equal('jobId' in loaded, false); assert.equal(ready.calls.length, 1);
  const env = await readFile('.env.example', 'utf8');
  assert.match(env, /^OPENDOTA_API_KEY=\s*$/m);
  assert.ok(env.split(/\r?\n/).every(line => !line.includes('=') || line.slice(line.indexOf('=') + 1).trim() === ''));
});
