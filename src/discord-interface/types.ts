import type { Client, Interaction, RESTOptions, RESTPostAPIChatInputApplicationCommandsJSONBody, APIEmbed } from 'discord.js';
import type { GroupSettings } from '../group-settings/index.js';
import type { Clock, MatchPipeline, PublicationContext, Publisher } from '../match-pipeline/index.js';
import type { Storage } from '../storage/index.js';

export type { GroupSettings, PublicationContext, Publisher, APIEmbed };
export type ErrorCode = 'invalid-config' | 'invalid-input' | 'invalid-result' | 'invalid-message' | 'stopped' | 'aborted' | 'timeout'
  | 'ack-failed' | 'reply-failed' | 'access-denied' | 'not-found' | 'conflict' | 'storage-failure' | 'pipeline-failure'
  | 'forbidden' | 'unavailable' | 'rate-limited' | 'transport-error' | 'invalid-response';
export class DiscordInterfaceError extends Error {
  constructor(public readonly code: ErrorCode, public readonly operation: 'configure' | 'command' | 'register' | 'render' | 'lifecycle') {
    super(`Discord interface: ${code}`); this.name = 'DiscordInterfaceError';
  }
  toJSON(): { code: ErrorCode; operation: string; message: string } { return { code: this.code, operation: this.operation, message: this.message }; }
}
export interface RestDependencies { makeRequest?: RESTOptions['makeRequest']; signal?: AbortSignal }
export interface DiscordEvent {
  type: 'command' | 'error'; code: ErrorCode | 'completed'; interactionId?: string; guildId?: string; channelId?: string; jobId?: string;
}
export interface DiscordInterfaceOptions { settings: GroupSettings; requestTimeoutMs?: number }
export interface DiscordInterfaceDependencies {
  client: Pick<Client, 'on' | 'off'>;
  pipeline: Pick<MatchPipeline, 'requestMatch' | 'requestReanalysis' | 'getStatus'>;
  storage: Pick<Storage, 'getJobArtifacts'>;
  clock?: Clock; onEvent?: (event: Readonly<DiscordEvent>) => void | Promise<void>;
}
export interface DiscordInterface {
  handleInteraction(interaction: Interaction): Promise<{ status: 'ignored' | 'handled' }>;
  attach(): void;
  stop(): Promise<void>;
}
export type CommandName = 'worst' | 'worst-status' | 'worst-reanalyze';
export type CommandDefinition = RESTPostAPIChatInputApplicationCommandsJSONBody;
export interface RegistrationReport {
  status: 'complete' | 'partial'; registered: { name: CommandName; id: string }[];
  error: { name: CommandName; code: ErrorCode } | null;
}
