import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tap } from 'node:test/reporters';

function logicalPath(filename, root) {
  return path.relative(root, filename).replaceAll('\\', '/');
}

export const progressPrefix = '[mediamanager-test-progress] ';
export const progressLineLimit = 2048;

// Keep names, diagnostics, errors and arbitrary stdout/stderr exclusively in TAP.
// The same validator is used before emitting and before forwarding progress.
export function progressRecord(value, selected) {
  if (!value || !['start', 'passed', 'failed', 'skipped', 'todo'].includes(value.event)
    || !['file', 'test'].includes(value.kind) || typeof value.file !== 'string'
    || value.file.length > 1024 || !selected.has(value.file)
    || !Number.isSafeInteger(value.line) || value.line < 0
    || !Number.isSafeInteger(value.column) || value.column < 0) return null;
  const result = { event: value.event, kind: value.kind, file: value.file, line: value.line, column: value.column };
  if (Number.isFinite(value.durationMs) && value.durationMs >= 0) result.durationMs = Math.round(value.durationMs);
  return result;
}

export function testProgress(event, root, selected) {
  const data = event.data;
  if (!['test:dequeue', 'test:complete'].includes(event.type) || data?.nesting !== 0 || !data.file) return null;
  const filename = logicalPath(data.file, root);
  const eventName = path.isAbsolute(data.name) ? logicalPath(data.name, root)
    : String(data.name).replaceAll('\\', '/');
  const kind = data.line === 1 && data.column === 1 && eventName === filename ? 'file' : 'test';
  const state = event.type === 'test:dequeue' ? 'start' : data.skip ? 'skipped' : data.todo ? 'todo'
    : data.details?.passed === true ? 'passed' : 'failed';
  return progressRecord({ event: state, kind, file: filename, line: data.line ?? 0, column: data.column ?? 0,
    ...(event.type === 'test:complete' ? { durationMs: data.details?.duration_ms } : {}) }, selected);
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
      if (process.env.GITHUB_ACTIONS === 'true') {
        const progress = testProgress(event, root, selectedSet);
        if (progress) {
          const line = progressPrefix + JSON.stringify(progress) + '\n';
          if (line.length <= progressLineLimit) process.stderr.write(line);
        }
      }
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
