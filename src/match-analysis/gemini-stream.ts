import { performance } from 'node:perf_hooks';
import { abortable } from './run.js';
import { usageOf } from './openrouter.js';
import type { GeminiAttempt } from './gemini-types.js';
import { AnalysisError, type Raw } from './types.js';
import { ensure, object, parse } from './values.js';

export function readGeminiMetadata(data: Raw, attempt: GeminiAttempt, key: string): void {
  if (object(data.usage)) {
    const usage = usageOf(data.usage);
    for (const field of Object.keys(usage) as (keyof typeof usage)[]) if (usage[field] !== null) attempt.usage[field] = usage[field];
  }
  for (const [field, value] of Object.entries({ generationId: data.id, model: data.model, provider: data.provider })) {
    if (typeof value !== 'string') continue;
    ensure(!value.includes(key), 'secret-in-output');
    const name = field as 'generationId' | 'model' | 'provider';
    ensure(attempt[name] === null || attempt[name] === value, name === 'model' ? 'model-mismatch' : 'invalid-output');
    attempt[name] = value;
  }
}

export function geminiApiError(data: Raw, status: number): GeminiAttempt['error'] {
  const error = object(data.error) ? data.error : {}, metadata = object(error.metadata) ? error.metadata : {};
  const apiType = typeof metadata.error_type === 'string' && ['context_length_exceeded', 'authentication', 'rate_limit_exceeded', 'provider_overloaded', 'provider_unavailable', 'content_policy_violation', 'refusal', 'server', 'timeout', 'unmapped'].includes(metadata.error_type) ? metadata.error_type : undefined;
  return { code: 'api-error', httpStatus: status, ...(apiType ? { apiType } : {}) };
}

export async function readGeminiStream(response: Response, attempt: GeminiAttempt, key: string, signal: AbortSignal, clock: number): Promise<void> {
  ensure(response.body && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'), 'invalid-output');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], done = false, finished = false;
  attempt.content = '';
  const event = (): void => {
    if (!data.length) return;
    const payload = data.join('\n'); data = [];
    ensure(!done, 'unfinished-or-filtered');
    if (payload === '[DONE]') { done = true; return; }
    const chunk = parse(payload, 'invalid-output'); ensure(object(chunk), 'invalid-output');
    readGeminiMetadata(chunk, attempt, key);
    if (chunk.error != null) { attempt.error = geminiApiError(chunk, response.status); throw new AnalysisError('api-error'); }
    const choices = chunk.choices ?? []; ensure(Array.isArray(choices) && choices.length <= 1, 'invalid-output');
    if (!choices.length) return;
    const choice = choices[0]; ensure(object(choice) && (choice.index === undefined || choice.index === 0), 'invalid-output');
    if (choice.error != null) { attempt.error = geminiApiError({ error: choice.error }, response.status); throw new AnalysisError('api-error'); }
    const delta = choice.delta ?? {}; ensure(object(delta), 'invalid-output');
    ensure((delta.role === undefined || delta.role === 'assistant') && delta.refusal == null && delta.function_call == null && (delta.tool_calls == null || Array.isArray(delta.tool_calls) && !delta.tool_calls.length), 'unfinished-or-filtered');
    if (delta.content != null) {
      ensure(typeof delta.content === 'string' && (!finished || delta.content.length === 0), 'unfinished-or-filtered');
      attempt.content! += delta.content; ensure(!attempt.content!.includes(key), 'secret-in-output');
      if (delta.content.length && attempt.firstContentMs === null) attempt.firstContentMs = performance.now() - clock;
    }
    if (choice.finish_reason != null) {
      ensure(typeof choice.finish_reason === 'string' && !choice.finish_reason.includes(key), 'secret-in-output');
      ensure(!finished || object(chunk.usage) && choice.finish_reason === attempt.finishReason, 'unfinished-or-filtered');
      attempt.finishReason = choice.finish_reason; finished = true;
    }
  };
  const line = (value: string): void => {
    if (value === '') event();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (true) {
      const part = await abortable(() => reader.read(), signal);
      if (part.done) { buffer += decoder.decode(); break; }
      attempt.streamBytes += part.value.byteLength; ensure(attempt.streamBytes <= 2097152, 'invalid-output');
      buffer += decoder.decode(part.value, { stream: true });
      while (true) {
        const at = buffer.search(/[\r\n]/); if (at < 0 || buffer[at] === '\r' && at === buffer.length - 1) break;
        const consumed = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
        const value = buffer.slice(0, at); buffer = buffer.slice(at + consumed); line(value);
      }
    }
    if (buffer.length) line(buffer.replace(/\r$/, ''));
    ensure(done && finished && attempt.finishReason === 'stop', 'unfinished-or-filtered');
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
