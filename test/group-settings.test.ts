import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { copyFile, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GroupSettingsError, loadGroupSettings, type GroupSettings } from '../src/group-settings/index.js';

const valid = () => ({ steamAccountIds: [100000002, 100000001], guildId: '100000000000000001', channelId: '100000000000000002' });
async function fixture(t: TestContext): Promise<{ root: string; path: string; write(value: unknown): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'group-settings-')), path = join(root, ' company settings.json');
  t.after(async () => { for (const name of await readdir(root)) await unlink(join(root, name)); await rmdir(root); });
  return { root, path, write: value => writeFile(path, JSON.stringify(value)) };
}
function errorIs(code: GroupSettingsError['code'], path?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof GroupSettingsError); assert.equal(error.code, code);
    if (path) { assert.equal(error.issues[0].path, path); assert.ok(error.message.includes(path)); }
    return true;
  };
}

test('импорт без чтения настроек; загрузка примера без секретов, сети, записи и наблюдения', async t => {
  const f = await fixture(t); await copyFile('config/group-settings.example.json', f.path);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';
    let reads = 0, writes = 0, network = 0, watches = 0;
    const originalRead = fs.readFile;
    const modulePath = resolve('dist/src/group-settings/index.js'), moduleUrl = pathToFileURL(modulePath);
    fs.readFile = async (...args) => {
      if (args[0] instanceof URL ? args[0].href === moduleUrl.href : args[0] === modulePath) return originalRead(...args);
      reads++; throw new Error('unexpected configuration read at import');
    };
    fs.writeFile = async () => { writes++; throw new Error('unexpected write'); };
    fs.watch = () => { watches++; throw new Error('unexpected watch'); };
    globalThis.fetch = async () => { network++; throw new Error('network disabled'); };
    const api = await import(moduleUrl.href);
    assert.deepEqual(Object.keys(api).sort(), ['GroupSettingsError', 'loadGroupSettings']);
    assert.equal(reads, 0);
    fs.readFile = async (...args) => { reads++; return originalRead(...args); };
    const settings = await api.loadGroupSettings(process.argv[1]);
    const matchConsumer = config => config.steamAccountIds;
    const discordConsumer = config => ({ guildId: config.guildId, channelId: config.channelId });
    assert.equal(matchConsumer(settings), settings.steamAccountIds);
    assert.deepEqual(discordConsumer(settings), { guildId: '100000000000000001', channelId: '100000000000000002' });
    assert.throws(() => settings.steamAccountIds.push(3), TypeError);
    assert.throws(() => { settings.channelId = '1'; }, TypeError);
    assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(network, 0); assert.equal(watches, 0);
    for (const name of ['OPENROUTER_API_KEY', 'OPENDOTA_API_KEY', 'DISCORD_TOKEN', 'DISCORD_BOT_TOKEN']) assert.equal(process.env[name], undefined);
  `, f.path], { cwd: resolve('.'), encoding: 'utf8', timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !['OPENROUTER_API_KEY', 'OPENDOTA_API_KEY', 'DISCORD_TOKEN', 'DISCORD_BOT_TOKEN'].includes(name))) });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '');
  assert.deepEqual(await readdir(f.root), [' company settings.json']);
});

test('путь: пустой/нестроковый отвергается до чтения; непустой передаётся без trim', async t => {
  const reader = t.mock.method(fs, 'readFile', async () => JSON.stringify(valid()));
  for (const path of ['', ' ', '\t\r\n', null, undefined, 1, new URL('file:///example.json')]) await assert.rejects(loadGroupSettings(path as string), errorIs('invalid-settings', '$path'));
  assert.equal(reader.mock.calls.length, 0);
  assert.deepEqual(await loadGroupSettings('  file with spaces.json  '), valid());
  assert.deepEqual(reader.mock.calls[0].arguments, ['  file with spaces.json  ', 'utf8']);
});

test('чтение абсолютного/относительного пути с пробелами, UTF-8, LF/CRLF и одним BOM', async t => {
  const f = await fixture(t), expected: GroupSettings = valid();
  for (const newline of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    const source = bom + JSON.stringify(expected, null, 2).replace(/\n/g, newline);
    await writeFile(f.path, source, 'utf8');
    assert.deepEqual(await loadGroupSettings(f.path), expected);
    assert.deepEqual(await loadGroupSettings(relative(process.cwd(), f.path)), expected);
    assert.equal(await readFile(f.path, 'utf8'), source);
  }
});

test('read-error: отсутствующий файл и каталог без создания, fallback и раскрытия пути', async t => {
  const f = await fixture(t); await f.write(valid());
  const marker = 'SYNTHETIC-SECRET-IN-FILENAME';
  const missing = join(f.root, marker + '.json');
  await assert.rejects(loadGroupSettings(missing), error => {
    errorIs('read-error')(error); assert.ok(error instanceof GroupSettingsError);
    assert.equal(error.stack!.includes(marker), false); assert.equal(JSON.stringify(error).includes(marker), false); return true;
  });
  await assert.rejects(loadGroupSettings(f.root), errorIs('read-error'));
  assert.deepEqual(await readdir(f.root), [' company settings.json']);
});

test('управляемый EACCES: одно чтение, безопасная ошибка без исходного stack/cause', async t => {
  const marker = 'SYNTHETIC-ACCESS-SECRET';
  const reader = t.mock.method(fs, 'readFile', async () => { throw Object.assign(new Error(marker), { code: 'EACCES', path: marker }); });
  await assert.rejects(loadGroupSettings('file.json'), error => {
    errorIs('read-error')(error); assert.ok(error instanceof GroupSettingsError);
    assert.equal('cause' in error, false); assert.equal(JSON.stringify(error).includes(marker), false); assert.equal(error.stack!.includes(marker), false); return true;
  });
  assert.equal(reader.mock.calls.length, 1);
});

test('invalid-json: пустой, оборванный JSON, комментарии, хвостовая запятая и лишний BOM', async t => {
  const f = await fixture(t);
  for (const source of ['', '   ', '{', '{"steamAccountIds":[1],}', '// comment\n{}', '/* comment */ {}', '\uFEFF\uFEFF' + JSON.stringify(valid()), JSON.stringify(valid()) + '\uFEFF']) {
    await writeFile(f.path, source); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-json'));
    assert.equal(await readFile(f.path, 'utf8'), source);
  }
});

test('строгий корень: ровно три обязательных поля, известные пути и отказ от лишних полей', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 'text', true, 1]) { await f.write(value); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', '$')); }
  for (const field of ['steamAccountIds', 'guildId', 'channelId']) {
    const data = valid() as Record<string, unknown>; delete data[field]; await f.write(data);
    await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', field));
  }
  for (const key of ['guilds', 'channelIds', 'owners', 'discordToken', 'threshold', '__proto__']) {
    await f.write({ ...valid(), [key]: 'untrusted value' }); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', '$'));
  }
});

test('Steam32: один аккаунт, границы, порядок; типы, диапазоны и дубликаты отклоняются с индексом', async t => {
  const f = await fixture(t);
  for (const ids of [[1], [4294967294], [4294967294, 1], [100000002, 100000001]]) {
    await f.write({ ...valid(), steamAccountIds: ids }); assert.deepEqual((await loadGroupSettings(f.path)).steamAccountIds, ids);
  }
  for (const ids of [[], null, '1', 1, {}]) {
    await f.write({ ...valid(), steamAccountIds: ids }); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', 'steamAccountIds'));
  }
  for (const value of [0, 4294967295, 4294967296, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 76561198000000000, '1', 'STEAM_0:1:1', '[U:1:1]', 'https://steamcommunity.com/id/example', 'nickname', null, true, {}, []]) {
    await f.write({ ...valid(), steamAccountIds: [1, value] }); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', 'steamAccountIds[1]'));
  }
  await f.write({ ...valid(), steamAccountIds: [2, 1, 2] }); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', 'steamAccountIds[2]'));
});

test('Discord ID: точные строки до uint64, без Number, фиксированной длины или автокоррекции', async t => {
  const f = await fixture(t);
  for (const id of ['1', '9007199254740993', '12345678901234567890', '18446744073709551615']) {
    await f.write({ ...valid(), guildId: id, channelId: id });
    const settings = await loadGroupSettings(f.path); assert.equal(settings.guildId, id); assert.equal(settings.channelId, id);
  }
  for (const field of ['guildId', 'channelId']) for (const value of [1, 9007199254740992, '', null, '0', '01', ' 1', '1 ', '1\n', '1\r', '\t1', '+1', '-1', '1.5', '1e3', '<#123>', 'https://discord.com/channels/1/2', '18446744073709551616', '999999999999999999999', '١', '１', true, [], {}]) {
    await f.write({ ...valid(), [field]: value }); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings', field));
  }
});

test('секретный маркер не попадает в публичную диагностику, issues, stack/cause и собственные логи', async t => {
  const f = await fixture(t), marker = 'SYNTHETIC-SECRET-NEVER-LOG';
  const logs = ['log', 'warn', 'error', 'info', 'debug'].map(method => t.mock.method(console, method as 'log', () => {}));
  for (const source of [JSON.stringify({ ...valid(), [marker]: marker }), JSON.stringify({ ...valid(), guildId: marker }), JSON.stringify({ ...valid(), steamAccountIds: [1, marker] }), '{"broken":"' + marker]) {
    await writeFile(f.path, source);
    await assert.rejects(loadGroupSettings(f.path), error => {
      assert.ok(error instanceof GroupSettingsError); assert.equal('cause' in error, false);
      for (const text of [String(error), error.message, error.stack!, JSON.stringify(error), JSON.stringify(error.issues), JSON.stringify(Object.getOwnPropertyDescriptors(error))]) assert.equal(text.includes(marker), false);
      assert.ok(Object.isFrozen(error.issues)); return true;
    });
  }
  assert.ok(logs.every(log => log.mock.calls.length === 0));
});

test('неизменяемый снимок, новый объект/массив при явной загрузке; изменение/удаление не вызывает reread', async t => {
  const f = await fixture(t); await f.write(valid());
  const reader = t.mock.method(fs, 'readFile');
  const first: GroupSettings = await loadGroupSettings(f.path), same = await loadGroupSettings(f.path);
  assert.notEqual(first, same); assert.notEqual(first.steamAccountIds, same.steamAccountIds);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.steamAccountIds));
  assert.throws(() => { (first as { guildId: string }).guildId = '1'; }, TypeError);
  assert.throws(() => { (first.steamAccountIds as number[]).push(3); }, TypeError);
  assert.throws(() => { (first.steamAccountIds as number[])[0] = 3; }, TypeError);
  const changed = { steamAccountIds: [1], guildId: '2', channelId: '3' };
  await f.write(changed); assert.deepEqual(first, valid()); assert.equal(reader.mock.calls.length, 2);
  assert.deepEqual(await loadGroupSettings(f.path), changed); assert.equal(reader.mock.calls.length, 3);
  await writeFile(f.path, '{}'); await assert.rejects(loadGroupSettings(f.path), errorIs('invalid-settings')); assert.deepEqual(first, valid());
  await unlink(f.path); assert.deepEqual(first, valid()); assert.equal(reader.mock.calls.length, 4);
  await assert.rejects(loadGroupSettings(f.path), errorIs('read-error')); assert.equal(reader.mock.calls.length, 5);
});

test('полный путь: пример → копия → два потребителя → изменение → новая загрузка без сети', async t => {
  const f = await fixture(t); await copyFile('config/group-settings.example.json', f.path);
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network disabled'); });
  const settings = await loadGroupSettings(f.path);
  const matchConsumer = (input: GroupSettings): readonly number[] => input.steamAccountIds;
  const discordConsumer = (input: GroupSettings): Pick<GroupSettings, 'guildId' | 'channelId'> => ({ guildId: input.guildId, channelId: input.channelId });
  assert.equal(matchConsumer(settings), settings.steamAccountIds); assert.deepEqual(discordConsumer(settings), { guildId: '100000000000000001', channelId: '100000000000000002' });
  assert.throws(() => { (settings.steamAccountIds as number[]).pop(); }, TypeError);
  await f.write({ ...settings, steamAccountIds: [1] });
  assert.deepEqual(matchConsumer(await loadGroupSettings(f.path)), [1]); assert.equal(matchConsumer(settings).length, 2);
  assert.equal(network.mock.calls.length, 0);
  assert.deepEqual(await readdir(f.root), [' company settings.json']);
  assert.match(await readFile('.gitignore', 'utf8'), /^\.local\/$/m);
});
