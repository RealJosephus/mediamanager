import { isDeepStrictEqual } from 'node:util';
import { databaseDigest, getNativeEnvelope } from './database-transfer.js';
import { createSqliteExportPathProjector, rewriteSqliteExportPaths } from './sqlite-export-paths.js';

/** Project only native instance-owned path roles in a private SQLite copy.
 * The captured package and its source database remain immutable. */
export async function projectRestoredDatabasePaths(database, {
  portableMountContract, sourceInstanceStatePaths, targetInstanceStatePaths, signal,
}) {
  if (database?.dialect !== 'sqlite' || database.readOnly) throw new TypeError('Restore path projection requires a private writable SQLite copy');
  const options = { sourceContract: portableMountContract, targetContract: portableMountContract,
    instanceStatePaths: sourceInstanceStatePaths, targetInstanceStatePaths: targetInstanceStatePaths, signal };
  const projector = createSqliteExportPathProjector(options);
  const envelope = await getNativeEnvelope(database);
  const expectedTables = await databaseDigest(database, { rowTransform: projector.projectRow, signal });
  const pathProjection = await rewriteSqliteExportPaths(database, options);
  const tables = await databaseDigest(database, { signal });
  if (!isDeepStrictEqual(tables, expectedTables) || !isDeepStrictEqual(pathProjection, projector.statistics())) {
    throw new Error('Restored database differs from its declared native instance path projection');
  }
  if (!isDeepStrictEqual(await getNativeEnvelope(database), envelope)) {
    throw new Error('Restore path projection changed the native schema, migration history or sequence high-water marks');
  }
  return { sourceInstanceStatePaths, targetInstanceStatePaths, pathProjection, tables };
}
