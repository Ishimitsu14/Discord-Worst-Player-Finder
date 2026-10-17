import type { GroupSettings } from '../group-settings/index.js';
import type { PipelineOptions, Clock, Publisher } from '../match-pipeline/index.js';
import type { PromptPackage } from '../match-analysis/index.js';
import type { Client, RESTOptions } from 'discord.js';

export type OperationsCode = 'invalid-config' | 'missing-secret' | 'read-error' | 'data-required' | 'data-exists' | 'invalid-state'
  | 'write-error' | 'startup-failed' | 'startup-timeout' | 'runtime-failed' | 'shutdown-timeout' | 'not-ready' | 'invalid-input';
export class OperationsError extends Error {
  constructor(public readonly code: OperationsCode) { super(`Operations: ${code}`); this.name = 'OperationsError'; }
  toJSON() { return { code: this.code, message: this.message }; }
}
export interface ServiceConfig {
  version: 1; applicationId: string; groupSettingsPath: string; dataDir: string; automatic: boolean;
  pipeline: Omit<PipelineOptions, 'automaticSince'>; startupTimeoutMs: number; shutdownTimeoutMs: number;
}
export interface ServiceSecrets { discordToken?: string; openRouterKey?: string; openDotaKey?: string }
export interface ServiceInput {
  config: ServiceConfig; settings: GroupSettings; prompt: PromptPackage; dictionary: unknown; releaseRoot: string; secrets: ServiceSecrets;
}
export interface ServiceState { version: 1; installationId: string; automaticSince: number | null }
export interface ServiceStatus {
  version: 1; revision: string; timestamp: number; pid: number; phase: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  discordReady: boolean; mode: 'prepare-only' | 'live'; automatic: boolean; knownCostUsd: number; unknownCount: number;
}
export interface ServiceEvent { component: 'operations' | 'pipeline' | 'discord'; code: string; jobId?: string; interactionId?: string }
export interface ServiceDependencies {
  client?: Client; fetcher?: typeof fetch; makeRequest?: RESTOptions['makeRequest']; publisher?: Publisher; clock?: Clock;
  signal?: AbortSignal;
  onEvent?: (event: Readonly<ServiceEvent>) => void | Promise<void>;
}
export interface Service { stop(): Promise<void>; done: Promise<void> }
