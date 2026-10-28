import path from 'node:path';
import { startProductionInstance } from '../../src/main.js';

let application, starting, closing;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const close = () => closing ??= (async () => {
  try { application ??= await starting; } catch { /* Startup owns its failure cleanup. */ }
  await application?.close();
  return { type: 'closed', listenersClosed: application?.networkHost.listeners.every(listener => !listener.server.listening) ?? true };
})();
const describe = () => ({ type: 'ready', schema: application.store.database.schemaName, serverId: application.serverId,
  instancePath: path.dirname(application.library.options.programDataPath),
  port: application.networkHost.listeners.find(listener => listener.scheme === 'http').port });
process.on('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
process.on('message', async message => {
  try {
    await starting;
    if (message.type === 'inspect') await send(describe());
    else if (message.type === 'close') { await send(await close()); process.disconnect(); }
  } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
});
try {
  starting = startProductionInstance({ environment: process.env });
  application = await starting;
  if (!process.connected || closing) { await close(); if (process.connected) process.disconnect(); }
  else await send(describe());
} catch (error) {
  await close().catch(() => {});
  if (process.connected) await send({ type: 'failure', message: error.message.replace(/\bpostgres(?:ql)?:\/\/[^\s"']+/giu, 'postgresql://[REDACTED]') });
  process.exitCode = 1; if (process.connected) process.disconnect();
}
