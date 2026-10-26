import { startProductionInstance } from '../../src/main.js';
import { errorObservation } from './error-observation.js';

let application, starting, closing;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const close = () => closing ??= (async () => {
  try { application ??= await starting; } catch { /* Startup owns its failure cleanup. */ }
  await application?.close();
  return { type: 'closed', pid: process.pid,
    listenersClosed: application?.networkHost.listeners.every(listener => !listener.server.listening) ?? true };
})();

process.on('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
process.on('message', message => {
  if (message.type !== 'close') return;
  void (async () => {
    await send(await close());
    if (process.connected) process.disconnect();
  })().catch(async error => {
    process.exitCode = 1;
    if (process.connected) {
      await send({ type: 'failure', error: errorObservation(error) }).catch(() => {});
      process.disconnect();
    }
  });
});

try {
  starting = startProductionInstance({ environment: process.env, onError: async error => {
    if (process.connected) {
      try { await send({ type: 'runtime-error', at: new Date().toISOString(), error: errorObservation(error) }); }
      catch (reportingError) { console.error(error); console.error(reportingError); }
    } else console.error(error);
  } });
  application = await starting;
  if (!process.connected || closing) await close();
  else await send({ type: 'ready', pid: process.pid, serverId: application.serverId,
    schema: application.store.database.schemaName,
    listeners: application.networkHost.listeners.map(({ scheme, address, port }) => ({ scheme, address, port })) });
} catch (error) {
  await close().catch(() => {});
  if (process.connected) await send({ type: 'failure', error: errorObservation(error) }).catch(() => {});
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
