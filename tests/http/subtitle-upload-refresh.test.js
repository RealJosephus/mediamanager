import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { itemLibraryOptions } from '../../src/library/options.js';
import { nativeGuid } from '../../src/users/native.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
export const requiredValidationServices = ['postgres'];
for (const foreign of [false, true])
  test(
    'HTTP subtitle upload and real ffprobe refresh on a private metadata mount, Windows source identity ' + foreign,
    async (t) => {
      const work = await mkdtemp(path.join(os.tmpdir(), 'review-sub-wire-')),
        program = path.join(work, 'program');
      const content = path.join(work, 'body'),
        sidecars = path.join(work, 'sidecars');
      await mkdir(content);
      await mkdir(sidecars);
      const identity = foreign ? 'Q:\\Fixture' : '/fixture-movies',
        moviePath = (foreign ? path.win32 : path.posix).join(identity, 'movie.mkv');
      const metadataIdentity = path.join(program, 'metadata'),
        definition = path.join(work, 'storage.json');
      await writeFile(
        path.join(content, 'movie.mkv'),
        await readFile(new URL('../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url))
      );
      const storage = { instances: [], mounts: [], prefixes: [] };
      for (const [id, root, identityRoot, style, purpose] of [
        ['body', content, identity, foreign ? 'windows' : 'posix', 'media'],
        ['sidecars', sidecars, metadataIdentity, process.platform === 'win32' ? 'windows' : 'posix', 'metadata'],
      ]) {
        storage.instances.push({ id, type: 'local', config: { root, writable: true } });
        storage.mounts.push({
          path: '/' + id,
          instanceId: id,
          root: '/',
          capabilities: { create: true, replace: true, mkdir: true, delete: true },
        });
        storage.prefixes.push({
          identityRoot,
          accessRoot: '/' + id,
          style,
          returnAccess: 'Isolated ' + id,
          ...(purpose === 'metadata' ? { purpose } : {}),
        });
      }
      await writeFile(definition, JSON.stringify(storage));
      const db = await createPostgresTestDatabase(null, 'sub_wire');
      let runtime;
      t.after(async () => {
        try {
          await runtime?.close();
        } finally {
          try {
            await dropPostgresTestDatabase(db);
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        }
      });
      await writeFile(path.join(content, '.ignore'), '*.review-nonmatch');
      const errors = [];
      runtime = await createTestRuntime({
        database: db,
        serverId: '682195b836dd48e78b8c2154aa232c11',
        programDataPath: program,
        storageConfiguration: definition,
        mediaEncoderOptions: { startupFFmpegPath: validationExecutable('ffmpeg') },
        configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
        onError: (error) => errors.push([error.code, error.message]),
      });
      await runtime.plugins.setEnabled('tmdb', false);
      const origin =
          'http://127.0.0.1:' + runtime.networkHost.listeners.find((x) => x.bound && x.scheme === 'http').port,
        token = (await runtime.apiKeys.create('Isolated subtitle wire')).AccessToken;
      const headers = { Authorization: 'MediaBrowser Token="' + token + '"', 'Content-Type': 'application/json' };
      const added = await fetch(
        origin + '/Library/VirtualFolders?name=Review&collectionType=movies&refreshLibrary=false',
        {
          method: 'POST',
          headers,
          signal: t.signal,
          body: JSON.stringify({
            LibraryOptions: {
              PathInfos: [{ Path: identity }],
              SaveSubtitlesWithMedia: false,
              MetadataSavers: [],
              TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }],
            },
          }),
        }
      );
      assert.equal(added.status, 204, await added.text());
      await runtime.libraryScanner.runCompleteScan();
      const items = await fetch(origin + '/Items?Recursive=true&IncludeItemTypes=Movie&Fields=Path', {
        headers,
        signal: t.signal,
      });
      assert.equal(items.status, 200);
      const movies = (await items.json()).Items;
      const movie = movies.find((x) => x.Path === moviePath)?.Id;
      assert.ok(movie, JSON.stringify({ movies: movies.map((x) => [x.Type, x.Path]), errors }));
      const key = (id) => id.replaceAll('-', '').toLowerCase();
      const options = await runtime.library.withItemRecord(movie, {}, (item) =>
        itemLibraryOptions(runtime.library, item)
      );
      t.diagnostic(JSON.stringify({ storedSaveWithMedia: options.SaveSubtitlesWithMedia }));
      assert.equal(options.SaveSubtitlesWithMedia, false);
      const get = async () => {
        const r = await fetch(origin + '/Items/' + movie + '/PlaybackInfo', { headers, signal: t.signal });
        assert.equal(r.status, 200);
        return (await r.json()).MediaSources[0].MediaStreams;
      };
      assert.ok((await get()).some((s) => s.Type === 'Video'));
      const upload = await fetch(origin + '/Videos/' + movie + '/Subtitles', {
        method: 'POST',
        headers,
        signal: t.signal,
        body: JSON.stringify({
          Format: 'srt',
          Language: 'en',
          Data: Buffer.from('1\n00:00:00,000 --> 00:00:00,500\nExample\n').toString('base64'),
        }),
      });
      assert.equal(upload.status, 204, await upload.text());
      const filename = path.join(sidecars, 'library', key(movie).slice(0, 2), key(movie), 'movie.en.srt');
      assert.match(await readFile(filename, 'utf8'), /Example/);
      await runtime.metadata.drain();
      await runtime.metadata.refresh(movie, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
      const visible = (await get()).filter((s) => s.Type === 'Subtitle' && s.IsExternal === true);
      const stored = (await db.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(movie) } }))
        .filter((s) => s.IsExternal === true)
        .map((s) => [s.StreamIndex, s.Language, s.Path]);
      assert.equal(visible.length, 1);
      assert.equal(visible[0].Language, 'eng');
      const relative = path.relative(sidecars, filename);
      assert.equal(visible[0].Path, path.join(metadataIdentity, relative));
      assert.deepEqual(stored, [[visible[0].Index, 'eng', path.join('%MetadataPath%', relative)]]);
      const stream = await fetch(
        origin + '/Videos/' + movie + '/' + movie + '/Subtitles/' + visible[0].Index + '/Stream.srt',
        { headers, signal: t.signal }
      );
      assert.equal(stream.status, 200);
      assert.match(await stream.text(), /Example/);
    }
  );
