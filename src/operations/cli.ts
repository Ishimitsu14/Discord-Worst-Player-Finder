import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerGuildCommands } from '../discord-interface/index.js';
import { json, validateConfig, ensure, loadService } from './config.js';
import { backupService, initService } from './state.js';
import { readStatus, startService } from './runtime.js';
import { OperationsError, type ServiceEvent } from './types.js';

const help = 'Usage: npm run service -- <check|init|start|status|register-commands|backup> --config <path> [--output <new-backup-directory>]';
function log(event: ServiceEvent) { process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n'); }
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help + '\n'); return; }
  const command = args.shift(); ensure(command && ['check', 'init', 'start', 'status', 'register-commands', 'backup'].includes(command), 'invalid-input');
  const values: Record<string, string> = {};
  while (args.length) {
    const key = args.shift(), value = args.shift(); ensure(key && ['--config', '--output'].includes(key) && value && !value.startsWith('--') && !Object.hasOwn(values, key), 'invalid-input'); values[key] = value;
  }
  ensure(values['--config'] && (command === 'backup' ? values['--output'] : !values['--output']), 'invalid-input');
  if (command === 'status') {
    const config = validateConfig(await json(values['--config']), dirname(resolve(values['--config'])));
    process.stdout.write(JSON.stringify(await readStatus({ config })) + '\n'); return;
  }
  const secret = (name: string) => process.env[name] || undefined;
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const input = await loadService(values['--config'], { discordToken: secret('DISCORD_BOT_TOKEN'), openRouterKey: secret('OPENROUTER_API_KEY'), openRouterManagementKey: secret('OPENROUTER_MANAGEMENT_KEY'), openDotaKey: secret('OPENDOTA_API_KEY'), steamKey: secret('STEAM_API_KEY') }, root);
  if (command === 'check') { log({ component: 'operations', code: 'configuration-valid' }); return; }
  if (command === 'init') { await initService(input.config); log({ component: 'operations', code: 'initialized' }); return; }
  if (command === 'backup') { await backupService(input.config, resolve(values['--output'])); log({ component: 'operations', code: 'backup-created' }); return; }
  if (command === 'register-commands') {
    ensure(input.secrets.discordToken, 'missing-secret');
    const report = await registerGuildCommands({ applicationId: input.config.applicationId, guildId: input.settings.guildId, botToken: input.secrets.discordToken });
    process.stdout.write(JSON.stringify(report) + '\n'); if (report.status === 'partial') process.exitCode = 1; return;
  }
  const controller = new AbortController(), abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try { const service = await startService(input, { signal: controller.signal, onEvent: log }); await service.done; }
  finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
void main().catch(error => {
  const code = error instanceof OperationsError ? error.code : 'runtime-failed';
  process.stderr.write(JSON.stringify({ component: 'operations', code }) + '\n');
  if (code === 'shutdown-timeout') process.exit(1);
  process.exitCode = ['invalid-config', 'invalid-input', 'missing-secret', 'read-error', 'data-required', 'invalid-state', 'data-exists'].includes(code) ? 78 : 1;
});
