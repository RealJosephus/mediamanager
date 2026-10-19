import { writeFile } from 'node:fs/promises';
import { recordSyncPlay } from '../../tests/sessions/syncplay-scenario.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { recordSyncPlayAccess } from '../../tests/sessions/syncplay-access-scenario.js';
import { recordSyncPlayWait } from '../../tests/sessions/syncplay-wait-scenario.js';

const [origin, output, mode] = process.argv.slice(2);
if (!origin || !output) throw new Error('Usage: record-syncplay ORIGIN NEW_OUTPUT');
const recording = await ({ access: recordSyncPlayAccess, wait: recordSyncPlayWait }[mode] ?? recordSyncPlay)(origin);
await writeFile(output, stringifyNativeJson(recording), { flag: 'wx' });
console.log(JSON.stringify({ cases: recording.records.length, messages: recording.raw.length, output }));
