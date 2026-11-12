import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseLocalXml, fetchLocalXml } from '../../src/metadata/local-xml-parser.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '49700000-0000-0000-0000-000000000001';
const childId = '49700000-0000-0000-0000-000000000002';
const members = '<PlaylistItems>' + Array.from({ length: 2 }, () =>
  `<PlaylistItem><Path>/movies/repeated.mkv</Path><ItemId>${childId}</ItemId></PlaylistItem>`).join('') + '</PlaylistItems>';
const prefix = `<Item><LocalTitle>Retained partial title</LocalTitle>${members}`;
const unfinished = '<PlaylistItems><PlaylistItem><Path>/movies/pending.mkv</Path></PlaylistItem>';
const malformed = unfinished + '<PlaylistItem><Path>broken</PlaylistItems></Item>';
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];

test('actual XML files preserve partial caller results and ordered SQL importer failures without leaking undelivered members', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-xml-member-ownership-'));
  const cases = [
    { name: 'finish-publication-and-drop', publication: true, dependent: true },
    { name: 'xml-and-drop', dependent: true },
    ...falsy.map(([name, reason]) => ({ name: `xml-and-drop-${name}`, dropReason: { reason } })),
    ...falsy.map(([name, reason]) => ({ name: `source-${name}`, sourceReason: { reason } })),
    { name: 'undelivered-parse', owned: true },
    { name: 'undelivered-fetch', owned: true, fetch: true },
    { name: 'undelivered-xml-and-drop', owned: true, dependent: true },
    { name: 'undelivered-later-finish', owned: true, publication: true, later: true, dependent: true },
  ];
  for (const sample of cases) await t.test(sample.name, async t => {
    const database = await createPostgresTestDatabase(t, 'xml_members');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const result = { Item: newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist'), HasMetadata: false };
    result.Item.Id = parentId;
    let returned, file, backendPid, temporary, publicationFailure, dropFailure, failure;
    let created = 0, drops = 0, sourceClosed = false;
    const completed = new Set(), createWriter = links.createWriter.bind(links);
    links.createWriter = async options => {
      const writer = await createWriter(options);
      return { append: row => writer.append(row), abort: () => writer.abort(),
        async finish() { const handle = await writer.finish(); completed.add(handle); return handle; } };
    };
    t.after(async () => {
      await file?.close();
      releaseNativeItemLinks(result.Item);
      if (returned) releaseNativeItemLinks(returned.Item);
      for (const handle of completed) await links.release(handle);
      await links.flushReleases(); await links.close();
    });
    const filename = path.join(root, sample.name + '.xml');
    await fs.writeFile(filename, sample.publication ? prefix + (sample.later ? members : '') + '</Item>'
      : prefix + (sample.sourceReason ? unfinished : malformed));
    file = await fs.open(filename, 'r');
    const stream = file.createReadStream({ encoding: 'utf8', highWaterMark: 47 });
    const closed = new Promise(resolve => stream.once('close', () => { sourceClosed = true; resolve(); }));
    const source = sample.sourceReason ? (async function* () {
      for await (const chunk of stream) yield chunk;
      throw sample.sourceReason.reason;
    })() : stream;
    const targetWriter = sample.publication && !sample.later ? 1 : 2;
    await links.withSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        if (sql.startsWith('CREATE TEMP TABLE "mm_link_input_') && ++created === targetWriter) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const value = await query(statement, ...args);
          if (sample.dependent) await query(`CREATE TEMP VIEW xml_member_dependency AS SELECT * FROM ${temporary}`);
          return value;
        }
        if (sample.publication && temporary && sql.startsWith('WITH owned AS')) {
          try { return await query({ ...statement, text: sql.replace('source."Ordinal"', 'source."AbsentOrdinal"') }, ...args); }
          catch (error) { publicationFailure = error; throw error; }
        }
        if (temporary && sql === `DROP TABLE ${temporary}`) {
          drops++;
          try {
            const value = await query(statement, ...args);
            if (sample.dropReason) throw sample.dropReason.reason;
            return value;
          } catch (error) { dropFailure = error; throw error; }
        }
        return query(statement, ...args);
      };
      const options = { type: 'Playlist', linkedChildren: links, session, ...(!sample.owned && { result }) };
      const parsing = sample.fetch ? fetchLocalXml(async () => source, options) : parseLocalXml(source, options);
      try { await assert.rejects(parsing.then(value => { returned = value; return value; }), error => { failure = error; return true; }); }
      finally { session.client.query = query; }
    });
    await closed;
    assert.equal(sourceClosed, true);
    await assert.rejects(file.read(Buffer.alloc(1), 0, 1, 0), error => error.code === 'EBADF');
    assert.equal(created, targetWriter); assert.equal(drops, 1);
    if (sample.publication) {
      assert.equal(publicationFailure.code, '42703'); assert.equal(dropFailure.code, '2BP01');
      assert.deepEqual(failure.errors, [publicationFailure, dropFailure]);
      assert.equal(failure.cause, publicationFailure); assert.equal(failure.code, publicationFailure.code);
    } else if (sample.dependent || sample.dropReason) {
      assert.equal(failure.errors.length, 2); assert.equal(failure.errors[0].name, 'XmlError');
      assert.equal(failure.cause, failure.errors[0]); assert.equal(failure.errors[1], dropFailure);
      if (sample.dependent) assert.equal(dropFailure.code, '2BP01');
      else assert.equal(dropFailure, sample.dropReason.reason);
    } else if (sample.sourceReason) assert.equal(failure, sample.sourceReason.reason);
    else assert.equal(failure.name, 'XmlError');
    if (!sample.owned) {
      assert.equal(result.HasMetadata, false); assert.equal(result.Item.Name, 'Retained partial title');
      if (!sample.publication) {
        assert.deepEqual((await links.page(result.Item.LinkedChildren)).map(row => ({ Path: row.Path, LibraryItemId: row.LibraryItemId })),
          Array.from({ length: 2 }, () => ({ Path: '/movies/repeated.mkv', LibraryItemId: childId })),
          'The caller retains complete prior containers even when a later member import fails.');
      }
    }
    if (sample.dependent || sample.dropReason) assert.equal(Number((await database.client.query(
      'SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1',
      [temporary.slice(1, -1)])).rows[0].count), 0);
    releaseNativeItemLinks(result.Item); await links.flushReleases();
    const counts = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
      counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    assert.deepEqual(counts, { sets: 0, rows: 0, pins: 0 });
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name,
      failure: errorObservation(failure), sourceClosed, created, drops, counts }, null, 2) + '\n');
  });
});
