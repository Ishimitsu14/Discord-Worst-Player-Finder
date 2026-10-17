import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';
import { PermissionsBitField, type Interaction, type ChatInputCommandInteraction } from 'discord.js';
import { createDiscordInterface, createDiscordPublisher, type DiscordInterfaceOptions, type DiscordInterfaceDependencies, type PublicationContext, type RestDependencies } from '../src/discord-interface/index.js';
import type { MatchPipeline } from '../src/match-pipeline/index.js';
import { fixture, live, settings, drive, flush, data, intercepted, response, prompt } from './match-pipeline-helpers.js';

export { fixture, live, settings, drive, flush, data, intercepted, response, prompt };
export const token = 'synthetic-discord-token';
export type HttpInit = Parameters<NonNullable<RestDependencies['makeRequest']>>[1];
export interface HttpCall { url: URL; init: HttpInit }
export function http(handler?: (call: HttpCall) => Response | Promise<Response> | undefined) {
  const calls: HttpCall[] = [];
  const makeRequest: NonNullable<RestDependencies['makeRequest']> = async (url, init) => {
    const call = { url: new URL(url), init }; calls.push(call); const custom = handler?.(call);
    const result = custom !== undefined ? await custom : init.method === 'GET' ? Response.json({ id: settings.channelId, guild_id: settings.guildId, type: 0 }) : Response.json({ id: '18446744073709551613', channel_id: settings.channelId });
    return result as unknown as Awaited<ReturnType<NonNullable<RestDependencies['makeRequest']>>>;
  };
  return { calls, makeRequest, posts: () => calls.filter(call => call.init.method === 'POST') };
}
let sequence = 1800000000000000000n;
export function interaction(options: { name?: string; matchId?: string; jobId?: string; side?: string; guildId?: string | null; channelId?: string; permissions?: bigint; thread?: boolean; id?: string } = {}) {
  const responses: { method: 'reply' | 'defer' | 'edit'; body: Record<string, unknown> }[] = [];
  const hooks: { reply?: () => Promise<unknown>; defer?: () => Promise<unknown>; edit?: () => Promise<unknown> } = {};
  const values = { match_id: options.matchId ?? '101', job_id: options.jobId, side: options.side };
  const command = {
    id: options.id ?? String(sequence++), guildId: options.guildId === undefined ? settings.guildId : options.guildId,
    channelId: options.channelId ?? settings.channelId, commandName: options.name ?? 'worst',
    channel: { isThread: () => options.thread ?? false }, memberPermissions: options.permissions === undefined ? new PermissionsBitField(0n) : new PermissionsBitField(options.permissions),
    isChatInputCommand: () => true,
    options: { getString(name: string, required = false) { const value = values[name as keyof typeof values] ?? null; if (required && value === null) throw new Error('synthetic missing option'); return value; } },
    async reply(body: Record<string, unknown>) { responses.push({ method: 'reply', body }); await hooks.reply?.(); },
    async deferReply(body: Record<string, unknown>) { responses.push({ method: 'defer', body }); await hooks.defer?.(); },
    async editReply(body: Record<string, unknown>) { responses.push({ method: 'edit', body }); await hooks.edit?.(); },
  } as unknown as ChatInputCommandInteraction;
  return { command, responses, hooks, content: () => responses.filter(row => row.method !== 'defer').map(row => row.body.content).join('\n') };
}
export function commands(fx: Awaited<ReturnType<typeof fixture>>, pipeline: MatchPipeline = fx.pipe(), options: Partial<DiscordInterfaceOptions> = {}, overrides: Partial<DiscordInterfaceDependencies> = {}) {
  const client = new EventEmitter();
  const ui = createDiscordInterface({ settings, ...options }, { client: client as unknown as DiscordInterfaceDependencies['client'], pipeline, storage: fx.storage, clock: fx.clock, ...overrides });
  return { ui, client, pipeline, handle: (input: ReturnType<typeof interaction>) => drive(ui.handleInteraction(input.command as Interaction), fx.clock) };
}
export async function accepted(t: TestContext, matchData = data()) {
  const fx = await fixture(t); fx.matches.set(101, matchData);
  const pipeline = fx.pipe(live); const job = await fx.request(pipeline); await fx.process(pipeline);
  const stored = fx.storage.getLatestResult(101, 'radiant')!, artifacts = fx.storage.getJobArtifacts(job.id);
  const context: PublicationContext = { job: stored.job, analysis: stored.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! };
  return Object.assign(fx, { context, job, pipeline });
}
export const publisher = (makeRequest: NonNullable<RestDependencies['makeRequest']>) => createDiscordPublisher({ botToken: token }, { makeRequest });
