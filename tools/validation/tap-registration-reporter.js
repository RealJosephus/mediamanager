import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tap } from 'node:test/reporters';

function logicalPath(filename, root) {
  return path.relative(root, filename).replaceAll('\\', '/');
}

export default async function* registrationReporter(source) {
  const output = process.env.MEDIAMANAGER_TEST_REGISTRATION_OUTPUT;
  const root = process.env.MEDIAMANAGER_TEST_REGISTRATION_ROOT;
  const selected = JSON.parse(process.env.MEDIAMANAGER_TEST_REGISTRATION_SELECTED || '[]');
  if (!output || !root || !Array.isArray(selected)) throw new Error('Registration reporter environment is incomplete.');
  const selectedSet = new Set(selected);
  const registrations = new Map(selected.map(filename => [filename, 0]));
  async function* observed() {
    for await (const event of source) {
      if (event.type === 'test:enqueue' && event.data?.file) {
        const filename = logicalPath(event.data.file, root);
        const eventName = path.isAbsolute(event.data.name) ? logicalPath(event.data.name, root)
          : String(event.data.name).replaceAll('\\', '/');
        const syntheticFileWrapper = selectedSet.has(filename) && event.data.line === 1 && event.data.column === 1
          && eventName === filename;
        if (selectedSet.has(filename) && !syntheticFileWrapper) {
          registrations.set(filename, registrations.get(filename) + 1);
        }
      }
      yield event;
    }
  }
  try { yield* tap(observed()); }
  finally {
    const files = [...registrations].map(([filename, count]) => ({ path: filename, registrations: count }));
    const result = { schemaVersion: 1, files, missing: files.filter(entry => entry.registrations === 0).map(entry => entry.path) };
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
}
