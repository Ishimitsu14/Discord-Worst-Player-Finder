import { PermissionFlagsBits, Routes, SlashCommandBuilder } from 'discord.js';
import type { REST } from 'discord.js';
import { createRest, restError } from './rest.js';
import { DiscordInterfaceError, type CommandDefinition, type CommandName, type RegistrationReport, type RestDependencies } from './types.js';
import { ensure, keys, object, snowflake } from './values.js';

export function buildCommandDefinitions(): CommandDefinition[] {
  const worst = new SlashCommandBuilder().setName('worst').setDescription('Поставить матч на разбор или показать сохранённую задачу')
    .addStringOption(option => option.setName('match_id').setDescription('ID матча OpenDota без ссылки').setRequired(true).setMinLength(1).setMaxLength(16));
  const repeat = new SlashCommandBuilder().setName('worst-reanalyze').setDescription('Создать новую версию анализа матча: только администратору')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('match_id').setDescription('ID матча OpenDota без ссылки').setRequired(true).setMinLength(1).setMaxLength(16));
  for (const [command, required] of [[worst, false], [repeat, true]] as const) command.addStringOption(option => option.setName('side').setDescription('Сторона для анализа')
    .setRequired(required).addChoices({ name: 'Radiant', value: 'radiant' }, { name: 'Dire', value: 'dire' }));
  return [worst.toJSON(), new SlashCommandBuilder().setName('worst-status').setDescription('Показать ход задачи и сохранённый результат')
    .addStringOption(option => option.setName('job_id').setDescription('ID задачи из ответа бота').setRequired(true).setMinLength(1).setMaxLength(128)).toJSON(), repeat.toJSON()];
}
export async function registerGuildCommands(options: { applicationId: string; guildId: string; botToken: string }, dependencies: RestDependencies = {}): Promise<RegistrationReport> {
  let rest: REST;
  try { keys(options, ['applicationId', 'guildId', 'botToken']); ensure(snowflake(options.applicationId) && snowflake(options.guildId)); rest = createRest({ botToken: options.botToken }, dependencies); }
  catch { throw new DiscordInterfaceError('invalid-config', 'configure'); }
  const report: RegistrationReport = { status: 'complete', registered: [], error: null };
  for (const command of buildCommandDefinitions()) {
    const name = command.name as CommandName;
    try {
      dependencies.signal?.throwIfAborted();
      const result: unknown = await rest.post(Routes.applicationGuildCommands(options.applicationId, options.guildId), { body: command, signal: dependencies.signal });
      if (!object(result) || !snowflake(result.id) || result.name !== name) throw new DiscordInterfaceError('invalid-response', 'register');
      report.registered.push({ name, id: result.id });
    } catch (error) { report.status = 'partial'; report.error = { name, code: dependencies.signal?.aborted ? 'aborted' : error instanceof DiscordInterfaceError ? error.code : restError(error) }; break; }
  }
  return report;
}
