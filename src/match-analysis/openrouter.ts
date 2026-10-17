import type { PreparedAnalysis, Rates, Raw, Usage } from './types.js';
import { ensure, finite, integer, object, positive, text } from './values.js';

export const completionUrl = 'https://openrouter.ai/api/v1/chat/completions';
export const metadataUrl = 'https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-pro/endpoints';
export const emptyUsage = (): Usage => ({ promptTokens: null, completionTokens: null, totalTokens: null, reasoningTokens: null, cachedTokens: null, costUsd: null });

function price(value: unknown): number {
  ensure(finite(value) || typeof value === 'string' && value.trim().length > 0, 'unknown-price');
  const amount = Number(value);
  ensure(Number.isFinite(amount) && amount >= 0, 'unknown-price');
  return amount;
}

export function inspectMetadata(input: unknown, prepared: PreparedAnalysis): Rates {
  ensure(object(input) && object(input.data), 'metadata-unavailable');
  const { data } = input;
  const profile = prepared.prompt.profile;
  ensure(data.id === profile.model && Array.isArray(data.endpoints), 'metadata-unavailable');
  const allowed = profile.provider.only;
  const endpoints = data.endpoints.filter((value: unknown): value is Raw => {
    if (!object(value)) return false;
    const name = String(value.provider_name).toLowerCase(), tag = String(value.tag).toLowerCase();
    return allowed.some(provider => name === provider || tag === provider || !provider.includes('/') && tag.split('/')[0] === provider);
  });
  ensure(endpoints.length > 0, 'unsupported-endpoint');
  const rates = endpoints.map(endpoint => {
    ensure(Array.isArray(endpoint.supported_parameters) && ['temperature', 'max_tokens', 'response_format', 'structured_outputs'].every(parameter => (endpoint.supported_parameters as unknown[]).includes(parameter)), 'unsupported-endpoint');
    ensure(positive(endpoint.context_length) && prepared.estimatedInputTokens + profile.maxTokens <= endpoint.context_length, 'context-too-large');
    for (const [field, needed] of [['max_prompt_tokens', prepared.estimatedInputTokens], ['max_completion_tokens', profile.maxTokens]] as const) {
      ensure(endpoint[field] == null || positive(endpoint[field]) && needed <= endpoint[field], 'context-too-large');
    }
    ensure(object(endpoint.pricing), 'unknown-price');
    const prices = endpoint.pricing;
    const input = Math.max(price(prices.prompt), ...['input_cache_read', 'input_cache_write'].filter(key => prices[key] != null).map(key => price(prices[key])));
    return { input, output: price(prices.completion), request: prices.request == null ? 0 : price(prices.request), name: text(endpoint.name) ? endpoint.name : String(endpoint.tag) };
  });
  return { input: Math.max(...rates.map(rate => rate.input)), output: Math.max(...rates.map(rate => rate.output)), request: Math.max(...rates.map(rate => rate.request)), endpointNames: rates.map(rate => rate.name) };
}

export function usageOf(input: unknown): Usage {
  const usage = object(input) ? input : {};
  const prompt = object(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completion = object(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const count = (value: unknown): number | null => integer(value) ? value : null;
  return { promptTokens: count(usage.prompt_tokens), completionTokens: count(usage.completion_tokens), totalTokens: count(usage.total_tokens),
    reasoningTokens: count(completion.reasoning_tokens), cachedTokens: count(prompt.cached_tokens), costUsd: finite(usage.cost) && usage.cost >= 0 ? usage.cost : null };
}

export function retryAt(value: string | null, status: number): string | null {
  const header = value?.trim() ?? '';
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
  const parsed = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : /^[A-Za-z]{3}, /.test(header) ? Date.parse(header) : NaN;
  const time = Number.isFinite(parsed) && Math.abs(parsed) <= 8640000000000000 ? Math.max(Date.now(), parsed) : [429, 503].includes(status) ? Date.now() + 60000 : null;
  return time === null ? null : new Date(time).toISOString();
}
