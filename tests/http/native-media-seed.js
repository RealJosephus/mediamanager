import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeGuid } from '../../src/users/native.js';

/** Give bound synthetic media real private paths before native startup can
 * legitimately remove nonexistent sources during library validation. */
export async function prepareNativeMediaSeed(root, mediaRoot) {
  const source = new SqliteDatabase(path.join(root, 'data/data/jellyfin.db'), { requireMigrationHistory: true });
  try {
    const retained = path.join(mediaRoot, 'retained');
    const relocation = [
      { Id: nativeGuid('11111111-1111-1111-1111-111111111111'), previous: 'Z:\\SyntheticMedia', replacement: retained },
      { Id: nativeGuid('22222222-2222-2222-2222-222222222222'), previous: 'Z:\\SyntheticMedia\\feature.mkv', replacement: path.join(retained, 'feature.mkv') },
    ].map(entry => ({ ...entry, before: source.rows('BaseItems', { where: { Id: entry.Id } })[0] }));
    for (const entry of relocation) assert.equal(entry.before?.Path, entry.previous, 'The bound original seed must match before the first native startup.');
    await mkdir(retained, { recursive: true });
    const bytes = Buffer.from('Private retained original seed.\n');
    await writeFile(path.join(retained, 'feature.mkv'), bytes, { flag: 'wx' });
    source.transaction(() => { for (const entry of relocation) source.update('BaseItems', { Id: entry.Id }, { Path: entry.replacement }); });
    for (const entry of relocation) {
      entry.after = source.rows('BaseItems', { where: { Id: entry.Id } })[0];
      assert.equal(entry.after.Path, entry.replacement);
    }
    return { beforeFirstNativeStartup: true, files: { retainedSeed: path.join(retained, 'feature.mkv') }, relocation,
      file: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } finally { source.close(); }
}
