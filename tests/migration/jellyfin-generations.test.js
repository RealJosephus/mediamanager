import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { canonicalNativeSqliteSchema, preflightSqlite } from '../../src/database/sqlite-schema.js';
import {
  assertPinnedNativeEnvelope,
  pinnedNativeSqliteMigrationHistory,
} from '../../src/database/native-envelope.js';
import { currentFingerprint, previousFingerprint } from '../../src/database/jellyfin-generations.js';

const retired = ['20260206200000_FixLibrarySubtitleDownloadLanguages', '20260910120000_MigrateRatingLevels'];
const recent = new Set([
  '20260912120000_HarmonizeConflictingUserData',
  '20260915104305_FixNullEncoderPreset',
  '20260927120000_FixLibrarySubtitleDownloadLanguages',
  '20260928120000_MigrateRatingLevels',
  '20261002210711_MakeOwnerIdIndexesPartial',
  '20261024092111_CoverAncestorIdsParentIndex',
]);
const current = pinnedNativeSqliteMigrationHistory.map((r) => r.MigrationId);
const old = [...current.filter((id) => !recent.has(id)), ...retired].sort();
const upgraded = [...current, ...retired].sort();
for (const [name, fingerprint, ids, count] of [
  ['previous', previousFingerprint, old, 102],
  ['fresh', currentFingerprint, current, 106],
  ['upgraded', currentFingerprint, upgraded, 108],
]) {
  test('Jellyfin ' + name + ' retains its complete schema, history and per-row version', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const schema = canonicalNativeSqliteSchema(fingerprint);
      for (const sql of schema.ddl.filter((s) => s.startsWith('CREATE TABLE'))) db.exec(sql);
      for (const sql of schema.ddl.filter((s) => !s.startsWith('CREATE TABLE'))) db.exec(sql);
      const insert = db.prepare('INSERT INTO __EFMigrationsHistory VALUES (?,?)');
      ids.forEach((id, i) => insert.run(id, i % 2 ? '13.0.0.0' : '10.0.11'));
      const source = preflightSqlite(db, { requireMigrationHistory: true });
      assert.equal(source.history.length, count);
      assert.equal(source.canonicalFingerprint, fingerprint);
      const envelope = { ...schema, history: source.history, sqliteSequence: [] };
      assert.deepEqual(
        assertPinnedNativeEnvelope(envelope).history,
        source.history.map((row) => ({ ...row })),
      );
      assert.throws(
        () => assertPinnedNativeEnvelope({ ...envelope, history: source.history.slice(1) }),
        /complete pinned/,
      );
      assert.throws(
        () =>
          assertPinnedNativeEnvelope({
            ...envelope,
            fingerprint: fingerprint === previousFingerprint ? currentFingerprint : previousFingerprint,
          }),
        /complete pinned/,
      );
    } finally {
      db.close();
    }
  });
}
