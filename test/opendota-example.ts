import { OpenDotaClient, type MatchSnapshot, type ParsedMatchResult } from '../src/opendota/index.js';

export async function loadParsedMatch(client: OpenDotaClient, matchId: number, signal?: AbortSignal): Promise<ParsedMatchResult | { state: 'already-parsed'; snapshot: MatchSnapshot }> {
  const snapshot = await client.getMatch(matchId, { signal });
  if (snapshot.parseState === 'parsed') return { state: 'already-parsed', snapshot };
  const queued = await client.requestParse(matchId, { signal });
  return client.waitForParsedMatch(matchId, queued.jobId, { timeoutMs: 900000, signal });
}
