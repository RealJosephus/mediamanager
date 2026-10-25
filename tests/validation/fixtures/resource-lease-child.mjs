import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireTestResource } from '../../helpers/test-resource-lease.js';

export const resourceLeaseChildFilename = fileURLToPath(import.meta.url);

async function run() {
  const options = JSON.parse(process.argv[2]);
  const controller = new AbortController(), commands = [], waiting = [];
  const send = value => new Promise((resolve, reject) => process.send({ ...value, pid: process.pid }, error => error ? reject(error) : resolve()));
  const next = () => commands.length ? Promise.resolve(commands.shift())
    : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  process.on('message', command => {
    if (command.action === 'cancel') { controller.abort(); return; }
    if (command.action === 'crash') process.exit(23);
    if (waiting.length) waiting.shift().resolve(command); else commands.push(command);
  });
  process.once('disconnect', () => {
    controller.abort();
    for (const pending of waiting.splice(0)) pending.reject(new Error('The resource lease test parent disconnected.'));
  });
  const receive = async expected => {
    const command = await next();
    if (command.action !== expected) throw new Error('Unexpected child command: ' + command.action);
  };
  await send({ event: 'attempting', resource: options.resource });
  try {
    const lease = await acquireTestResource(options.resource, { signal: controller.signal,
      onWait: owner => send({ event: 'waiting', owner }) });
    if (options.mode === 'hooks') {
      const { default: test, after } = await import('node:test');
      after(async () => {
        await send({ event: 'file-cleanup-start', owner: lease.owner });
        await receive('finish-file-cleanup');
        const state = JSON.parse(await readFile(options.stateFile, 'utf8'));
        if (!state.testCleanupFinished) throw new Error('The test cleanup did not precede file cleanup.');
        await writeFile(options.stateFile, JSON.stringify({ ...state, fileCleanupFinished: true }));
        await send({ event: 'file-cleanup-finished' });
      });
      test('the resource remains owned through body and file cleanup hooks', async t => {
        const server = createServer();
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        t.after(async () => {
          await send({ event: 'test-cleanup-start', port });
          await receive('finish-test-cleanup');
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          const rebound = createServer();
          await new Promise((resolve, reject) => rebound.once('error', reject).listen(port, '127.0.0.1', resolve));
          await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
          await writeFile(options.stateFile, JSON.stringify({ testCleanupFinished: true, portRebound: true }));
          await send({ event: 'test-cleanup-finished', port });
        });
        await send({ event: 'body-finished', owner: lease.owner, port });
      });
      // This is the final root hook, just as in the real entry files.
      after(async () => {
        await lease.release();
        await send({ event: 'released' });
        process.disconnect();
      });
      return;
    }
    let critical;
    if (options.criticalFile) {
      critical = await open(options.criticalFile, 'wx');
      await critical.writeFile(JSON.stringify({ pid: process.pid, resource: options.resource }));
    }
    await send({ event: 'acquired', owner: lease.owner });
    for (;;) {
      const command = await next();
      if (command.action === 'exit') { process.disconnect(); return; }
      if (command.action !== 'release' && command.action !== 'release-again') throw new Error('Unexpected child command: ' + command.action);
      if (critical) { await critical.close(); critical = undefined; await unlink(options.criticalFile); }
      await lease.release();
      await send({ event: command.action === 'release' ? 'released' : 'released-again' });
    }
  } catch (error) {
    await send({ event: 'failed', cancelled: controller.signal.aborted,
      error: { code: error.code ?? null, name: error.name, message: error.message, owner: error.owner ?? null } });
    process.disconnect();
  }
}

if (process.argv[1] === resourceLeaseChildFilename) await run();
