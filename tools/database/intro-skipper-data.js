import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { nativeGuid } from '../../src/users/native.js';
import { acquireOperationLease } from '../../src/migration/operation-lease.js';
import {
  companionFiles,
  disabledSkipperItems,
  skipperFiles,
  skipperLayout,
  skipperProvider,
  skipperRows,
} from '../../src/migration/intro-skipper.js';
import { closeResources, createLockedSqliteSnapshot } from './cli-common.js';

const cacheName = 'introskipper-cache.db';
const captureKey = 'introSkipperCapture';

async function snapshotSkipperFiles(directory) {
  const files = await companionFiles(directory);
  const snapshots = [];
  async function capture(index) {
    if (index === files.length) {
      if (JSON.stringify(await companionFiles(directory)) !== JSON.stringify(files))
        throw new Error('Intro Skipper database membership changed during capture');
      return;
    }
    const file = files[index];
    const snapshot = await createLockedSqliteSnapshot(file.file, { whileLocked: () => capture(index + 1) });
    snapshots[index] = { name: file.name, snapshot };
  }
  try {
    await capture(0);
    return snapshots;
  } catch (error) {
    const failures = await closeResources(snapshots.filter(Boolean).map(file => file.snapshot));
    if (failures.length) throw new AggregateError([error, ...failures], error.message, { cause: error });
    throw error;
  }
}

export async function snapshotJellyfinAndSkipper(filename, directory, createSnapshot = createLockedSqliteSnapshot) {
  let main, companions;
  const takeCompanions = async () => { companions = directory ? await snapshotSkipperFiles(directory) : []; };
  try {
    main = await createSnapshot(filename, { whileLocked: takeCompanions });
    // A prepared Emby publication already supplies an immutable main snapshot.
    if (!companions) await takeCompanions();
    return { main, companions };
  } catch (error) {
    const failures = await closeResources([main, ...companions?.map(file => file.snapshot) ?? []]);
    if (failures.length) throw new AggregateError([error, ...failures], error.message, { cause: error });
    throw error;
  }
}

function inspectSkipper(file) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      throw new Error('Intro Skipper database failed integrity check: ' + path.basename(file));
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name COLLATE BINARY').all();
    const hash = createHash('sha256');
    hash.update(JSON.stringify([schema, db.prepare('PRAGMA application_id').get(), db.prepare('PRAGMA user_version').get()]));
    const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','shadow') AND name<>'sqlite_schema' ORDER BY name COLLATE BINARY").all();
    for (const { name } of tables) {
      const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden<>1 ORDER BY cid')
        .all(name).map(column => q(column.name));
      const kinds = columns.map(col => 'typeof(' + col + ')');
      const cells = columns.map((col, index) => "CASE WHEN " + kinds[index] + "='text' THEN CAST(" + col + ' AS BLOB) ELSE ' + col + ' END');
      const order = [...kinds, ...cells].map((_, index) => index + 1);
      const rows = db.prepare('SELECT ' + [...kinds, ...cells].join(',') + ' FROM ' + q(name) + ' ORDER BY ' + order.join(','));
      rows.setReadBigInts(true);
      rows.setReturnArrays(true);
      hash.update(JSON.stringify(name) + '\n');
      for (const row of rows.iterate()) {
        const values = row.slice(columns.length).map(value =>
          value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value === null ? null : String(value));
        hash.update(JSON.stringify([row.slice(0, columns.length), values]) + '\n');
      }
    }
    return { layout: skipperLayout(db), empty: schema.length === 0, logical: hash.digest('hex') };
  } finally {
    db.close();
  }
}

export async function captureSkipperData(pg, files) {
  if (!files.length) return;
  const manifest = [];
  for (const { name, snapshot } of files) {
    await snapshot.assertUnchanged();
    manifest.push({
      name,
      digest: await fileHash(snapshot.filename),
      ...(name === cacheName ? {} : inspectSkipper(snapshot.filename)),
    });
  }
  await pg.ensureMediaSegmentStorage();
  const schema = q(pg.controlSchema),
    authoritative = files.find((f) => f.name !== cacheName)?.name;
  await pg.transaction(async (db) => {
    const { serverId } = await db.readInstanceBinding();
    const prior = JSON.parse(await db.getState(captureKey) ?? 'null');
    if (prior) {
      const identity = (list) => list.map(file => [file.name, file.logical ?? file.digest]);
      const current = (await db.client.query('SELECT name,digest FROM ' + schema + '.intro_skipper_files')).rows;
      if (prior.serverId !== serverId || JSON.stringify(identity(prior.files)) !== JSON.stringify(identity(manifest)) ||
          prior.files.length !== current.length || prior.files.some(file => !current.some(row => row.name === file.name && row.digest === file.digest)))
        throw new Error('Prepared Intro Skipper snapshot differs from the committed PostgreSQL copy');
      return;
    }
    // Publication can resume after the main transfer has already committed.
    const tables = ['files', 'chunks', 'protected', 'segments', 'format'];
    await db.client.query('TRUNCATE ' + tables.map((table) => schema + '.intro_skipper_' + table).join(', '));
    for (const { name, snapshot } of files) {
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
      const digest = hash.digest('hex');
      if (digest !== manifest.find(file => file.name === name).digest) throw new Error('Intro Skipper snapshot changed during PostgreSQL capture');
      await db.client.query('INSERT INTO ' + schema + '.intro_skipper_files VALUES($1,$2)', [name, digest]);
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
    }
    for (const { snapshot } of files) await snapshot.assertUnchanged();
    await db.setState(captureKey, JSON.stringify({ serverId, files: manifest }));
  });
  return files.map((f) => f.name);
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(filename)) hash.update(data);
  return hash.digest('hex');
}

async function clearSkipperStage(stage) {
  let stat;
  try { stat = await lstat(stage); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory()) throw new Error('Expected a private Intro Skipper staging directory');
  const names = await readdir(stage);
  for (const name of names)
    if (!skipperFiles.includes(name) || !(await lstat(path.join(stage, name))).isFile())
      throw new Error('Unrecognized Intro Skipper staging member: ' + name);
  for (const name of names) await unlink(path.join(stage, name));
  await rmdir(stage);
}

export async function openSkipperPublication(output, mainOutput) {
  const physical = path.join(await realpath(path.dirname(output)), path.basename(output));
  const key = process.platform === 'win32' ? physical.toLowerCase() : physical;
  const main = path.join(await realpath(path.dirname(mainOutput)), path.basename(mainOutput));
  const relative = path.relative(physical, main);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)))
    throw new Error('Jellyfin and Intro Skipper outputs must be separate');
  const stage = path.join(path.dirname(physical), '.intro-skipper-' + createHash('sha256').update(key).digest('hex') + '.pending');
  const lease = await acquireOperationLease(key, { label: 'Intro Skipper export' });
  try {
    await clearSkipperStage(stage);
    return {
      stage,
      async publish(files) {
        lease.assertHeld();
        await publishSkipperData(stage, physical, files);
      },
      async close() {
        try {
          lease.assertHeld();
          await clearSkipperStage(stage);
        } finally { await lease.release(); }
      },
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

export async function stageSkipperData(pg, stage) {
  const schema = q(pg.controlSchema);
  const result = await pg.client.query('SELECT to_regclass($1) AS relation', [
    schema + '.intro_skipper_files',
  ]);
  if (!result.rows[0].relation) return { files: [] };
  const files = (
    await pg.client.query('SELECT name,digest FROM ' + schema + '.intro_skipper_files ORDER BY name')
  ).rows;
  if (!files.length) return { files };
  if (files.some((f) => !skipperFiles.includes(f.name)))
    throw new Error('Unknown stored Intro Skipper database filename');
  const baseline = JSON.parse(await pg.getState(captureKey) ?? 'null');
  if (baseline && baseline.serverId !== (await pg.readInstanceBinding())?.serverId)
    throw new Error('Intro Skipper data belongs to a different instance');
  await mkdir(stage, { mode: 0o700 });
  for (const f of files) {
    const dest = path.join(stage, f.name);
    const file = await open(dest, 'wx', 0o600);
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
      throw new Error('Stored Intro Skipper database digest mismatch: ' + f.name);
  }
  return { files, baseline };
}

async function publishSkipperData(stage, output, files) {
  if (!files.length) return;
  let existing;
  try {
    if (!(await lstat(output)).isDirectory()) throw new Error('Expected an Intro Skipper output directory');
    existing = await readdir(output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!existing) {
    await rename(stage, output);
    return;
  }
  if (existing.length !== files.length || files.some((f) => !existing.includes(f.name)))
    throw new Error('Intro Skipper output already contains different files');
  for (const f of files)
    if (!(await lstat(path.join(output, f.name))).isFile() ||
        (await fileHash(path.join(output, f.name))) !== f.digest)
      throw new Error('Intro Skipper output database differs: ' + f.name);
}

export async function reconcileSkipperCopies(directory, postgres, { files, baseline }) {
  const local = new Map((await companionFiles(directory)).map(file => [file.name, file.file]));
  const issues = [];
  for (const { name } of files) {
    const current = local.get(name), fromPg = path.join(postgres, name), target = path.join(directory, name);
    if (current && name === cacheName) continue;
    if (current) {
      const disk = inspectSkipper(current), pg = inspectSkipper(fromPg);
      if (disk.logical === pg.logical) continue;
      const common = baseline?.files.find(file => file.name === name)?.logical;
      if (!disk.empty && common === pg.logical) continue;
      if (common !== disk.logical && !disk.empty) {
        const alternative = path.join('.mediamanager-variants', pg.logical, name);
        const saved = path.join(directory, alternative);
        await mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
        try {
          await copyFile(fromPg, saved, constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code !== 'EEXIST' || inspectSkipper(saved).logical !== pg.logical) throw error;
        }
        issues.push({ status: 'conflict', kind: 'plugin', id: name, field: 'IntroSkipper',
          reason: 'local and PostgreSQL private databases differ with no unchanged copy',
          evidence: { local: disk, postgres: pg, baseline: common, selected: 'local', postgresCopy: alternative } });
        continue;
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const suffix of ['-wal', '-shm', '-journal']) await rm(target + suffix, { force: true });
    await copyFile(fromPg, target);
  }
  return issues;
}
