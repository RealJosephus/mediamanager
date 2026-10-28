import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setImmediate as immediate } from 'node:timers/promises';

// A private durable conditional object service, not a production storage plugin.
const root = path.resolve(process.argv[2]);
const startup = process.argv[3] ?? 'normal';
if (!['normal', 'fail-after-listener', 'ready-with-descriptor'].includes(startup)) throw new Error('Unknown fixture startup control.');
await mkdir(root, { recursive: true });
const indexFile = path.join(root, 'objects.json');
let index = { revision: 0, objects: {} };
try { index = JSON.parse(await readFile(indexFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let writes = Promise.resolve(), closing, truncate;
const active = new Set(), descriptors = new Set(), initializationDescriptors = new Set(), journal = [];
const reply = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const hash = value => createHash('sha256').update(value).digest('hex');

async function durable(filename, bytes) {
  const file = await open(filename, 'wx'); descriptors.add(file);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { try { await file.close(); } finally { descriptors.delete(file); } }
}
function response(res, status, value, headers = {}) {
  const bytes = Buffer.from(value === undefined ? '' : JSON.stringify(value));
  res.writeHead(status, { 'Content-Length': bytes.length, ...headers }); res.end(bytes);
}
function versionMatches(requested, current) {
  return requested === '*' ? Boolean(current) : typeof requested === 'string' && current?.version === requested;
}

async function upload(req, res, key) {
  const current = index.objects[key];
  if (req.headers['if-none-match'] !== '*' && typeof req.headers['if-match'] !== 'string') {
    req.resume(); response(res, 428); return;
  }
  if (req.headers['if-none-match'] === '*' ? Boolean(current)
    : !versionMatches(req.headers['if-match'], current)) {
    req.resume(); response(res, 412); return;
  }
  const revision = index.revision + 1;
  const objectFile = hash(key) + '-' + revision + '.bin';
  const temporary = path.join(root, objectFile + '.tmp'), filename = path.join(root, objectFile);
  const file = await open(temporary, 'wx'); descriptors.add(file);
  let bytes = 0, committed = false;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new Error('The fixture object exceeds its explicit limit.');
      await file.writeFile(chunk);
    }
    if (bytes !== Number(req.headers['content-length'])) throw new Error('The fixture upload was truncated.');
    await file.sync(); await file.close(); descriptors.delete(file);
    await rename(temporary, filename);
    const next = { revision, objects: { ...index.objects, [key]: { filename: objectFile, bytes, version: '"generation-' + revision + '"' } } };
    const stagedIndex = path.join(root, 'objects-' + revision + '.tmp');
    await durable(stagedIndex, Buffer.from(JSON.stringify(next)));
    await rename(stagedIndex, indexFile); index = next; committed = true;
    response(res, current ? 200 : 201, { size: String(bytes), atomic: true, version: next.objects[key].version });
  } finally {
    try { await file.close(); } finally { descriptors.delete(file); }
    if (!committed) {
      await rm(temporary, { force: true });
      await rm(filename, { force: true });
      await rm(path.join(root, 'objects-' + revision + '.tmp'), { force: true });
    }
  }
}

async function serve(req, res) {
  const key = new URL(req.url, 'http://fixture.invalid').pathname;
  if (req.method === 'PUT') {
    const operation = writes.then(() => upload(req, res, key));
    writes = operation.catch(() => {}); await operation; return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { response(res, 405); return; }
  const entry = index.objects[key];
  if (!entry) { response(res, 404); return; }
  if (req.headers['if-match'] !== undefined && !versionMatches(req.headers['if-match'], entry)) { response(res, 412); return; }
  const headers = { ETag: entry.version, 'Content-Length': entry.bytes, 'Content-Type': 'application/octet-stream' };
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  const file = await open(path.join(root, entry.filename), 'r'); descriptors.add(file);
  try {
    res.writeHead(200, headers);
    if (truncate === key) {
      truncate = undefined;
      const prefix = Buffer.alloc(Math.min(7, entry.bytes)); await file.read(prefix, 0, prefix.length, 0);
      res.flushHeaders(); res.write(prefix); await immediate(); res.destroy();
    } else await pipeline(file.createReadStream(), res);
  } finally { try { await file.close(); } finally { descriptors.delete(file); } }
}

const server = createServer((req, res) => {
  const observation = { method: req.method, path: req.url, ifMatch: req.headers['if-match'] ?? null,
    ifNoneMatch: req.headers['if-none-match'] ?? null };
  journal.push(observation);
  const operation = serve(req, res).catch(error => {
    observation.failure = { code: error.code, message: error.message };
    if (res.headersSent) res.destroy(); else response(res, 500);
  }).finally(() => { observation.status = res.statusCode; active.delete(operation); });
  active.add(operation);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
// These explicit fixture-only controls open an actual file after the actual
// listener is live. Neither a failed admission nor business cancellation owns
// permission to forget this process and descriptor before a real close.
if (startup !== 'normal') {
  const file = await open(path.join(root, 'initialization-descriptor-' + process.pid + '.bin'), 'wx');
  descriptors.add(file); initializationDescriptors.add(file);
  await file.writeFile(Buffer.from('Actual initialization owner.\n'));
}
const snapshot = () => ({ requests: journal, activeRequests: active.size, openDescriptors: descriptors.size,
  objects: index.objects, revision: index.revision });
function close() {
  return closing ??= (async () => {
    const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections(); await stopped;
    await Promise.all([...active]); await writes;
    for (const file of initializationDescriptors) {
      await file.close(); descriptors.delete(file); initializationDescriptors.delete(file);
    }
    return { type: 'closed', port, ...snapshot() };
  })();
}
process.on('message', message => {
  void (async () => {
    if (message.type === 'truncate') { truncate = message.path; await reply({ type: 'truncate', path: truncate }); }
    else if (message.type === 'snapshot') await reply({ type: 'snapshot', ...snapshot() });
    else if (message.type === 'close') { await reply(await close()); process.disconnect(); }
  })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
});
process.on('disconnect', () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
await reply({ type: startup === 'fail-after-listener' ? 'initialization-failed' : 'ready', port, revision: index.revision,
  listenerListening: server.listening, openDescriptors: descriptors.size,
  ...(startup === 'fail-after-listener' ? { failure: { code: 'controlled-http-initialization' } } : {}) });
