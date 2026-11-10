import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

const eventTypes = ['test:enqueue', 'test:dequeue', 'test:start', 'test:complete', 'test:pass', 'test:fail',
  'test:plan', 'test:diagnostic', 'test:stdout', 'test:stderr', 'test:summary'];
const inspection = { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false, getters: false };
const batchLimit = 256 * 1024;

/** Preserve independently delivered native file completions even when another
 * file holds the ordered TAP stream. These artifacts never decide acceptance. */
export async function fileTestDiagnostics(files, environment = process.env) {
  const root = environment.MEDIAMANAGER_TEST_FILE_DIAGNOSTICS_ROOT;
  const repository = environment.MEDIAMANAGER_TEST_REGISTRATION_ROOT;
  const empty = { observe() {}, async close() {} };
  if (!root || !repository || !path.isAbsolute(root) || !path.isAbsolute(repository)) return empty;
  const entries = files.map((filename, index) => {
    const absolute = path.resolve(repository, filename);
    const logical = path.relative(repository, absolute).replaceAll('\\', '/');
    const directory = `${String(index + 1).padStart(4, '0')}-${createHash('sha256').update(logical).digest('hex').slice(0, 16)}`;
    return { path: logical, absolute, directory, tail: Promise.resolve(), sequence: 0, batch: new Map(), bytes: 0 };
  });
  try {
    await mkdir(root);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
      files: entries.map(({ path, directory }) => ({ path, directory })),
      boundary: 'Native file dequeue/complete events are immediate. Other events and stdout/stderr may remain buffered behind an unfinished earlier file. Missing output never proves that a file was silent, passed or released resources.',
    }, null, 2) + '\n', { flag: 'wx' });
    await Promise.all(entries.map(entry => mkdir(path.join(root, entry.directory))));
  } catch { return empty; }
  const selected = new Map(entries.map(entry => [entry.absolute, entry]));
  const listeners = [];
  const pending = new Set();
  let scheduled;
  const flush = entry => {
    const batch = entry.batch;
    entry.batch = new Map();
    entry.bytes = 0;
    pending.delete(entry);
    entry.tail = entry.tail.then(async () => {
      for (const [name, chunks] of batch) {
        await appendFile(path.join(root, entry.directory, name), Buffer.concat(chunks)).catch(() => {});
      }
    }).catch(() => {});
  };
  const flushPending = () => {
    scheduled = undefined;
    for (const entry of pending) flush(entry);
  };
  const enqueue = (entry, name, text) => {
    let chunks = entry.batch.get(name);
    if (!chunks) { chunks = []; entry.batch.set(name, chunks); }
    // Encode each event's output independently, as an individual append did.
    const chunk = Buffer.from(text);
    chunks.push(chunk);
    entry.bytes += chunk.length;
  };
  return {
    observe(source) {
      for (const type of eventTypes) {
        const listener = data => {
          if (typeof data?.file !== 'string') return;
          const entry = selected.get(path.resolve(repository, data.file));
          if (!entry) return;
          try {
            const record = { sequence: ++entry.sequence, at: new Date().toISOString(), type,
              native: inspect(data, inspection) };
            const text = JSON.stringify(record) + '\n';
            const message = ['test:stdout', 'test:stderr'].includes(type) && typeof data.message === 'string'
              ? data.message : null;
            enqueue(entry, 'events.jsonl', text);
            if (message !== null) enqueue(entry, type === 'test:stdout' ? 'stdout.txt' : 'stderr.txt', message);
            if (entry.bytes >= batchLimit) flush(entry);
            else {
              pending.add(entry);
              scheduled ??= setImmediate(flushPending);
            }
          } catch { /* Diagnostic inspection cannot replace a native event or its result. */ }
        };
        source.on(type, listener);
        listeners.push([source, type, listener]);
      }
    },
    async close() {
      for (const [source, type, listener] of listeners) source.removeListener(type, listener);
      clearImmediate(scheduled);
      flushPending();
      await Promise.all(entries.map(entry => entry.tail));
    },
  };
}
