import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parsePlaylistMemberRelation } from '../../src/metadata/playlist-member-source.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '51100000-0000-0000-0000-000000000001';
const capabilities = { create: true, replace: true, delete: true, mkdir: true };
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const validXml = '<smil><head/><body><seq><media src="song.mp3"/><media src="song.mp3"/></seq></body></smil>';
const malformedXml = '<smil><head/><body><seq><media src="song.mp3"/><bad></seq>' + ' '.repeat(256);
const contents = extension => extension === '.pls' ? '[playlist]\nFile1=song.mp3\nFile2=song.mp3\n'
  : extension === '.m3u' ? '#EXTM3U\n#EXTTEST:first\nsong.mp3\n#EXTTEST:repeated\nsong.mp3\n' : validXml;

test('actual Local playlist parsers preserve PostgreSQL and reader failures while retiring every undelivered owner', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-parser-ownership-'));
  const samples = [
    ...['.m3u', '.pls'].flatMap(extension => [
      { name: extension.slice(1) + '-sql-and-drop', extension, sqlFailure: true, dependent: true },
      { name: extension.slice(1) + '-drop', extension, dependent: true },
      ...falsy.map(([name, reason]) => ({ name: extension.slice(1) + '-drop-' + name, extension, dropReason: { reason } })),
    ]),
    ...['.wpl', '.zpl'].flatMap(extension => falsy.map(([name, reason]) => ({ name: extension.slice(1) + '-xml-and-close-' + name,
      extension, readerCloseReason: { reason } }))),
    { name: 'm3u-zero-write', extension: '.m3u', zeroWrite: true },
  ];
  for (const sample of samples) await t.test(sample.name, async t => {
    const directory = path.join(root, sample.name), files = path.join(directory, 'files'), spoolRoot = path.join(files, 'spool');
    await fs.mkdir(spoolRoot, { recursive: true });
    const filename = path.join(files, 'source' + sample.extension);
    const recoveryPath = path.join(files, 'recovery' + sample.extension);
    const bytes = Buffer.from(sample.readerCloseReason ? malformedXml : contents(sample.extension));
    await fs.writeFile(filename, bytes); await fs.writeFile(recoveryPath, contents(sample.extension));
    const database = await createPostgresTestDatabase(null, 'playlist_parser');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const registry = new StorageRegistry(); registry.registerType('local', config => LocalAdapter.open(config));
    await registry.createInstance('files', 'local', { root: files, writable: true });
    const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    vfs.mount({ path: '/files', instanceId: 'files', capabilities });
    identityMap.addPrefix({ identityRoot: files, accessRoot: '/files', style: process.platform === 'win32' ? 'windows' : 'posix',
      returnAccess: 'Actual parser input and spool handles.' });
    const fileSystem = new StorageFileSystem({ vfs, identityMap });
    let selected = true, result, recovered, failure, primary, dropFailure, parserTable, writerTable, backendPid;
    let closeInjected = false, zeroInjected = false, ownerClosed = 0;
    const handles = [], removedSpools = [], drops = [], created = [];
    const observe = files => {
      const open = files.open.bind(files), remove = files.rm.bind(files);
      files.open = async (identity, flags) => {
        const raw = await open(identity, flags);
        const record = { identity, flags, descriptor: raw.fd, raw, reads: 0, bytesRead: 0, writes: [], closed: false };
        handles.push(record);
        const read = raw.read.bind(raw), write = raw.write.bind(raw), close = raw.close.bind(raw);
        const observedRead = async (...args) => { const value = await read(...args); record.reads++; record.bytesRead += value.bytesRead; return value; };
        const observedWrite = async (...args) => {
          let value;
          if (selected && sample.zeroWrite && !zeroInjected) { zeroInjected = true; value = await write(Buffer.alloc(0)); }
          else value = await write(...args);
          record.writes.push(value.bytesWritten); return value;
        };
        const observedClose = async () => {
          await close(); record.closed = true;
          if (selected && sample.readerCloseReason && flags === 'r' && path.dirname(identity) === spoolRoot && !closeInjected) {
            closeInjected = true; assert.equal(raw.fd, -1); throw sample.readerCloseReason.reason;
          }
        };
        // Never assign onto LocalAdapter's handle proxy: close forwards to its
        // raw FileHandle. An outer proxy observes the actual consumer boundary.
        return new Proxy(raw, { get(target, key) {
          if (key === 'read') return observedRead;
          if (key === 'write') return observedWrite;
          if (key === 'close') return observedClose;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      // The parser accepts an asynchronous byte source. Real Local FileHandle
      // reads make return()/close deterministic before EOF and expose its FD.
      files.createReadStream = identity => (async function* () {
        const handle = await files.open(identity, 'r');
        try {
          for (;;) {
            const buffer = Buffer.alloc(32), { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) return;
            yield buffer.subarray(0, bytesRead);
          }
        } finally { await handle.close(); }
      })();
      files.rm = async (identity, options) => {
        const before = await fs.readFile(identity);
        await remove(identity, options); removedSpools.push({ identity, before });
      };
    };
    observe(fileSystem);
    const retain = fileSystem.retainDirectory.bind(fileSystem);
    fileSystem.retainDirectory = (...args) => {
      const owner = retain(...args); observe(owner.fileSystem);
      return { fileSystem: owner.fileSystem, async close() { await owner.close(); ownerClosed++; } };
    };
    t.after(async () => {
      selected = false;
      if (result !== undefined) await links.release(result);
      if (recovered !== undefined) await links.release(recovered);
      for (const handle of handles) await handle.raw.close();
      await links.flushReleases(); await fileSystem.close(); await registry.close(); await links.close();
      await dropPostgresTestDatabase(database);
    });
    const counts = async () => {
      const value = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
        value[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      }
      return value;
    };
    await links.withSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        if (sql.startsWith('CREATE TEMP TABLE ')) {
          const table = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1]; created.push(table);
          const value = await query(statement, ...args);
          if (table.startsWith('"mm_link_input_')) writerTable = table;
          if (table.startsWith('"playlist_parse_')) {
            parserTable = table;
            if (sample.dependent) await query(`CREATE TEMP VIEW parser_owned_dependency AS SELECT * FROM ${table}`);
          }
          return value;
        }
        if (sample.sqlFailure && sql.startsWith(`INSERT INTO ${parserTable}`)) {
          const changed = sql.replace(sample.extension === '.pls' ? '(number,path)' : '(name)',
            sample.extension === '.pls' ? '(missing_number,path)' : '(missing_name)');
          try { return await query(typeof statement === 'string' ? changed : { ...statement, text: changed }, ...args); }
          catch (error) { primary = error; throw error; }
        }
        if (sql.startsWith('DROP TABLE ')) {
          const table = sql.slice('DROP TABLE '.length); drops.push(table);
          try {
            const value = await query(statement, ...args);
            if (table === parserTable && sample.dropReason) throw sample.dropReason.reason;
            return value;
          } catch (error) { if (table === parserTable) dropFailure = error; throw error; }
        }
        return query(statement, ...args);
      };
      try {
        const parsing = parsePlaylistMemberRelation(fileSystem.createReadStream(filename), {
          extension: sample.extension, linkedChildren: links, session, parentId, spoolRoot, fileSystem,
        }).then(value => { result = value; return value; });
        await assert.rejects(parsing, error => { failure = error; return true; });
      } finally { session.client.query = query; }
    });
    const failedHandles = [...handles], failedSpools = [...removedSpools];
    assert.equal(ownerClosed, 1);
    assert.ok(failedHandles.every(record => record.descriptor >= 0 && record.raw.fd === -1 && record.closed));
    assert.deepEqual(await fs.readFile(filename), bytes);
    assert.deepEqual(await fs.readdir(spoolRoot), []);
    assert.equal(failedSpools.length, 1);
    if (sample.zeroWrite) {
      assert.equal(zeroInjected, true); assert.match(failure.message, /spool write made no progress/u);
      assert.equal(created.length, 0); assert.equal(drops.length, 0);
      assert.deepEqual(failedHandles.find(record => record.flags === 'wx').writes, [0]);
      assert.equal(failedSpools[0].before.length, 0);
    } else {
      assert.deepEqual(failedSpools[0].before, bytes);
      assert.ok(writerTable);
      if (sample.readerCloseReason) {
        assert.equal(closeInjected, true); assert.equal(failure.errors.length, 2);
        assert.equal(failure.errors[0].name, 'XmlError'); assert.equal(failure.cause, failure.errors[0]);
        assert.equal(failure.errors[1], sample.readerCloseReason.reason);
        const reader = failedHandles.find(record => record.flags === 'r' && path.dirname(record.identity) === spoolRoot);
        assert.ok(reader.bytesRead < bytes.length, 'Malformed XML returns its actual spool reader before EOF.');
        assert.deepEqual(created, [writerTable]); assert.deepEqual(drops, [writerTable]);
      } else {
        assert.ok(parserTable); assert.deepEqual(created, [writerTable, parserTable]);
        assert.deepEqual(drops, [parserTable, writerTable], 'The member writer drains before the failed parser connection retires.');
        if (sample.sqlFailure) {
          assert.equal(primary.code, '42703'); assert.equal(dropFailure.code, '2BP01');
          assert.deepEqual(failure.errors, [primary, dropFailure]); assert.equal(failure.cause, primary); assert.equal(failure.code, '42703');
        } else if (sample.dependent) { assert.equal(dropFailure.code, '2BP01'); assert.equal(failure, dropFailure); }
        else { assert.equal(dropFailure, sample.dropReason.reason); assert.equal(failure, sample.dropReason.reason); }
        assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
      }
      assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=ANY($1::text[])',
        [created.map(table => table.slice(1, -1))])).rows[0].count), 0);
    }
    const afterFailure = await counts(); assert.deepEqual(afterFailure, { sets: 0, rows: 0, pins: 0 });
    selected = false;
    recovered = await links.withSession(session => parsePlaylistMemberRelation(fileSystem.createReadStream(recoveryPath), {
      extension: sample.extension, linkedChildren: links, session, parentId, spoolRoot, fileSystem,
    }));
    const rows = await links.page(recovered); assert.deepEqual(rows.map(row => row.Path), ['song.mp3', 'song.mp3']);
    await links.release(recovered); recovered = undefined; await links.flushReleases();
    assert.deepEqual(await counts(), afterFailure); assert.deepEqual(await fs.readdir(spoolRoot), []);
    assert.equal(ownerClosed, 2); assert.ok(handles.every(record => record.raw.fd === -1));
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ sample: sample.name,
      failure: errorObservation(failure), created, drops, afterFailure, zeroInjected, closeInjected,
      sourceBytes: bytes.toString('base64'), spools: failedSpools.map(({ before }) => before.toString('base64')),
      handles: failedHandles.map(({ identity, flags, descriptor, reads, bytesRead, writes, closed, raw }) => ({
        identity, flags, descriptor, reads, bytesRead, writes, closed, finalDescriptor: raw.fd })),
      recoveredPaths: rows.map(row => row.Path) }, null, 2) + '\n');
  });
});
