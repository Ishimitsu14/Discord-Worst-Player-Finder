import { appendFileSync } from 'node:fs';
import { Client, REST } from 'discord.js';

const destroy = Client.prototype.destroy;
Object.defineProperty(Client.prototype, 'login', { value: async function (this: Client) {
  Object.defineProperty(this, 'isReady', { configurable: true, value: () => true }); return 'synthetic';
} });
Object.defineProperty(Client.prototype, 'destroy', { value: async function (this: Client) {
  Object.defineProperty(this, 'isReady', { configurable: true, value: () => false }); await destroy.call(this);
} });
let posts = 0;
Object.defineProperty(REST.prototype, 'post', { value: async (route: string, options: { body: { name: string } }) => {
  posts++; appendFileSync(process.env.WPF_TEST_TRACE!, JSON.stringify({ route, name: options.body.name }) + '\n');
  if (String(posts) === process.env.WPF_TEST_REST_FAIL) throw new Error('synthetic-discord-secret');
  return { id: String(123456789012345670n + BigInt(posts)), name: options.body.name };
} });
globalThis.fetch = async () => { throw new Error('synthetic-network-forbidden'); };
