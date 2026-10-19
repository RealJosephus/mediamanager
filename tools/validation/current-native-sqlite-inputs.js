import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeFile } from './inventory.js';
import { nativeInstanceInputs } from './native-instance-inputs.js';
import { pinnedNativeSqliteMigrationHistory, pinnedNativeSqliteSchemaFingerprint } from '../../src/database/native-envelope.js';

/** A new same-run input. Historical SQLite paths and pins are never remapped. */
export async function currentNativeSqliteInputs(environment = process.env) {
  if (environment.MEDIAMANAGER_CI_NATIVE_SQLITE !== 'true' || environment.MEDIAMANAGER_CI_NATIVE_INSTANCE !== 'true') {
    throw new Error('Current native SQLite provisioning requires explicit native SQLite and instance provisioning.');
  }
  if (!environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE || !environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON) {
    throw new Error('Current native SQLite provisioning requires its database and mount contract.');
  }
  const supplied = await nativeInstanceInputs(environment);
  const root = path.join(path.dirname(supplied.root), 'mediamanager-current-sqlite', 'input');
  const filename = path.join(root, 'input.db');
  if (path.resolve(environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE) !== filename) {
    throw new Error('Current native SQLite consumers must use the same-run supplied copy.');
  }
  const inputs = [...supplied.inputs];
  const bind = async (filename, expectedSha256, expectedBytes) => {
    const value = await describeFile(filename);
    if (!value.available || value.kind !== 'file' || expectedSha256 && value.sha256 !== expectedSha256
      || expectedBytes !== undefined && value.bytes !== expectedBytes) {
      throw new Error(`Current native SQLite input is missing or changed: ${filename}`);
    }
    inputs.push({ filename, sha256: value.sha256 });
    return value;
  };
  const receiptFile = path.join(root, 'receipt.json');
  await bind(receiptFile);
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  const producer = fileURLToPath(new URL('../compat/prepare-current-sqlite.mjs', import.meta.url));
  const initializationFile = path.join(supplied.root, 'empty', 'initialization.json');
  const expectedHistoryIds = pinnedNativeSqliteMigrationHistory.map(row => row.MigrationId);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'current-stopped-native-sqlite'
    || receipt.historicalEvidenceReplaced !== false || receipt.sourceUnchanged !== true || receipt.credentialsRecorded !== false
    || receipt.producer?.filename !== producer || !digest(receipt.producer.sha256)
    || receipt.initialization?.filename !== initializationFile || !digest(receipt.initialization.sha256)
    || JSON.stringify(receipt.build) !== JSON.stringify(supplied.initialization.build)
    || receipt.source?.filename !== supplied.initialization.database.filename
    || receipt.source.filename !== path.join(supplied.initialization.root, 'data', 'data', 'jellyfin.db')
    || receipt.source.sha256 !== supplied.initialization.database.sha256
    || !digest(receipt.source.sha256) || !Number.isSafeInteger(receipt.source.bytes) || receipt.source.bytes <= 0
    || receipt.input?.filename !== filename || receipt.input.sha256 !== receipt.source.sha256
    || receipt.input.bytes !== receipt.source.bytes
    || !digest(receipt.schema?.fingerprint) || receipt.schema.canonicalFingerprint !== pinnedNativeSqliteSchemaFingerprint
    || !Array.isArray(receipt.schema.ddl) || !receipt.schema.ddl.length || receipt.schema.ddl.some(value => typeof value !== 'string')
    || !Array.isArray(receipt.schema.history)
    || receipt.schema.history.some(row => typeof row.ProductVersion !== 'string' || !row.ProductVersion)
    || JSON.stringify(receipt.schema.history.map(row => row.MigrationId)) !== JSON.stringify(expectedHistoryIds)
    || JSON.stringify(receipt.mountContract) !== '{"mounts":[]}'
    || JSON.stringify(JSON.parse(environment.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON)) !== JSON.stringify(receipt.mountContract)) {
    throw new Error('Current native SQLite receipt does not bind the original stopped source and unchanged schema/history.');
  }
  await bind(producer, receipt.producer.sha256, receipt.producer.bytes);
  await bind(initializationFile, receipt.initialization.sha256, receipt.initialization.bytes);
  await bind(receipt.source.filename, receipt.source.sha256, receipt.source.bytes);
  await bind(filename, receipt.input.sha256, receipt.input.bytes);
  const directory = await describeFile(root);
  if (!directory.available || directory.kind !== 'directory') throw new Error('Current native SQLite supply requires an ordinary input directory without links.');
  inputs.push({ filename: root, sha256: directory.entriesSha256 });
  return { root, filename, receipt, initialization: supplied.initialization, inputs };
}
