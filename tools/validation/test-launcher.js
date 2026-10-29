import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import registrationReporter, { progressLineLimit, progressPrefix, testProgress } from './tap-registration-reporter.js';
import { readTestSelection } from './test-selection.js';
import { fileTestDiagnostics } from './file-test-diagnostics.js';

export function observeFileFailures(source, files, { environment = process.env, write = text => process.stderr.write(text) } = {}) {
  const root = environment.MEDIAMANAGER_TEST_REGISTRATION_ROOT;
  if (environment.GITHUB_ACTIONS !== 'true' || !root || !path.isAbsolute(root)) return () => {};
  const selected = new Set(files.map(filename => path.relative(root, path.resolve(root, filename)).replaceAll('\\', '/')));
  const listener = data => {
    try {
      if (data?.details?.passed !== false || (data.skip !== undefined && data.skip !== false)
        || (data.todo !== undefined && data.todo !== false)) return;
      const record = testProgress({ type: 'test:complete', data }, root, selected);
      if (record?.kind !== 'file' || record.event !== 'failed') return;
      // Only the direct native listener confirms passed=false. Ordered reporter
      // output can remain buffered behind an unfinished earlier file.
      const line = progressPrefix + JSON.stringify({ ...record, passed: false }) + '\n';
      if (line.length <= progressLineLimit) write(line);
    } catch { /* Observability cannot replace native execution or its outcome. */ }
  };
  source.on('test:complete', listener);
  return () => source.removeListener('test:complete', listener);
}

export async function launchSelectedTests(filename, expectedSha256) {
  const selection = await readTestSelection(filename, expectedSha256);
  const diagnostics = await fileTestDiagnostics(selection.files);
  const source = run({ files: selection.files, concurrency: selection.concurrency, isolation: 'process', forceExit: false });
  const stopObserving = observeFileFailures(source, selection.files);
  diagnostics.observe(source);
  source.on('test:summary', summary => { if (!summary.success) process.exitCode = 1; });
  try { await pipeline(source, registrationReporter, process.stdout); }
  finally { stopObserving(); await diagnostics.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchSelectedTests(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
}
