import { validationPath } from '../../tools/validation/paths.js';
// Records a real Jellyfin response using only an isolated copied instance.
import { cp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';

const scenario = validationPath(path.resolve('.test-input/evidence/core-flow-20260926'));
const root = validationPath(path.resolve('.test-input/evidence/media-streams-20260926'));
const filename = validationPath(path.join(root, 'data/data/jellyfin.db'));
const identities = JSON.parse(await readFile(path.join(scenario, 'identities.json'), 'utf8'));
const emptyRow = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
if (process.argv[2] === 'prepare') {
  await mkdir(root, { recursive: false });
  const source = path.join(scenario, 'reference');
  await cp(source, root, { recursive: true });
  await cp(path.join(scenario, 'initial.db'), filename);
  const replace = text => text.replaceAll(source.replaceAll('\\', '\\\\'), root.replaceAll('\\', '\\\\')).replaceAll(source, root).replaceAll(source.replaceAll('\\', '/'), root.replaceAll('\\', '/'));
  async function updateFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await updateFiles(target);
      else if (/\.(xml|json)$/i.test(entry.name)) {
        let contents = replace(await readFile(target, 'utf8'));
        if (entry.name === 'network.xml') contents = contents.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/g, (_, tag) => `<${tag}>18309</${tag}>`);
        await writeFile(target, contents);
      }
    }
  }
  await updateFiles(validationPath(path.join(root, 'config')));
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  db.transaction(() => {
    for (const table of nativeModel.tables) for (const row of db.rows(table.name)) {
      const changes = Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' && value !== replace(value)).map(([key, value]) => [key, replace(value)]));
      if (Object.keys(changes).length) db.update(table.name, Object.fromEntries(table.primaryKey.map(key => [key, row[key]])), changes);
    }
    const media = db.rows('BaseItems').find(item => item.Id.toLowerCase() === identities.movie);
    db.update('BaseItems', { Id: media.Id }, { TotalBitrate: null });
    const streams = [
      { StreamIndex: 0, StreamType: 1, Codec: 'hevc', Width: 3840, Height: 2160, BitRate: 18000000, AverageFrameRate: 23.976, RealFrameRate: 24, PixelFormat: 'yuv420p10le', BitDepth: 10, ColorSpace: 'bt2020nc', ColorPrimaries: 'bt2020', ColorTransfer: 'smpte2084', DvProfile: 8, DvBlSignalCompatibilityId: 1, RpuPresentFlag: 1, BlPresentFlag: 1, Hdr10PlusPresentFlag: true, Title: 'Main picture' },
      { StreamIndex: 1, StreamType: 0, Codec: 'eac3', Language: 'eng', Channels: 6, ChannelLayout: '5.1', BitRate: 640000, SampleRate: 48000, Profile: 'Dolby Digital Plus + Dolby Atmos', IsDefault: true, IsOriginal: true },
      { StreamIndex: 2, StreamType: 0, Codec: 'aac', Language: 'chi', Channels: 2, BitRate: 192000, SampleRate: 44100, Profile: 'LC', Title: 'Mandarin' },
      { StreamIndex: 3, StreamType: 2, Codec: 'subrip', Language: 'eng', IsDefault: true, IsHearingImpaired: true },
      { StreamIndex: 4, StreamType: 2, Codec: 'pgssub', Language: 'zho', IsForced: true },
      { StreamIndex: 5, StreamType: 2, Codec: 'ass', Language: 'chi', IsExternal: true, Path: validationPath(path.join(root, 'data', 'fixture.zh.ass')), Title: 'Chinese' },
      { StreamIndex: 6, StreamType: 2, Codec: 'dvbsub', Language: null, IsForced: true },
    ];
    for (const stream of streams) db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: media.Id, ...stream });
  });
  db.close();
  await cp(filename, validationPath(path.join(root, 'initial.db')));
  console.log(JSON.stringify({ prepared: root, port: 18309 }));
} else if (process.argv[2] === 'record') {
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const device = db.rows('Devices').find(device => device.DeviceId === 'fixture-oracle');
  db.close();
  if (!device) throw new Error('The isolated fixture credential is unavailable.');
  const headers = { Authorization: `MediaBrowser Client="StreamOracle", Device="IsolatedTest", DeviceId="fixture-oracle", Version="1.0", Token="${device.AccessToken}"`, 'Accept-Language': 'en-US' };
  const responses = [];
  for (const [name, route] of [['user', '/Users/Me'], ['item', `/Items/${identities.movie}`], ['root', `/Users/${device.UserId.replaceAll('-', '')}/Items/Root`]]) {
    const response = await fetch(`http://127.0.0.1:18309${route}`, { headers });
    const text = await response.text(); let body = text; try { body = JSON.parse(text); } catch {}
    responses.push({ name, route, status: response.status, body });
  }
  await writeFile(validationPath(path.join(root, 'reference-responses.json')), JSON.stringify(responses, null, 2));
  console.log(JSON.stringify(responses.map(({ name, status }) => ({ name, status }))));
} else if (process.argv[2] === 'prepare-options') {
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const collections = [];
  for (const enabled of [true, false]) {
    const libraryPath = validationPath(path.join(root, 'data', 'root', 'default', enabled ? 'Enabled' : 'Disabled'));
    await mkdir(libraryPath, { recursive: true });
    await writeFile(path.join(libraryPath, 'options.xml'), `<?xml version="1.0"?><LibraryOptions><Enabled>${enabled}</Enabled><SeasonZeroDisplayName>001</SeasonZeroDisplayName></LibraryOptions>`);
    const id = getNewItemId(libraryPath, 'MediaBrowser.Controller.Entities.CollectionFolder', { programDataPath: validationPath(path.join(root, 'data')) });
    const nativeId = id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toUpperCase();
    const row = { ...emptyRow('BaseItems'), Id: nativeId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: enabled ? 'Enabled' : 'Disabled', SortName: enabled ? 'enabled' : 'disabled', CleanName: enabled ? 'enabled' : 'disabled', Path: libraryPath, IsFolder: true, Data: '{"CollectionType":"movies","PhysicalFolderIds":[]}', MediaType: 'Unknown' };
    if (!db.rows('BaseItems', { where: { Id: nativeId } }).length) db.insert('BaseItems', row);
    collections.push({ enabled, id, row });
  }
  db.close();
  await writeFile(validationPath(path.join(root, 'library-options-identities.json')), JSON.stringify(collections, null, 2));
  console.log(JSON.stringify({ preparedLibraryOptions: collections.length }));
} else if (process.argv[2] === 'locales') {
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const device = db.rows('Devices').find(device => device.DeviceId === 'fixture-oracle'); db.close();
  const authorization = `MediaBrowser Client="StreamOracle", Device="IsolatedTest", DeviceId="fixture-oracle", Version="1.0", Token="${device.AccessToken}"`;
  const results = [];
  for (const request of [{ language: 'en-US' }, { language: 'zh-CN' }, { language: 'en-US', query: '?culture=en-US&ui-culture=zh-CN' }]) {
    const headers = { Authorization: authorization, 'Accept-Language': request.language, 'Content-Type': 'application/json' };
    const response = await fetch(`http://127.0.0.1:18309/Items/${identities.movie}${request.query ?? ''}`, { headers });
    if (response.status !== 200) throw new Error(`Media detail returned ${response.status}.`);
    const body = await response.json();
    const started = await fetch(`http://127.0.0.1:18309/Sessions/Playing${request.query ?? ''}`, { method: 'POST', headers, body: JSON.stringify({ ItemId: identities.movie, PositionTicks: 0, PlayMethod: 'DirectPlay' }) });
    if (started.status !== 204) throw new Error(`Playback start returned ${started.status}.`);
    const sessions = await (await fetch('http://127.0.0.1:18309/Sessions?deviceId=fixture-oracle', { headers })).json();
    const playing = sessions.find(session => session.NowPlayingItem?.Id === identities.movie.replaceAll('-', ''));
    if (!playing) throw new Error('The isolated NowPlaying item is unavailable.');
    results.push({ request, status: response.status, contentLanguage: response.headers.get('content-language'), streams: body.MediaStreams, nowPlayingStreams: playing.NowPlayingItem.MediaStreams });
  }
  await fetch('http://127.0.0.1:18309/Sessions/Playing/Stopped', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ ItemId: identities.movie, PositionTicks: 0 }) });
  await writeFile(validationPath(path.join(root, 'reference-locales.json')), JSON.stringify(results, null, 2));
  await writeFile('tests/library/fixtures/reference-locales.json', JSON.stringify(results, null, 2));
  const collections = JSON.parse(await readFile(validationPath(path.join(root, 'library-options-identities.json')), 'utf8'));
  const optionsResults = [];
  for (const collection of collections) {
    const response = await fetch(`http://127.0.0.1:18309/Items/${collection.id}`, { headers: { Authorization: authorization } });
    optionsResults.push({ enabled: collection.enabled, status: response.status }); await response.text();
  }
  await writeFile(validationPath(path.join(root, 'reference-library-options.json')), JSON.stringify(optionsResults, null, 2));
  await writeFile('tests/library/fixtures/reference-library-options.json', JSON.stringify(optionsResults, null, 2));
  console.log(JSON.stringify({ languages: results.map(result => result.contentLanguage), libraries: optionsResults }));
} else if (process.argv[2] === 'tracks') {
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const device = db.rows('Devices').find(device => device.DeviceId === 'fixture-oracle'); db.close();
  const headers = { Authorization: `MediaBrowser Client="StreamOracle", Device="IsolatedTest", DeviceId="fixture-oracle", Version="1.0", Token="${device.AccessToken}"`, 'Content-Type': 'application/json', 'Accept-Language': 'en-US' };
  const current = await (await fetch('http://127.0.0.1:18309/Users/Me', { headers })).json();
  const scenarios = [];
  try {
    for (const changes of [
      { PlayDefaultAudioTrack: false, AudioLanguagePreference: 'chi', SubtitleMode: 'Smart', SubtitleLanguagePreference: 'eng' },
      { PlayDefaultAudioTrack: false, AudioLanguagePreference: 'chi', SubtitleMode: 'OnlyForced', SubtitleLanguagePreference: 'zho' },
      { PlayDefaultAudioTrack: true, AudioLanguagePreference: 'OriginalLanguage', SubtitleMode: 'Always', SubtitleLanguagePreference: 'deu' },
      { PlayDefaultAudioTrack: true, SubtitleMode: 'None' },
    ]) {
      const configuration = { ...current.Configuration, ...changes };
      const update = await fetch('http://127.0.0.1:18309/Users/Configuration', { method: 'POST', headers, body: JSON.stringify(configuration) });
      if (update.status !== 204) throw new Error(`Configuration update returned ${update.status}.`);
      const response = await fetch(`http://127.0.0.1:18309/Items/${identities.movie}`, { headers });
      if (response.status !== 200) throw new Error(`Media detail returned ${response.status}.`);
      const dto = await response.json(); scenarios.push({ configuration, source: dto.MediaSources[0] });
    }
  } finally { await fetch('http://127.0.0.1:18309/Users/Configuration', { method: 'POST', headers, body: JSON.stringify(current.Configuration) }); }
  await writeFile(validationPath(path.join(root, 'reference-track-selection.json')), JSON.stringify(scenarios, null, 2));
  await writeFile('tests/library/fixtures/reference-track-selection.json', JSON.stringify(scenarios, null, 2));
  console.log(JSON.stringify(scenarios.map(({ configuration, source }) => ({ mode: configuration.SubtitleMode, audio: source.DefaultAudioStreamIndex, subtitle: source.DefaultSubtitleStreamIndex }))));
} else if (process.argv[2] === 'shutdown') {
  const db = new SqliteDatabase(filename, { requireMigrationHistory: true });
  const device = db.rows('Devices').find(device => device.DeviceId === 'fixture-oracle'); db.close();
  const response = await fetch('http://127.0.0.1:18309/System/Shutdown', { method: 'POST', headers: { Authorization: `MediaBrowser Client="StreamOracle", Device="IsolatedTest", DeviceId="fixture-oracle", Version="1.0", Token="${device.AccessToken}"` } });
  console.log(JSON.stringify({ shutdown: response.status }));
} else throw new Error('Use prepare, record or shutdown.');
