import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const credentialFields = new Set(['AccessToken', 'Password', 'EasyPassword', 'Pw', 'NewPw', 'CurrentPw']);
const digest = value => createHash('sha256').update(value).digest('hex');
const credential = value => `[credential-sha256:${digest(String(value))}]`;

/** Preserve media observations; credentials are not public fixture data. */
export function filterEvidenceJson(value, secrets = new Set()) {
  const text = JSON.stringify(value, (key, entry) => {
    if (typeof entry === 'bigint') return entry.toString();
    if (credentialFields.has(key) && entry != null && entry !== '') {
      secrets.add(String(entry));
      return credential(entry);
    }
    return entry;
  }, 2) + '\n';
  return [...secrets].reduce((output, secret) => output.replaceAll(secret, credential(secret)), text);
}

/** A private working tree with an explicit report-only publication boundary. */
export async function createPrivateFilterOutput(destination) {
  const temporaryParent = path.resolve(tmpdir());
  const temporaryRoot = await mkdtemp(path.join(temporaryParent, 'mm-filter-reference-'));
  const root = path.join(temporaryRoot, 'recording'), secrets = new Set();
  return {
    root,
    addSecret(value) { if (value) secrets.add(String(value)); },
    publicError(error) {
      const message = [...secrets].reduce((text, secret) => text.replaceAll(secret, credential(secret)), String(error.message ?? error));
      return Object.assign(new Error(message), { name: error.name ?? 'Error', code: error.code });
    },
    async publishAndClose() {
      let reportCount = 0;
      try {
        await mkdir(destination);
        const entries = await readdir(root, { withFileTypes: true }).catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        const reports = new Map();
        for (const entry of entries) {
          if (!entry.isFile() || !/^[a-z][a-z0-9-]*\.(?:json|log)$/u.test(entry.name)) continue;
          const bytes = await readFile(path.join(root, entry.name), 'utf8');
          reports.set(entry.name, entry.name.endsWith('.json') ? JSON.parse(bytes) : bytes);
        }
        // Collect credential values before publishing any text or error log.
        for (const [name, value] of reports) if (name.endsWith('.json')) filterEvidenceJson(value, secrets);
        const artifacts = [];
        for (const [name, value] of reports) {
          if (name === 'provenance.json') continue;
          const text = name.endsWith('.json') ? filterEvidenceJson(value, secrets)
            : [...secrets].reduce((output, secret) => output.replaceAll(secret, credential(secret)), value);
          await writeFile(path.join(destination, name), text, { flag: 'wx' });
          artifacts.push({ path: name, sha256: digest(text) });
        }
        const provenance = reports.get('provenance.json');
        if (provenance) {
          provenance.artifacts = artifacts;
          provenance.publication = { privateInstanceIncluded: false, credentialFields: [...credentialFields],
            credentials: 'sha256-only', mediaObservationsUnchanged: true };
          await writeFile(path.join(destination, 'provenance.json'), filterEvidenceJson(provenance, secrets), { flag: 'wx' });
        }
        reportCount = reports.size;
      } finally {
        const relative = path.relative(temporaryParent, temporaryRoot);
        assert.ok(relative.startsWith('mm-filter-reference-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
        await rm(temporaryRoot, { recursive: true, force: false });
      }
      await writeFile(path.join(destination, 'private-cleanup.json'), JSON.stringify({ privateInstanceRemoved: true,
        publicFilesAreReportsOnly: true, reportCount }, null, 2) + '\n', { flag: 'wx' });
    },
  };
}
