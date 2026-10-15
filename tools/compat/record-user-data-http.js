import { writeFile } from 'node:fs/promises';
import { recordUserDataBinding } from '../../tests/sessions/user-data-binding-scenario.js';

const [origin, output] = process.argv.slice(2);
const url = new URL(origin);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !output) {
  throw new Error('Usage: record-user-data-http.js ISOLATED_LOOPBACK_ORIGIN NEW_OUTPUT');
}
const recording = await recordUserDataBinding(url.origin);
await writeFile(output, JSON.stringify(recording, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, records: recording.records.length }));
