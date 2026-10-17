import { mkdir, cp, lstat, writeFile, readFile, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

try {
  const [revision, directory = '.local/artifact'] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error();
  const root = fileURLToPath(new URL('..', import.meta.url)), output = resolve(directory);
  await mkdir(output, { recursive: true });
  const stage = join(output, `.stage-${randomUUID()}`); await mkdir(stage);
  for (const name of ['dist/src', 'analysis/prompts', 'evaluation/dictionaries/dotaconstants-v1.json', 'evaluation/dictionaries/hero-metrics-v1.json', 'package.json', 'package-lock.json',
    'config/service.example.json', 'config/group-settings.example.json', 'deploy/control.sh', 'deploy/receive.sh', 'deploy/worst-player.service', 'deploy/README.md']) {
    await cp(resolve(root, name), join(stage, name), { recursive: true, filter: async path => { if ((await lstat(path)).isSymbolicLink()) throw Error(); return true; } });
  }
  await writeFile(join(stage, 'REVISION'), revision + '\n');
  const archive = join(output, 'release.tar.gz'), reservation = await open(archive, 'wx'); await reservation.close();
  const result = spawnSync('tar', ['-czf', archive, '-C', stage, '.'], { windowsHide: true }); if (result.status !== 0) throw Error();
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(output, 'release.tar.gz.sha256'), `${digest}  release.tar.gz\n`, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ revision, digest }) + '\n');
} catch { process.stderr.write('release-package-failed\n'); process.exitCode = 1; }
