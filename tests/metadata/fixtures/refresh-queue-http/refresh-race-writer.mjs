import pg from 'pg';
import { nativeTextBytes, decodeNativeTextBytes } from '../../../../src/database/native-text.js';

const [location, itemId] = process.argv.slice(2);
if (!/^refresh_queue_[0-9]+_[0-9]+$/.test(location)) throw new TypeError('An isolated refresh test schema is required.');
const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`SET LOCAL search_path TO "${location}", pg_catalog`);
  await client.query('UPDATE "BaseItems" SET "Name" = $1 WHERE "Id" = $2', [nativeTextBytes('External process edit'), nativeTextBytes(itemId)]);
  await client.query('INSERT INTO "BaseItemProviders" ("ItemId", "ProviderId", "ProviderValue") VALUES ($1, $2, $3)', [nativeTextBytes(itemId), nativeTextBytes('External'), nativeTextBytes('Preserved')]);
  const name = (await client.query('SELECT "Name" FROM "BaseItems" WHERE "Id" = $1', [nativeTextBytes(itemId)])).rows[0].Name;
  await client.query('COMMIT');
  console.log(JSON.stringify({ pid: process.pid, name: decodeNativeTextBytes(name) }));
} finally { await client.end(); }
