import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { nativeGuid } from '../../src/users/native.js';
import {
  companionFiles,
  disabledSkipperItems,
  skipperFiles,
  skipperLayout,
  skipperProvider,
  skipperRows,
} from '../../src/migration/intro-skipper.js';
import { createLockedSqliteSnapshot } from './cli-common.js';

export async function captureSkipperData(pg, directory) {
  const files = await companionFiles(directory);
  if (!files.length) return;
  await pg.ensureMediaSegmentStorage();
  const schema = q(pg.controlSchema),
    authoritative = files.find((f) => f.name !== 'introskipper-cache.db')?.name;
  await pg.transaction(async (db) => {
    // Publication can resume after the main transfer has already committed.
    const tables = ['files', 'chunks', 'protected', 'segments', 'format'];
    await db.client.query('TRUNCATE ' + tables.map((table) => schema + '.intro_skipper_' + table).join(', '));
    for (const { name, file } of files) {
      const snapshot = await createLockedSqliteSnapshot(file);
      try {
        let index = 0;
        const hash = createHash('sha256');
        for await (const data of createReadStream(snapshot.filename, { highWaterMark: 512 * 1024 })) {
          hash.update(data);
          await db.client.query('INSERT INTO ' + schema + '.intro_skipper_chunks VALUES($1,$2,$3)', [
            name,
            index++,
            data,
          ]);
        }
        await db.client.query('INSERT INTO ' + schema + '.intro_skipper_files VALUES($1,$2)', [
          name,
          hash.digest('hex'),
        ]);
        if (name !== authoritative) continue;
        const native = new DatabaseSync(snapshot.filename, { readOnly: true });
        try {
          const layout = skipperLayout(native);
          if (!layout) continue;
          await db.client.query('INSERT INTO ' + schema + '.intro_skipper_format VALUES($1)', [layout]);
          let position = 0,
            batch = [];
          const flush = async () => {
            if (!batch.length) return;
            const json = JSON.stringify(batch);
            const rows =
              'jsonb_to_recordset($1::jsonb) AS v(id text,item text,type int,start bigint,"end" bigint,active boolean,pos bigint)';
            await db.client.query(
              'INSERT INTO ' +
                schema +
                ".intro_skipper_protected SELECT convert_to(item,'UTF8'),type FROM " +
                rows +
                ' ON CONFLICT DO NOTHING',
              [json],
            );
            await db.client.query(
              'INSERT INTO ' +
                schema +
                ".intro_skipper_segments SELECT convert_to(id,'UTF8'),convert_to(item,'UTF8'),type,start,\"end\",pos FROM " +
                rows +
                ' WHERE active',
              [json],
            );
            batch = [];
          };
          for (const r of skipperRows(native, layout)) {
            batch.push({
              id: r.id,
              item: r.item,
              type: r.type,
              start: String(r.start),
              end: String(r.end),
              active: r.active,
              pos: position++,
            });
            if (batch.length === 256) await flush();
          }
          await flush();
          for (const row of disabledSkipperItems(native, layout))
            await db.client.query(
              'INSERT INTO ' + schema + '.intro_skipper_protected VALUES($1,4),($1,5) ON CONFLICT DO NOTHING',
              [Buffer.from(nativeGuid(row.ItemId))],
            );
          if (layout === 'legacy') {
            // Legacy records have no native GUID. Keep the ID already published by the plugin for the same interval.
            await db.client.query(
              'UPDATE ' +
                schema +
                '.intro_skipper_segments p SET id=s."Id" FROM ' +
                q(db.schemaName) +
                '."MediaSegments" s WHERE s."ItemId"=p.item_id AND s."Type"=p.type AND s."StartTicks"=p.start_ticks AND s."EndTicks"=p.end_ticks AND s."SegmentProviderId"=$1',
              [Buffer.from(skipperProvider)],
            );
          }
        } finally {
          native.close();
        }
        await snapshot.assertUnchanged();
      } finally {
        await snapshot.close();
      }
    }
  });
  return files.map((f) => f.name);
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(filename)) hash.update(data);
  return hash.digest('hex');
}

export async function restoreSkipperData(pg, output) {
  const schema = q(pg.controlSchema);
  const result = await pg.client.query('SELECT to_regclass($1) AS relation', [
    schema + '.intro_skipper_files',
  ]);
  if (!result.rows[0].relation) return [];
  const files = (
    await pg.client.query('SELECT name,digest FROM ' + schema + '.intro_skipper_files ORDER BY name')
  ).rows;
  if (!files.length) return [];
  if (files.some((f) => !skipperFiles.includes(f.name)))
    throw new Error('Unknown stored Intro Skipper database filename');
  try {
    if (!(await lstat(output)).isDirectory()) throw new Error('Expected an Intro Skipper output directory');
    const existing = await readdir(output);
    if (existing.length !== files.length || files.some((f) => !existing.includes(f.name)))
      throw new Error('Intro Skipper output already contains different files');
    for (const f of files)
      if (
        !(await lstat(path.join(output, f.name))).isFile() ||
        (await fileHash(path.join(output, f.name))) !== f.digest
      )
        throw new Error('Intro Skipper output database differs: ' + f.name);
    return files.map((f) => f.name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(path.join(path.dirname(output), '.intro-skipper-'));
  try {
    for (const f of files) {
      const dest = path.join(stage, f.name),
        file = await open(dest, 'wx', 0o600);
      try {
        let next = 0;
        while (true) {
          const { rows } = await pg.client.query(
            'SELECT data,position FROM ' +
              schema +
              '.intro_skipper_chunks WHERE name=$1 AND position>=$2 ORDER BY position LIMIT 4',
            [f.name, next],
          );
          if (!rows.length) break;
          for (const r of rows) {
            if (Number(r.position) !== next++) throw new Error('Missing Intro Skipper database chunk');
            await file.writeFile(r.data);
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await fileHash(dest)) !== f.digest)
        throw new Error('Stored Intro Skipper database digest mismatch');
    }
    await rename(stage, output);
    return files.map((f) => f.name);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
