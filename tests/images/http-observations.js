import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

function valueOf(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => valueOf(entry, ancestors));
    const keys = value instanceof Error ? [...new Set(['name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors',
      ...Object.getOwnPropertyNames(value)])].filter(key => key in value) : Object.keys(value);
    return Object.fromEntries(keys.map(key => [key, valueOf(value[key], ancestors)]));
  } finally { ancestors.delete(value); }
}

export function imageHttpObservations(t, name) {
  const requests = [], failures = [];
  const report = { name, scope: 'Actual request results and unclassified errors, recorded before fixture owner cleanup.',
    requests, failures, phaseAcceptance: false, releaseAcceptance: false };
  t.after(async () => {
    const root = validationOutputRoot(); await mkdir(root, { recursive: true });
    const filename = assertValidationOutputChild(path.join(root, name + '-' + randomUUID() + '.json'));
    await writeFile(filename, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
  });
  return {
    report,
    onError(error) { failures.push({ pendingRequests: requests.filter(value => value.pending).map(value => value.index), error: valueOf(error) }); },
    async request(url, options, perform) {
      const observation = { index: requests.length, url, method: options?.method ?? 'GET',
        headers: options?.headers, body: options?.body, pending: true };
      requests.push(observation);
      try {
        const response = await perform(url, options);
        observation.response = { status: response.status, headers: response.headers,
          bytes: response.bytes.length, sha256: createHash('sha256').update(response.bytes).digest('hex'),
          base64: response.bytes.toString('base64') };
        return response;
      } catch (error) { observation.error = valueOf(error); throw error; }
      finally { observation.pending = false; }
    },
  };
}
