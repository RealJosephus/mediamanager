import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { runEmby } from '../database/emby.js';
import { exportJellyfinSqlite } from '../database/export-jellyfin.js';

const [mode, ...args] = process.argv.slice(2);
const interrupt = () => process.exit(73);
if (mode === 'interrupt-export') {
  await exportJellyfinSqlite(args, { afterMainPublish: interrupt });
} else if (mode === 'interrupt-import') {
  await runEmby('import', args, process.env, { afterDatabaseCommit: interrupt });
} else if (mode === 'update-pg-copy') {
  const [schema, filename] = args;
  const bytes = await readFile(filename);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const pg = await PostgresDatabase.open({ schema, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
  try {
    const control = quoteIdentifier(pg.controlSchema);
    const name = 'introskipper-v2.db';
    await pg.transaction(async db => {
      await db.client.query('DELETE FROM ' + control + '.intro_skipper_chunks WHERE name=$1', [name]);
      await db.client.query('INSERT INTO ' + control + '.intro_skipper_chunks VALUES($1,0,$2)', [name, bytes]);
      await db.client.query('UPDATE ' + control + '.intro_skipper_files SET digest=$1 WHERE name=$2', [hash, name]);
    });
  } finally {
    await pg.close();
  }
} else throw new Error('Unknown Intro Skipper fixture action');
