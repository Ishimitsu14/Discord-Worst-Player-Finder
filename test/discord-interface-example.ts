import type { Client } from 'discord.js';
import { createDiscordInterface, createDiscordPublisher, type RestDependencies } from '../src/discord-interface/index.js';
import { createMatchPipeline, type PipelineDependencies, type PipelineOptions } from '../src/match-pipeline/index.js';

export function assembleDiscordExample(options: PipelineOptions, dependencies: PipelineDependencies, client: Client, botToken: string, rest: RestDependencies) {
  const publisher = createDiscordPublisher({ botToken }, rest);
  const pipeline = createMatchPipeline(options, { ...dependencies, publisher });
  const discord = createDiscordInterface({ settings: dependencies.settings }, { client, pipeline, storage: dependencies.storage, clock: dependencies.clock });
  return { publisher, pipeline, discord };
}
