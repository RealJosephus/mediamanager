import { startProductionInstance } from '../../src/main.js';
import { errorObservation } from './error-observation.js';

const reports = [], originalError = console.error;
// Observe the real default production logger while retaining native stderr.
console.error = (...args) => {
  reports.push({ at: new Date().toISOString(), arguments: args.map(value => ({
    type: typeof value, value: errorObservation(value),
  })) });
  originalError(...args);
};
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
let application, starting, closing;
const close = () => closing ??= (async () => {
  try { application ??= await starting; } catch { /* Startup owns its failure cleanup. */ }
  await application?.close();
  return { type: 'closed', pid: process.pid, reports,
    listenersClosed: application?.networkHost.listeners.every(listener => !listener.server.listening) ?? true,
    databaseClosed: application?.store.database.closed ?? true };
})();

process.on('disconnect', () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
process.on('message', message => {
  void (async () => {
    await starting;
    if (message.type === 'inspect') {
      await application.drainRequests();
      await send({ type: 'observed', id: message.id, reports });
    } else if (message.type === 'close') {
      await send(await close());
      if (process.connected) process.disconnect();
    }
  })().catch(async error => {
    console.error(error);
    process.exitCode = 1;
    await close().catch(() => {});
    if (process.connected) {
      await send({ type: 'failure', error: errorObservation(error) }).catch(() => {});
      process.disconnect();
    }
  });
});

try {
  starting = startProductionInstance({ environment: process.env });
  application = await starting;
  if (!process.connected || closing) await close();
  else await send({ type: 'ready', pid: process.pid, serverId: application.serverId,
    schema: application.store.database.schemaName,
    port: application.networkHost.listeners.find(listener => listener.scheme === 'http').port });
} catch (error) {
  console.error(error);
  await close().catch(() => {});
  if (process.connected) await send({ type: 'failure', error: errorObservation(error) }).catch(() => {});
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
