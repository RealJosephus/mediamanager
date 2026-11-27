import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getHeapStatistics } from 'node:v8';
import { exchangeFixture, exchangeId, stoppedEmby, withCatalog } from './emby-exchange-fixture.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
export const requiredValidationServices = ['postgres'];

const operator = fileURLToPath(new URL('../../tools/database/emby.js', import.meta.url));

test(
  'the ordinary Emby operator CLI imports and returns 100000 long descriptions in separate new processes',
  {
    timeout: 1200000,
  },
  async (t) => {
    const fixture = await exchangeFixture(t);
    const schema = 'large_return_' + randomUUID().replaceAll('-', '').slice(0, 20);
    t.after(async () =>
      dropPostgresTestDatabase(await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }))
    );
    const count = 100000;
    const overview = 'x'.repeat(3000);
    const insert = fixture.emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,Overview) VALUES(?,?,5,?,?)');
    fixture.emby.exec('BEGIN');
    for (let id = 1; id <= count; id++) insert.run(id, toBlob(exchangeId(id)), 'Movie ' + id, overview + id);
    fixture.emby.exec('COMMIT');
    const source = await stoppedEmby(fixture);
    const manager = path.join(fixture.directory, 'manager'),
      returned = path.join(fixture.directory, 'returned');
    t.diagnostic(
      JSON.stringify({ defaultHeapMiB: Math.round(getHeapStatistics().heap_size_limit / 1048576), rows: count })
    );
    for (const [direction, input, output] of [
      ['import', source, manager],
      ['export', manager, returned],
    ]) {
      const args = [
        operator,
        direction,
        '--source',
        input,
        '--output',
        output,
        '--schema',
        schema,
        '--postgres-url-env',
        'MEDIAMANAGER_TEST_POSTGRES',
      ];
      let result;
      try {
        const stdout = await new Promise((resolve, reject) => {
          execFile(process.execPath, args, { timeout: 540000, killSignal: 'SIGKILL', windowsHide: true }, (error, output, stderr) => {
            if (error) reject(Object.assign(error, { stderr }));
            else resolve(output);
          });
        });
        result = JSON.parse(stdout);
      } catch (error) {
        const stderr = String(error.stderr ?? error.message).replaceAll(postgresTestConnectionString, '[database]');
        const fatal = stderr
          .split(/\r?\n/u)
          .find((line) => /FATAL ERROR|heap out of memory|SQLITE_|ENOSPC/iu.test(line));
        throw new Error(
          direction + ' exited with ' + (error.signal ?? error.code) + ': ' + (fatal ?? stderr.slice(-400))
        );
      }
      const { sourceRecords, targetRecords } = result;
      t.diagnostic(JSON.stringify({ phase: direction, completed: true, sourceRecords, targetRecords }));
      assert.equal(sourceRecords, count);
      assert.equal(targetRecords, count);
    }
    withCatalog(returned, 'emby', (db) => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MediaItems').get().n, count);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM MediaItems WHERE Overview IS NOT (? || Id)').get(overview).n,
        0
      );
    });
  }
);
