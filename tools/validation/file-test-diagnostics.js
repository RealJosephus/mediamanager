import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

const eventTypes = ['test:enqueue', 'test:dequeue', 'test:start', 'test:complete', 'test:pass', 'test:fail',
  'test:plan', 'test:diagnostic', 'test:stdout', 'test:stderr', 'test:summary'];
const inspection = { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false, getters: false };

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
    return { path: logical, absolute, directory, tail: Promise.resolve(), sequence: 0 };
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
            entry.tail = entry.tail.then(async () => {
              await appendFile(path.join(root, entry.directory, 'events.jsonl'), text);
              if (message !== null) await appendFile(path.join(root, entry.directory,
                type === 'test:stdout' ? 'stdout.txt' : 'stderr.txt'), message);
            }).catch(() => {});
          } catch { /* Diagnostic inspection cannot replace a native event or its result. */ }
        };
        source.on(type, listener);
        listeners.push([source, type, listener]);
      }
    },
    async close() {
      for (const [source, type, listener] of listeners) source.removeListener(type, listener);
      await Promise.all(entries.map(entry => entry.tail));
    },
  };
}
