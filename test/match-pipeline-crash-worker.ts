import { appendFileSync, writeSync } from 'node:fs';
import { openStorage } from '../src/storage/index.js';
import { OpenDotaClient } from '../src/opendota/index.js';
import { createMatchPipeline } from '../src/match-pipeline/index.js';
import { data, dictionary, prompt, live, settings, TestClock, intercepted, response, drive } from './match-pipeline-helpers.js';
import { metadata } from './match-analysis-helpers.js';

const [path, phase] = process.argv.slice(2), clock = new TestClock();
const storage = openStorage({ path, clock: { now: clock.now } });
function pause(jobId: string): never { writeSync(1, JSON.stringify({ jobId, now: clock.now() }) + '\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); process.exit(2); }
const port = intercepted(storage, {
  reserveAnalysis: ((...args: Parameters<typeof storage.reserveAnalysis>) => { const value = storage.reserveAnalysis(...args); if (phase === 'prepared') pause(value.jobId); return value; }) as never,
  saveAnalysisOutcome: ((...args: Parameters<typeof storage.saveAnalysisOutcome>) => { const value = storage.saveAnalysisOutcome(...args); if (phase === 'after-analysis') pause(value.jobId); return value; }) as never,
  beginPublication: ((...args: Parameters<typeof storage.beginPublication>) => {
    if (phase === 'before-publication') pause(args[0].jobId);
    const value = storage.beginPublication(...args); if (phase === 'publication-admitted') pause(value.jobId); return value;
  }) as never,
  savePublicationOutcome: ((...args: Parameters<typeof storage.savePublicationOutcome>) => { const value = storage.savePublicationOutcome(...args); if (phase === 'publication-saved') pause(value.jobId); return value; }) as never,
});
const opendota = new OpenDotaClient({}, { clock, fetcher: async () => Response.json(data()) });
const pipeline = createMatchPipeline(live, { settings, storage: port, opendota, facts: { dictionary }, prompt, apiKey: 'synthetic-crash-key', clock,
  fetcher: async (url, init) => {
    if (String(url).endsWith('/endpoints')) return Response.json(metadata());
    appendFileSync(path + '.effects', 'analysis\n'); return response(init?.body);
  },
  publisher: { prepare: () => '{}', send: async () => {
    appendFileSync(path + '.effects', 'publication\n');
    if (phase === 'publication-sent') pause(storage.getLatestJob(101, 'radiant')!.id);
    return { messageId: '123456' };
  } },
});
await drive(pipeline.requestMatch({ matchId: 101, side: 'radiant' }), clock);
await drive(pipeline.processNext(), clock);
throw new Error('crash phase not reached');
