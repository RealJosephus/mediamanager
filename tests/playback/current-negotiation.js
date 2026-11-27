import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tableDefinition } from '../../src/database/model.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { databaseFilename, portAvailable } from '../helpers/library-exchange-state.js';
import { prepareNativeMediaSeed } from '../http/native-media-seed.js';
import { originalBytes, subtitleBytes, recordPlayback } from './http-scenario.js';

export async function recordCurrentNegotiation({ root, output, port, libraryFixture, streamsFixture }) {
  const current = await currentNativeReference(), clone = path.join(root, 'current-reference');
  await cp(current.sourceRoot, clone, { recursive: true, errorOnExist: true, force: false });
  await current.prepareClone(clone, port);
  const media = path.join(root, 'native-media');
  await prepareNativeMediaSeed(clone, media);
  const fixture = libraryFixture.tables.BaseItems.find(row => row.Id.startsWith('22222222-'));
  const moviePath = path.join(media, 'retained', path.win32.basename(fixture.Path));
  const subtitleRoot = path.join(media, 'sidecars');
  await mkdir(subtitleRoot);
  await writeFile(moviePath, originalBytes);
  await writeFile(path.join(subtitleRoot, 'fixture.srt'), subtitleBytes);
  const db = new SqliteDatabase(databaseFilename(clone), { requireMigrationHistory: true });
  try {
    db.transaction(() => {
      const { Id, ...columns } = fixture;
      for (const column of tableDefinition('BaseItems').columns) {
        if (column.type === 'INTEGER' && typeof columns[column.name] === 'string') columns[column.name] = BigInt(columns[column.name]);
      }
      db.update('BaseItems', { Id }, { ...columns, Path: moviePath, TotalBitrate: null });
      for (const row of db.rows('MediaStreamInfos', { where: { ItemId: Id } })) {
        db.delete('MediaStreamInfos', { ItemId: Id, StreamIndex: row.StreamIndex });
      }
      for (const row of streamsFixture.rows) db.insert('MediaStreamInfos', row.StreamIndex === 5
        ? { ...row, Path: path.join(subtitleRoot, 'fixture.srt'), Codec: 'subrip' } : row);
    });
  } finally { db.close(); }
  const origin = 'http://127.0.0.1:' + port;
  const server = current.start({ referenceRoot: clone, outputRoot: output, label: 'current-playback', origin });
  const post = (route, body) => fetch(origin + route, { method: 'POST', headers: {
    Authorization: 'MediaBrowser Token="' + current.accessToken + '"', ...(body && { 'Content-Type': 'application/json' }),
  }, body: body && JSON.stringify(body) });
  try {
    await server.ready();
    for (const [field, value] of [['Policy', libraryFixture.user.Policy], ['Configuration', streamsFixture.user]]) {
      const response = await post('/Users/' + current.userId + '/' + field, value);
      assert.equal(response.status, 204, field + ' ' + await response.text());
    }
    const result = await recordPlayback(origin, { accessToken: current.accessToken, negotiationOnly: true });
    return { ...result, subtitleRoot, moviePath, preparation: current.preparation };
  } finally {
    const stopped = await server.stop(async () => (await post('/System/Shutdown')).status, () => portAvailable(port));
    assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable, JSON.stringify(stopped));
    await current.finish();
  }
}
