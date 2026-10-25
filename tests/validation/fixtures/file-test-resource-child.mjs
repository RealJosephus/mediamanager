import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { declareFileTestResource } from '../../helpers/file-test-resource.js';

export const fileTestResourceChildFilename = fileURLToPath(import.meta.url);

async function run() {
  const options = JSON.parse(process.argv[2]), finishFinally = Promise.withResolvers();
  const send = value => new Promise((resolve, reject) => process.send({ ...value, pid: process.pid }, error => error ? reject(error) : resolve()));
  process.on('message', command => {
    if (command.action === 'finish-finally' || command.action === 'cancel') finishFinally.resolve();
  });
  process.once('disconnect', () => finishFinally.resolve());
  await send({ event: 'attempting', resource: options.resource });
  // Observe root teardown before the resource hook waits for a timed-out body.
  after(() => send({ event: 'after-entered' }));
  const resource = declareFileTestResource(options.resource, {
    onWait: owner => send({ event: 'waiting', owner }),
  });
  after(async () => { await send({ event: 'after-finished' }); process.disconnect(); });
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
