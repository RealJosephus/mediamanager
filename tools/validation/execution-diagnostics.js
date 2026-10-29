import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const outputs = new Map();
let sequence = 0;

/** Only a repository-relative fixture identifier may enter diagnostics. */
export function diagnosticFixture(filename) {
  if (typeof filename !== 'string' || !filename) return undefined;
  const relative = path.relative(repository, path.resolve(repository, filename)).replaceAll('\\', '/');
  return /^(?:tests|tools)\/[A-Za-z0-9_./-]+$/u.test(relative)
    && !relative.split('/').includes('..') ? relative : undefined;
}

function details(value) {
  const result = {};
  for (const key of ['fixture', 'ownerFixture']) {
    const relative = diagnosticFixture(value[key]);
    if (relative) result[key] = relative;
  }
  for (const key of ['resource', 'inputKind']) {
    if (typeof value[key] === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(value[key])) result[key] = value[key];
  }
  if (Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0) result.ownerPid = value.ownerPid;
  if (['returned', 'threw', 'succeeded', 'failed', 'unknown'].includes(value.resultKind)) result.resultKind = value.resultKind;
  return result;
}

async function append(environment, record) {
  // This output is a sibling of the lease directory, never a sealed input or
  // a field in an oracle receipt, schema identity or provenance document.
  const root = environment.MEDIAMANAGER_TEST_DIAGNOSTICS_ROOT;
  if (typeof root !== 'string' || !path.isAbsolute(root)) return;
  try {
    let output = outputs.get(root);
    if (!output) {
      output = { ready: mkdir(root, { recursive: true }), tail: Promise.resolve() };
      // A failed diagnostic directory must not become an unhandled rejection.
      void output.ready.catch(() => {});
      outputs.set(root, output);
    }
    const text = JSON.stringify(record) + '\n';
    output.tail = output.tail.then(async () => {
      await output.ready;
      await appendFile(path.join(root, `process-${process.pid}.jsonl`), text);
    }).catch(() => {});
    await output.tail;
  } catch { /* Diagnostics cannot replace the operation's result or error. */ }
}

/** Independent timing observations; no record is an acceptance condition. */
export function executionObservation(stage, value = {}, environment = process.env) {
  const startedAt = new Date().toISOString(), started = performance.now(), observation = ++sequence;
  const context = details(value);
  return {
    async record(event, extra = {}) {
      await append(environment, { schemaVersion: 1, pid: process.pid, observation, stage, event,
        ...context, ...details(extra), startedAt, at: new Date().toISOString(),
        elapsedMs: performance.now() - started });
    },
  };
}

export async function observeExecutionPhase(stage, operation, { environment = process.env, resultKind, ...value } = {}) {
  const observation = executionObservation(stage, value, environment);
  await observation.record('started');
  try {
    const result = await operation();
    let kind = 'returned';
    try { if (resultKind) kind = resultKind(result); } catch { kind = 'unknown'; }
    await observation.record('completed', { resultKind: kind });
    return result;
  } catch (error) {
    await observation.record('failed', { resultKind: 'threw' });
    throw error;
  }
}
