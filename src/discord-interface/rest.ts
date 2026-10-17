import { ChannelType, DiscordAPIError, RateLimitError, REST, Routes } from 'discord.js';
import { PublicationError, type Publisher, type PublicationInput } from '../match-pipeline/index.js';
import { DiscordInterfaceError, type ErrorCode, type RestDependencies } from './types.js';
import { ensure, keys, object, snowflake } from './values.js';
import { publicationMessage, validateMessage } from './render.js';

export function createRest(options: { botToken: string }, dependencies: RestDependencies): REST {
  try {
    keys(options, ['botToken']); keys(dependencies, [], ['makeRequest', 'signal']);
    ensure(typeof options.botToken === 'string' && options.botToken.trim().length > 0 && (dependencies.makeRequest === undefined || typeof dependencies.makeRequest === 'function')
      && (dependencies.signal === undefined || dependencies.signal instanceof AbortSignal));
    return new REST({ version: '10', retries: 0, rejectOnRateLimit: () => true, timeout: 15000, hashSweepInterval: 0, handlerSweepInterval: 0,
      ...(dependencies.makeRequest ? { makeRequest: dependencies.makeRequest as RestDependencies['makeRequest'] } : {}) }).setToken(options.botToken);
  } catch { throw new DiscordInterfaceError('invalid-config', 'configure'); }
}
export function restError(error: unknown): ErrorCode {
  if (error instanceof RateLimitError || error instanceof DiscordAPIError && error.status === 429) return 'rate-limited';
  if (error instanceof DiscordAPIError) {
    if ([401, 403].includes(error.status)) return 'forbidden';
    if (error.status === 404) return 'unavailable';
    if (error.status === 400) return 'invalid-message';
  }
  return 'transport-error';
}
export function createDiscordPublisher(options: { botToken: string }, dependencies: RestDependencies = {}): Publisher {
  const rest = createRest(options, dependencies);
  return {
    prepare: publicationMessage,
    async send(input: PublicationInput, { signal }) {
      let post = false;
      try {
        keys(input, ['version', 'guildId', 'channelId', 'analysisAttemptId', 'message']);
        ensure(input.version === 1 && snowflake(input.guildId) && snowflake(input.channelId), 'invalid-message', 'render'); validateMessage(input.message, input.analysisAttemptId);
        const combined = dependencies.signal ? AbortSignal.any([signal, dependencies.signal]) : signal;
        combined.throwIfAborted();
        const channel: unknown = await rest.get(Routes.channel(input.channelId), { signal: combined });
        ensure(object(channel) && channel.id === input.channelId && channel.guild_id === input.guildId && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type as number), 'unavailable', 'render');
        combined.throwIfAborted(); post = true;
        const result: unknown = await rest.post(Routes.channelMessages(input.channelId), { body: input.message, passThroughBody: true, headers: { 'Content-Type': 'application/json' }, signal: combined });
        ensure(object(result) && snowflake(result.id) && result.channel_id === input.channelId, 'invalid-response', 'render');
        return { messageId: result.id as string };
      } catch (error) {
        const code = error instanceof DiscordInterfaceError ? error.code === 'unavailable' ? 'unavailable' : error.code === 'invalid-response' ? 'transport-error' : 'invalid-message' : restError(error);
        const confirmed = error instanceof DiscordAPIError && [400, 401, 403, 404, 429].includes(error.status) || error instanceof RateLimitError;
        throw new PublicationError(code === 'forbidden' || code === 'unavailable' || code === 'invalid-message' || code === 'rate-limited' ? code : 'transport-error', !post || confirmed ? 'not-sent' : 'unknown');
      }
    },
  };
}
