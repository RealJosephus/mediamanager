import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { directory, exists, inventory, writeJson } from './files.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const seal = async (root) => digest(JSON.stringify(await inventory(root)));

// The operating system releases the SQLite lock when a process dies. The named
// lock file stays in place so all concurrent or later opens lock the same inode.
export async function openPublication(output, request) {
  const id = digest(process.platform === 'win32' ? output.toLowerCase() : output).slice(0, 32);
  const work = path.join(path.dirname(output), '.mm-exchange-' + id),
    lockName = work + '.sqlite';
  const file = await open(lockName, 'a', 0o600);
  await file.close();
  const info = await lstat(lockName);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid migration lock file');
  const db = new DatabaseSync(lockName);
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    const owner = path.join(work, 'request.json'),
      record = path.join(work, 'ready.json'),
      build = path.join(work, 'build'),
      target = path.join(build, 'target');
    const fingerprint = digest(JSON.stringify(request));
    const existing = await exists(work);
    if (existing) {
      await directory(work);
      if (await exists(owner)) {
        const previous = JSON.parse(await readFile(owner, 'utf8'));
        if (previous.output !== output || previous.fingerprint !== fingerprint)
          throw new Error('An unfinished migration with different inputs owns ' + work);
      } else if ((await readdir(work)).length) throw new Error('Unrecognized migration directory: ' + work);
    } else {
      if (await exists(output)) throw new Error('Output already exists: ' + output);
      await mkdir(work, { mode: 0o700 });
    }
    if (!(await exists(owner))) await writeJson(owner, { output, fingerprint });
    let pending = (await exists(record)) ? JSON.parse(await readFile(record, 'utf8')) : null;
    if (!pending) {
      if (await exists(output)) throw new Error('Output already exists: ' + output);
      if (await exists(build)) {
        await directory(build);
        await rm(build, { recursive: true });
      }
      await mkdir(build, { mode: 0o700 });
    }
    return {
      build,
      target,
      pending,
      async ready(result, inputHash) {
        const next = { result, inputHash, targetHash: await seal(target) };
        await writeJson(record + '.new', next);
        await rename(record + '.new', record);
        pending = next;
        return next;
      },
      async validate(p) {
        const targetExists = await exists(target),
          published = await exists(output);
        if (targetExists === published)
          throw new Error('Cannot determine which instance belongs to the prepared migration');
        const location = targetExists ? target : output;
        await directory(location);
        if ((await seal(location)) !== p.targetHash)
          throw new Error('Prepared migration files have changed: ' + location);
        return published;
      },
      async publish() {
        await rename(target, output);
      },
      async close(success) {
        try {
          if (success || !pending) {
            await directory(work);
            await rm(work, { recursive: true });
          }
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
