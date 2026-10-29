import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageRegistry, VirtualFileSystem } from '../../../../src/storage/index.js';
import { LocalAdapter } from '../../../../plugins/local/adapter.js';
import { errorObservation } from '../../../helpers/error-observation.js';

const escapeSegment = value => encodeURIComponent(value).replace(/[!'()*]/gu,
  character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const proxyPath = filename => '/d/' + filename.replaceAll('\\', '/').split('/').map(escapeSegment).join('/').replace(/^\//u, '');

/** The designated source redirects ordinary local VOB inputs through port 5244. */
export async function startDvdMediaProxy(disc, manifest) {
  const registry = new StorageRegistry(); registry.registerType('original-dvd-local', config => LocalAdapter.open(config));
  await registry.createInstance('disc', 'original-dvd-local', { root: disc, writable: false });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/original', instanceId: 'disc', capabilities: {} });
  const targets = new Map(manifest.filter(file => file.type === 'file').map(file =>
    [proxyPath(path.join(disc, ...file.path.split('/'))), file]));
  const report = { port: 5244, requests: [], errors: [], closed: false, registryClosed: false };
  const work = new Set(), controllers = new Set(); let closing;
  const server = createServer((request, response) => {
    const observation = { phase: report.phase, method: request.method, url: request.url, range: request.headers.range ?? null };
    report.requests.push(observation);
    const controller = new AbortController(); controllers.add(controller);
    const disconnected = () => { if (!response.writableFinished) controller.abort(new Error('The actual Native media consumer disconnected.')); };
    response.once('close', disconnected);
    const task = (async () => {
      let handle, failure, sourceFailure;
      try {
        const target = targets.get(request.url);
        if (!target) { observation.status = 404; response.writeHead(404, { 'Content-Length': 0 }); response.end(); return; }
        assert.ok(['GET', 'HEAD'].includes(request.method), 'The original DVD bridge accepts only actual read requests.');
        observation.file = target.path;
        handle = await vfs.openResponse('/original/' + target.path, { signal: controller.signal, rangeHeader: request.headers.range });
        observation.handleOpened = true; observation.status = handle.statusCode;
        observation.headers = { ...handle.headers, 'content-type': 'application/octet-stream', connection: 'close' };
        observation.contentLength = handle.contentLength; observation.originalBytes = target.bytes; observation.originalSha256 = target.sha256;
        response.writeHead(handle.statusCode, observation.headers);
        if (request.method === 'HEAD') { response.end(); observation.readBytes = 0; return; }
        const digest = createHash('sha256'); let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, next) { digest.update(chunk); bytes += chunk.length; next(null, chunk); } });
        const source = Readable.from(handle.stream);
        source.once('error', error => { if (!controller.signal.aborted) sourceFailure = error; });
        try {
          await pipeline(source, meter, response, { signal: controller.signal });
          observation.responseCompleted = true;
        } finally { observation.readBytes = bytes; observation.readSha256 = digest.digest('hex'); }
      } catch (error) {
        if (controller.signal.aborted && !sourceFailure) observation.cancelledByConsumer = true;
        else { failure = sourceFailure ?? error; observation.error = errorObservation(failure); report.errors.push(observation.error); }
        if (!response.destroyed) response.destroy(error);
      } finally {
        try { if (handle) { await handle.close(); observation.handleClosed = true; } }
        catch (error) { observation.closeError = errorObservation(error); report.errors.push(observation.closeError); failure ??= error; }
        controllers.delete(controller); response.removeListener('close', disconnected);
        if (failure) throw failure;
      }
    })();
    work.add(task); void task.finally(() => work.delete(task)).catch(() => {});
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject).listen(5244, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await registry.close(); throw error; }
  server.on('error', error => report.errors.push(errorObservation(error)));
  return { report, async close() {
    return closing ??= (async () => {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const controller of controllers) controller.abort(new Error('The owned DVD bridge is closing.'));
      server.closeAllConnections(); await stopped;
      while (work.size) await Promise.allSettled([...work]);
      await registry.close(); report.registryClosed = true; report.closed = !server.listening;
      assert.equal(report.closed, true); assert.ok(report.requests.every(request => !request.handleOpened || request.handleClosed === true));
      assert.deepEqual(report.errors, []);
    })();
  } };
}
