import test, { after, before } from 'node:test';
import { open, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { declareFileTestResource } from '../../helpers/file-test-resource.js';

export const fileTestResourceChildFilename = fileURLToPath(import.meta.url);

async function run() {
  const options = JSON.parse(process.argv[2]), finishFinally = Promise.withResolvers(), finishBody = Promise.withResolvers();
  const send = value => new Promise((resolve, reject) => process.send({ ...value, pid: process.pid }, error => error ? reject(error) : resolve()));
  process.on('message', command => {
    if (command.action === 'finish-finally' || command.action === 'cancel') finishFinally.resolve();
    if (['release', 'cancel', 'exit'].includes(command.action)) finishBody.resolve();
  });
  process.once('disconnect', () => { finishFinally.resolve(); finishBody.resolve(); });
  await send({ event: 'attempting', resource: options.resource, resources: options.resources });
  // Observe root teardown before the resource hook waits for a timed-out body.
  after(() => send({ event: 'after-entered' }));
  if (options.resources) {
    const declarations = options.resources.map(value => typeof value === 'string' ? { key: value } : value);
    const resources = declarations.map(declaration => declareFileTestResource(declaration.key, {
      root: declaration.root, onWait: owner => send({ event: 'waiting', owner }),
    }));
    after(async () => { await send({ event: 'after-finished' }); process.disconnect(); });
    test('file admission owns its complete declared group through real critical work', { timeout: options.businessTimeout }, async t => {
      const protectedBody = async index => {
        if (index < resources.length) return resources[index].run(() => protectedBody(index + 1), { signal: t.signal });
        const owners = await Promise.all(declarations.map(async declaration => {
          const root = declaration.root ?? process.env.MEDIAMANAGER_TEST_RESOURCE_ROOT;
          const owner = JSON.parse(await readFile(path.join(root, declaration.key, 'owner.json'), 'utf8'));
          if (owner.pid !== process.pid || owner.resource !== declaration.key) {
            throw new Error('The admitted callback does not own its complete filesystem declaration set.');
          }
          return { root, key: declaration.key, owner };
        }));
        const critical = await open(options.criticalFile, 'wx');
        try {
          await critical.writeFile(JSON.stringify({ pid: process.pid, owners }));
          const actual = JSON.parse(await readFile(options.criticalFile, 'utf8'));
          if (actual.pid !== process.pid) throw new Error('The protected critical file belongs to another process.');
          await send({ event: 'body-started', owners });
          if (options.mode !== 'group-auto') await finishBody.promise;
        } finally {
          await critical.close();
          await unlink(options.criticalFile);
        }
        await send({ event: 'body-finished', owners });
      };
      await protectedBody(0);
    });
    return;
  }
  const resource = declareFileTestResource(options.resource, {
    onWait: owner => send({ event: 'waiting', owner }),
  });
  after(async () => { await send({ event: 'after-finished' }); process.disconnect(); });
  if (options.mode === 'initialization-failure') {
    before(async context => resource.run(async () => {
      const owner = JSON.parse(await readFile(path.join(process.env.MEDIAMANAGER_TEST_RESOURCE_ROOT, options.resource, 'owner.json'), 'utf8'));
      if (owner.pid !== process.pid) throw new Error('The initialization hook does not own its actual lease.');
      const listener = createServer(), critical = await open(options.criticalFile, 'wx'); let port;
      try {
        await critical.writeFile('Private initialization owner.');
        await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
        port = listener.address().port;
        await send({ event: 'initialization-started', owner, port });
        await finishBody.promise;
        throw new Error('Controlled Native initialization failed before candidate registration.');
      } finally {
        await send({ event: 'finally-entered', port, listening: listener.listening });
        await finishFinally.promise;
        await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        await critical.close(); await unlink(options.criticalFile);
        const rebound = createServer();
        await new Promise((resolve, reject) => rebound.once('error', reject).listen(port, '127.0.0.1', resolve));
        await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
        await send({ event: 'finally-completed', port, listening: listener.listening, portRebound: true, fileOwnerClosed: true });
      }
    }, { signal: context.signal }));
    test('candidate callbacks must not run after failed initialization', () => send({ event: 'unexpected-body-started' }));
    return;
  }
  test('file admission preserves its business timeout and actual cleanup ownership', { timeout: options.businessTimeout }, async t => resource.run(async () => {
    const owner = JSON.parse(await readFile(path.join(process.env.MEDIAMANAGER_TEST_RESOURCE_ROOT, options.resource, 'owner.json'), 'utf8'));
    if (owner.pid !== process.pid) throw new Error('The admitted callback does not own the filesystem lease.');
    if (options.mode === 'wait') {
      await send({ event: 'body-started', owner });
      await delay(25, undefined, { signal: t.signal });
      await send({ event: 'body-finished', owner });
      return;
    }
    const listener = createServer();
    let port;
    try {
      await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
      port = listener.address().port;
      await send({ event: 'body-started', owner, port });
      await new Promise(resolve => {
        t.signal.addEventListener('abort', resolve, { once: true });
        if (t.signal.aborted) resolve();
      });
    } finally {
      await send({ event: 'finally-entered', aborted: t.signal.aborted, port, listening: listener.listening });
      await finishFinally.promise;
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      const rebound = createServer();
      await new Promise((resolve, reject) => rebound.once('error', reject).listen(port, '127.0.0.1', resolve));
      await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
      await send({ event: 'finally-completed', port, listening: listener.listening, portRebound: true });
    }
  }, { signal: t.signal }));
}

if (process.argv[1] === fileTestResourceChildFilename) await run();
