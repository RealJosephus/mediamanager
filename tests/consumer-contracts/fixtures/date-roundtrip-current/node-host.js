import { readFile } from 'node:fs/promises';
import { startProductionInstance } from '../../../../src/main.js';

let runtime;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const payload = value => value == null || typeof value !== 'object' ? value : Array.isArray(value)
  ? value.map(payload) : { ...(value instanceof Error ? { name: value.name } : {}),
    ...Object.fromEntries(Object.getOwnPropertyNames(value).map(name => [name, payload(value[name])])) };
const listeners = value => value.networkHost.listeners.map(entry => ({ scheme: entry.scheme,
  address: entry.address, port: entry.port, bound: entry.bound, listening: entry.server.listening }));
try {
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const dates = input.cases.map(sample => {
    const fraction = /\.(\d+)/u.exec(sample.input)?.[1] ?? '';
    // The public contract uses Node's native timezone conversion. Keep the
    // declared sub-millisecond digits independently of Date's millisecond store.
    const date = new Date(sample.input).toISOString().replace(/\.\d{3}Z$/u, '.' + fraction.padEnd(7, '0') + 'Z');
    return { name: sample.name, date };
  });
  runtime = await startProductionInstance({ onError: error => send({ kind: 'runtime-error', error: payload(error) }) });
  process.on('message', async message => {
    if (message !== 'close') return;
    try {
      await runtime.close();
      const closedListeners = listeners(runtime); runtime = undefined;
      await send({ kind: 'closed', listeners: closedListeners }); process.disconnect();
    } catch (error) {
      await send({ kind: 'failure', error: payload(error) });
      process.exitCode = 1; process.disconnect();
    }
  });
  await send({ kind: 'ready', origin: `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`,
    listeners: listeners(runtime),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, requestedTimezone: process.env.TZ, dates });
} catch (error) {
  await send({ kind: 'failure', error: payload(error) });
  await runtime?.close(); process.exitCode = 1; process.disconnect();
}
