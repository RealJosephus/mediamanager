import { readFile } from 'node:fs/promises';
import { startProductionInstance } from '../../../../src/main.js';

let runtime;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
try {
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const dates = input.cases.map(sample => {
    const fraction = /\.(\d+)/u.exec(sample.input)?.[1] ?? '';
    // The public contract uses Node's native timezone conversion. Keep the
    // declared sub-millisecond digits independently of Date's millisecond store.
    const date = new Date(sample.input).toISOString().replace(/\.\d{3}Z$/u, '.' + fraction.padEnd(7, '0') + 'Z');
    return { name: sample.name, date };
  });
  runtime = await startProductionInstance({ onError: error => {
    void send({ kind: 'runtime-error', error: { name: error.name, message: error.message, code: error.code } });
  } });
  process.on('message', async message => {
    if (message !== 'close') return;
    try {
      await runtime.close(); runtime = undefined;
      await send({ kind: 'closed' }); process.disconnect();
    } catch (error) {
      await send({ kind: 'failure', error: { name: error.name, message: error.message, stack: error.stack } });
      process.exitCode = 1; process.disconnect();
    }
  });
  await send({ kind: 'ready', origin: `http://127.0.0.1:${runtime.server.address().port}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, requestedTimezone: process.env.TZ, dates });
} catch (error) {
  await send({ kind: 'failure', error: { name: error.name, message: error.message, stack: error.stack } });
  await runtime?.close(); process.exitCode = 1; process.disconnect();
}
