import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { sha256 } from '../../tools/validation/inventory.js';
import { SqliteDatabase, inspectSqliteSchema } from '../../src/database/sqlite.js';
import { getNativeEnvelope } from '../../src/migration/database-transfer.js';

test('current SQLite supply retains stopped native bytes and actual schema/history without replacing historical evidence', {
  skip: !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE,
}, async t => {
  const supplied = await currentNativeSqliteInputs();
  assert.equal(supplied.receipt.historicalEvidenceReplaced, false);
  assert.equal(supplied.initialization.process.stopped, true);
  assert.equal(supplied.initialization.process.exitCode, 0);
  assert.notEqual(supplied.filename, supplied.receipt.source.filename);
  assert.equal(sha256(await readFile(supplied.filename)), supplied.initialization.database.sha256);
  assert.equal(supplied.receipt.source.sha256, supplied.receipt.input.sha256);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'current-native-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateCopy = path.join(directory, 'private.db');
  await copyFile(supplied.filename, privateCopy);
  const database = new SqliteDatabase(privateCopy, { readOnly: true, requireMigrationHistory: true });
  try {
    assert.equal((await getNativeEnvelope(database)).fingerprint, supplied.receipt.schema.canonicalFingerprint);
    const actual = inspectSqliteSchema(database.database);
    assert.equal(actual.fingerprint, supplied.receipt.schema.fingerprint);
    assert.deepEqual(actual.ddl, supplied.receipt.schema.ddl);
    assert.deepEqual(database.schema.history.map(row => ({ ...row })), supplied.receipt.schema.history);
    assert.equal(database.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
  assert.deepEqual((await currentNativeSqliteInputs()).inputs, supplied.inputs);
});
