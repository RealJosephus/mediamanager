import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase, inspectSqliteSchema } from '../../src/database/sqlite.js';
import { assertPinnedNativeEnvelope } from '../../src/database/native-envelope.js';
import { getNativeEnvelope } from '../../src/migration/database-transfer.js';
import { describeFile, sha256 } from '../validation/inventory.js';
import { nativeInstanceInputs } from '../validation/native-instance-inputs.js';
import { assertFreshReferenceOutput } from './reference-inputs.js';

const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error('Usage: node tools/compat/prepare-current-sqlite.mjs NEW_OUTPUT_DIRECTORY');
if (process.env.MEDIAMANAGER_CI_NATIVE_SQLITE !== 'true' || process.env.MEDIAMANAGER_CI_NATIVE_INSTANCE !== 'true') {
  throw new Error('Current SQLite supply requires explicit native SQLite and instance provisioning.');
}
const supplied = await nativeInstanceInputs();
const root = path.resolve(destination);
if (root !== path.join(path.dirname(supplied.root), 'mediamanager-current-sqlite', 'input')) {
  throw new Error('Current SQLite supply must use the isolated same-run SQLite evidence root.');
}
assertFreshReferenceOutput(root, [path.join(supplied.root, 'empty'), path.join(supplied.root, 'seeded')]);
const source = supplied.initialization.database.filename;
if (source !== path.join(supplied.initialization.root, 'data', 'data', 'jellyfin.db')) {
  throw new Error('Current SQLite supply requires the original stopped empty instance database.');
}
// Copy the stopped database bytes, never checkpoint or sanitize the source.
for (const suffix of ['-wal', '-journal']) {
  const companion = await describeFile(source + suffix);
  if (companion.available && (companion.kind !== 'file' || companion.bytes !== 0)) {
    throw new Error('The stopped native database still has a nonempty journal.');
  }
  if (!companion.available && companion.errorCode) {
    throw new Error('The stopped native database journal cannot be inspected.');
  }
}
const bytes = await readFile(source);
if (sha256(bytes) !== supplied.initialization.database.sha256) throw new Error('The stopped native database changed before copying.');
await mkdir(root);
const filename = path.join(root, 'input.db');
await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
const database = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
let schema;
try {
  const canonical = assertPinnedNativeEnvelope(await getNativeEnvelope(database));
  const actual = inspectSqliteSchema(database.database);
  schema = { fingerprint: actual.fingerprint, canonicalFingerprint: canonical.fingerprint, ddl: actual.ddl,
    history: database.schema.history };
} finally { database.close(); }
const input = await describeFile(filename);
if (input.sha256 !== supplied.initialization.database.sha256) throw new Error('The supplied SQLite bytes differ from the stopped source.');
const after = await nativeInstanceInputs();
if (JSON.stringify(after.inputs) !== JSON.stringify(supplied.inputs)) throw new Error('Native instance inputs changed while preparing SQLite supply.');
const receipt = { schemaVersion: 1, kind: 'current-stopped-native-sqlite', historicalEvidenceReplaced: false,
  producer: await describeFile(fileURLToPath(import.meta.url)),
  initialization: await describeFile(path.join(supplied.root, 'empty', 'initialization.json')),
  build: supplied.initialization.build, source: { filename: source, sha256: supplied.initialization.database.sha256, bytes: bytes.length },
  input: { filename, sha256: input.sha256, bytes: input.bytes }, schema,
  mountContract: { mounts: [] }, sourceUnchanged: true, credentialsRecorded: false,
  limitations: ['Current empty-instance database; not a historical query recording or production-scale migration.'] };
await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ filename, sha256: input.sha256, migrationHistory: schema.history.length, sourceUnchanged: true }));
