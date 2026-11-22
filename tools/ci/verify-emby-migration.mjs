import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { startProductionInstance } from '../../src/main.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { DatabaseSync } from 'node:sqlite';
import { cloneDirectory } from '../../src/migration/emby/files.js';
import { runEmby } from '../database/emby.js';
import { embyLibraryMounts } from '../../src/migration/emby/mounts.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { nativeGuid } from '../../src/users/native.js';
import { verifyProviderRoundtrip } from './provider-id-migration.mjs';

const releaseRoot = process.env.MEDIAMANAGER_EMBY_REFERENCE_ROOT;
const receipt = JSON.parse(await readFile(path.join(releaseRoot, 'receipts/reference-input.json')));
const root = path.join(process.env.RUNNER_TEMP, 'exchange');
await mkdir(root);
const original = path.join(root, 'original'),
  media = path.join(root, 'music');
await mkdir(path.join(original, 'config'), { recursive: true });
await mkdir(media);
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((r) => listener.close(r));
await writeFile(
  path.join(original, 'config/system.xml'),
  `<ServerConfiguration><IsStartupWizardCompleted>false</IsStartupWizardCompleted>
<HttpServerPortNumber>${port}</HttpServerPortNumber><PublicPort>${port}</PublicPort><EnableHttps>false</EnableHttps>
<EnableRemoteAccess>false</EnableRemoteAccess><EnableUPnP>false</EnableUPnP><EnableAutoUpdate>false</EnableAutoUpdate>
<AutoRunWebApp>false</AutoRunWebApp><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></ServerConfiguration>`,
);
const pw = randomBytes(30).toString('hex');
const picture = await readFile(new URL('../../tests/images/fixtures/blending/grid.png', import.meta.url));
const env = { ...process.env, MM_TEST_ADMIN: pw },
  pgVar = 'MEDIAMANAGER_TEST_POSTGRES';
let token, username, wireId, adminId, nativePicture;
async function call(route, method = 'GET', body) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Emby Client="Migration", Device="CI", DeviceId="migration", Version="1"${token ? ', Token="' + token + '"' : ''}`,
  };
  const r = await fetch('http://127.0.0.1:' + port + '/emby' + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok)
    throw new Error(route + ' returned ' + r.status + ' ' + text.slice(0, 250).replaceAll(pw, '[redacted]'));
  return text ? JSON.parse(text) : null;
}
async function host(instance, operation, serverRoot = releaseRoot, version = receipt.version) {
  const args = [
    path.join(serverRoot, 'package/system/EmbyServer.dll'),
    '-programdata',
    instance,
    '-noautorunwebapp',
    '-ffmpeg',
    env.MEDIAMANAGER_FFMPEG,
    '-ffprobe',
    env.MEDIAMANAGER_FFPROBE,
  ];
  const child = spawn('dotnet', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (b) => {
      logs = (logs + b).slice(-4500);
    });
  const ended = once(child, 'exit');
  token = null;
  try {
    const deadline = Date.now() + 90000;
    for (;;) {
      if (child.exitCode != null) throw new Error('Emby exited during initialization ' + logs);
      try {
        if ((await call('/System/Info/Public')).Version === version) break;
      } catch {}
      if (Date.now() > deadline) throw new Error('Official startup timeout ' + logs);
      await delay(250);
    }
    await operation();
    await call('/System/Shutdown', 'POST');
    const timer = AbortSignal.timeout(25000);
    const result = await Promise.race([
      ended,
      once(timer, 'abort').then(() => {
        throw new Error('Official shutdown timed out');
      }),
    ]);
    assert.equal(result[0], 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  }
}
async function login() {
  const result = await call('/Users/AuthenticateByName', 'POST', { Username: username, Pw: pw });
  token = result.AccessToken;
  adminId = result.User.Id;
}
await host(original, async () => {
  username = (await call('/Startup/User')).Name;
  await call('/Startup/User', 'POST', { Name: username, Password: pw });
  await login();
  await call('/Startup/Configuration', 'POST', {
    ServerName: 'CI migration',
    UICulture: 'en-US',
    MetadataCountryCode: 'US',
    PreferredMetadataLanguage: 'en',
  });
  await call('/Startup/Complete', 'POST');
  const wave = Buffer.alloc(16044);
  wave.write('RIFF');
  wave.writeUInt32LE(16036, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(16000, 40);
  await writeFile(path.join(media, 'Round trip.wav'), wave);
  await call('/Library/VirtualFolders?name=Exchange&collectionType=music&refreshLibrary=true', 'POST', {
    LibraryOptions: {
      PathInfos: [{ Path: media }],
      EnableRealtimeMonitor: false,
      EnableInternetProviders: false,
      SaveLocalMetadata: false,
      MetadataSavers: [],
    },
  });
  for (let i = 0; i < 180; i++) {
    const r = await call('/Users/' + adminId + '/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path');
    if (r.Items?.length) {
      wireId = r.Items[0].Id;
      break;
    }
    await delay(500);
  }
  assert.ok(wireId, 'official library contains the audio item');
  await call('/Users/' + adminId + '/FavoriteItems/' + wireId, 'POST');
  const upload = await fetch('http://127.0.0.1:' + port + '/emby/Items/' + wireId + '/Images/Primary', {
    method: 'POST',
    headers: { 'X-Emby-Token': token, 'Content-Type': 'image/png' },
    body: picture.toString('base64'),
  });
  assert.ok(upload.ok, 'official image upload HTTP ' + upload.status);
  const selected = await fetch(
    'http://127.0.0.1:' + port + '/emby/Items/' + wireId + '/Images/Primary?format=Png',
    { headers: { 'X-Emby-Token': token } },
  );
  assert.equal(selected.status, 200);
  nativePicture = Buffer.from(await selected.arrayBuffer());
  assert.deepEqual(nativePicture.subarray(0, 8), picture.subarray(0, 8));
});
await mkdir(path.join(original, 'metadata'), { recursive: true });
await writeFile(
  path.join(original, 'metadata', 'custom-asset.nfo'),
  '<movie><custom>original metadata</custom></movie>',
);
const mm = path.join(root, 'manager'),
  returned = path.join(root, 'returned'),
  again = path.join(root, 'manager2');
const contractFile = path.join(root, 'mounts.json'),
  storage = path.join(root, 'storage.json');
const sidecars = path.join(root, 'sidecars.json');
assert.ok(
  (await embyLibraryMounts(original)).mounts.some((m) => m.identityRoot === media),
  'mounts are read from native library settings',
);
await writeFile(path.join(media, 'Round trip.nfo'), '<musicvideo><title>Sidecar</title></musicvideo>');
await writeFile(sidecars, JSON.stringify([{ id: 'music', directory: media, identityRoot: media }]));
await writeFile(
  contractFile,
  JSON.stringify({
    mounts: [
      {
        mountId: 'ci-media',
        identityRoot: root,
        accessRoot: '/vfs/test',
        pathStyle: 'posix',
        caseSensitive: true,
        returnPolicy: 'required',
      },
    ],
  }),
);
await writeFile(
  storage,
  JSON.stringify({
    instances: [{ id: 'fixture', type: 'local', config: { root, writable: false } }],
    mounts: [{ path: '/vfs/test', instanceId: 'fixture', capabilities: {} }],
    prefixes: [
      {
        identityRoot: root,
        accessRoot: '/vfs/test',
        style: 'posix',
        caseSensitive: true,
        purpose: 'library',
        returnAccess: 'CI fixture',
      },
    ],
  }),
);
function flags(source, output, schema) {
  return ['--source', source, '--output', output, '--schema', schema, '--postgres-url-env', pgVar];
}
const initialArgs = [
  ...flags(original, mm, 'migration_a'),
  '--mount-contract',
  contractFile,
  '--asset-roots',
  sidecars,
  '--admin-user',
  username,
  '--admin-password-env',
  'MM_TEST_ADMIN',
];
await assert.rejects(
  runEmby('import', initialArgs, env, {
    afterDatabaseCommit() {
      throw new Error('injected interruption after PostgreSQL commit');
    },
  }),
  /injected interruption/u,
);
const imported = await runEmby('import', initialArgs, env);
assert.ok(imported.changes > 0);
assert.equal(
  await readFile(path.join(mm, 'data/metadata/migration-assets/music/Round trip.nfo'), 'utf8'),
  '<musicvideo><title>Sidecar</title></musicvideo>',
);
const equalCopy = path.join(root, 'unchanged');
const unchanged = await runEmby('export', flags(mm, equalCopy, 'migration_a'), env);
assert.equal(unchanged.changes, 0);
for (const file of ['library.db', 'users.db']) {
  const snapshot = (instance) => {
    const db = new DatabaseSync(path.join(instance, 'data', file), { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
      return tables.map(({ name }) => {
        const stmt = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"');
        stmt.setReadBigInts(true);
        stmt.setReturnArrays(true);
        return [name, stmt.all()];
      });
    } finally {
      db.close();
    }
  };
  assert.deepEqual(snapshot(equalCopy), snapshot(original));
}
const connectionString = env[pgVar];
async function postgres(schema, fn) {
  const db = await PostgresDatabase.open({ connectionString, schema });
  try {
    return await db.withConnection(fn);
  } finally {
    await db.close();
  }
}
let item;
await postgres('migration_a', async (db) => {
  const res = await db.client.query('SELECT "Id","Name" FROM "BaseItems" WHERE "Path"=$1', [
    nativeTextBytes(path.join(media, 'Round trip.wav')),
  ]);
  assert.equal(res.rows.length, 1);
  item = res.rows[0].Id.toString();
  assert.ok((await db.rows('UserData', { where: { ItemId: item } })).some((r) => r.IsFavorite));
  await db.update(
    'BaseItems',
    { Id: item },
    { Name: 'Edited in MediaManager', IsLocked: true, Genres: 'Migration genre' },
  );
  const ItemValueId = randomUUID().toUpperCase();
  await db.insert('ItemValues', {
    ItemValueId,
    Type: 2,
    Value: 'Migration genre',
    CleanValue: 'migration genre',
  });
  await db.insert('ItemValuesMap', { ItemId: item, ItemValueId });
  await db.insert('BaseItemProviders', { ItemId: item, ProviderId: 'ExchangeFixture', ProviderValue: '01234' });
});
await writeFile(path.join(mm, 'data/metadata/custom-asset.nfo'), '<movie><custom>edited</custom></movie>');
const exported = await runEmby('export', flags(mm, returned, 'migration_a'), env);
assert.equal(exported.conflicts, 0);
assert.match(await readFile(path.join(returned, 'metadata/custom-asset.nfo'), 'utf8'), /edited/u);
await host(returned, async () => {
  await login();
  const edit = await call('/Users/' + adminId + '/Items/' + wireId + '?Fields=Genres,ProviderIds');
  assert.equal(edit.Name, 'Edited in MediaManager');
  assert.ok(edit.Genres.includes('Migration genre'));
  assert.equal(edit.ProviderIds.ExchangeFixture, '01234');
  const artwork = await fetch(
    'http://127.0.0.1:' + port + '/emby/Items/' + wireId + '/Images/Primary?format=Png',
    { headers: { 'X-Emby-Token': token } },
  );
  assert.equal(artwork.status, 200);
  assert.deepEqual(Buffer.from(await artwork.arrayBuffer()), nativePicture);
  await call('/Users/' + adminId + '/FavoriteItems/' + wireId, 'DELETE');
});
const reimported = await runEmby('import', flags(returned, again, 'migration_b'), env);
assert.equal(reimported.conflicts, 0);
await postgres('migration_b', async (db) => {
  assert.equal((await db.rows('BaseItems', { where: { Id: item } }))[0].Name, 'Edited in MediaManager');
  assert.equal(
    (await db.rows('BaseItemProviders', { where: { ItemId: item, ProviderId: 'ExchangeFixture' } }))[0]
      .ProviderValue,
    '01234',
  );
  assert.ok((await db.rows('UserData', { where: { ItemId: item } })).every((r) => !r.IsFavorite));
});
const app = await startProductionInstance({
  environment: {
    ...env,
    MEDIAMANAGER_INSTANCE: again,
    MEDIAMANAGER_POSTGRES: connectionString,
    MEDIAMANAGER_POSTGRES_SCHEMA: 'migration_b',
    MEDIAMANAGER_STORAGE: storage,
  },
});
try {
  const base = 'http://127.0.0.1:' + app.networkHost.listeners.find((l) => l.scheme === 'http').port;
  const authorization =
    'MediaBrowser Client="Migration", Device="MediaManager", DeviceId="roundtrip-mm", Version="1"';
  const session = await fetch(base + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Pw: pw }),
  });
  assert.equal(session.status, 200, 'cold MediaManager authenticates the imported account');
  const login = await session.json();
  const r = await fetch(base + '/Users/' + login.User.Id + '/Items/' + item.replaceAll('-', ''), {
    headers: { Authorization: authorization + ', Token="' + login.AccessToken + '"' },
  });
  assert.equal(r.status, 200, 'cold MediaManager can open the native item');
  assert.equal((await r.json()).Name, 'Edited in MediaManager');
} finally {
  await app.close();
}
const cross = [];
if (process.env.MEDIAMANAGER_EMBY_ALTERNATE_ROOT) {
  const fixed = process.env.MEDIAMANAGER_EMBY_ALTERNATE_ROOT;
  // An independent MediaManager instance has no Emby-origin archive to reuse.
  const standalone = path.join(root, 'standalone');
  await cloneDirectory(again, standalone, { skipState: true });
  let manager = standalone,
    schema = 'migration_b';
  for (const [serverRoot, version, label] of [
    [fixed, '4.9.1.0', 'fixed'],
    [releaseRoot, receipt.version, 'rolling'],
  ]) {
    const fresh = path.join(root, label + '-fresh'),
      dest = path.join(root, label + '-populated');
    await mkdir(path.join(fresh, 'config'), { recursive: true });
    await writeFile(
      path.join(fresh, 'config/system.xml'),
      '<ServerConfiguration><HttpServerPortNumber>' +
        port +
        '</HttpServerPortNumber><PublicPort>' +
        port +
        '</PublicPort><EnableRemoteAccess>false</EnableRemoteAccess><EnableUPnP>false</EnableUPnP><AutoRunWebApp>false</AutoRunWebApp></ServerConfiguration>',
    );
    await host(
      fresh,
      async () => {
        const who = (await call('/Startup/User')).Name;
        assert.equal(who, username);
        await call('/Startup/User', 'POST', { Name: who, Password: pw });
        await login();
        await call('/Startup/Complete', 'POST');
      },
      serverRoot,
      version,
    );
    const sourceUser = await postgres(
      schema,
      async (db) => (await db.rows('Users', { where: { Username: username } }))[0].Id,
    );
    const map = path.join(root, label + '-users.json');
    await writeFile(map, JSON.stringify({ users: { [sourceUser]: adminId } }));
    const result = await runEmby(
      'export',
      [...flags(manager, dest, schema), '--template', fresh, '--identity-map', map],
      env,
    );
    assert.equal(result.conflicts, 0, JSON.stringify(JSON.parse(await readFile(result.report, 'utf8')).issues));
    await host(
      dest,
      async () => {
        await login();
        const items = await call('/Users/' + adminId + '/Items?Recursive=true&IncludeItemTypes=Audio');
        assert.ok(
          items.Items.some((item) => item.Name === 'Edited in MediaManager'),
          'target native reads a new row from MediaManager',
        );
      },
      serverRoot,
      version,
    );
    manager = path.join(root, label + '-reimport');
    schema = 'migration_' + label;
    const back = await runEmby('import', flags(dest, manager, schema), env);
    assert.equal(back.conflicts, 0);
    assert.equal(
      await postgres(schema, async (db) => (await db.rows('BaseItems', { where: { Id: item } }))[0].Name),
      'Edited in MediaManager',
    );
    cross.push(version);
  }
}
const settingsRoundtrip = await verifySettingsRoundtrip();
const providerRoundtrip = await verifyProviderRoundtrip({
  root, original, wireId, item, postgres,
  exchange: (mode, source, output, schema, ...options) => runEmby(mode, [...flags(source, output, schema), ...options], env),
  async nativeProviders(instance) {
    let providers;
    await host(instance, async () => {
      await login();
      providers = (await call('/Users/' + adminId + '/Items/' + wireId + '?Fields=ProviderIds')).ProviderIds;
    });
    return providers;
  },
});
// Remove the fixture file and its live PG row, then check the returned native catalog.
await unlink(path.join(media, 'Round trip.wav'));
await postgres('migration_b', (db) => db.deleteWhere('BaseItems', { Id: item }));
const removed = path.join(root, 'removed');
const deletion = await runEmby('export', flags(again, removed, 'migration_b'), env);
assert.equal(deletion.conflicts, 0);
await host(removed, async () => {
  await login();
  const list = await call('/Users/' + adminId + '/Items?Recursive=true&IncludeItemTypes=Audio');
  assert.ok(!list.Items.some((x) => x.Id === wireId), 'deleted audio must remain absent');
});
await writeFile(
  path.join(releaseRoot, 'receipts/migration.json'),
  JSON.stringify(
    {
      version: receipt.version,
      assetId: receipt.assetId,
      sha256: receipt.sha256,
      imported,
      exported,
      reimported,
      originalAssetEdited: true,
      nativeArtworkBytesIdentical: true,
      nativeDeletion: true,
      unchangedTablesVerified: true,
      crossVersionColdReads: cross,
      officialColdRead: true,
      productionColdStart: true,
      settingsRoundtrip,
      providerRoundtrip,
    },
    null,
    2,
  ),
);

async function verifySettingsRoundtrip() {
  const source = path.join(root, 'settings-source'), template = path.join(root, 'settings-template');
  const manager = path.join(root, 'settings-manager'), target = path.join(root, 'settings-target');
  const back = path.join(root, 'settings-back'), schema = 'migration_settings';
  const users = [
    { name: 'IdLayout', flag: 'true' },
    { name: 'LegacyMissing' },
    { name: 'LegacyNull', flag: 'null' },
    { name: 'AmbiguousName', flag: 'true', duplicate: true },
  ];
  await cloneDirectory(original, source);
  await host(source, async () => {
    await login();
    for (const user of users) {
      user.id = (await call('/Users/New', 'POST', { Name: user.name })).Id;
      await call('/Users/' + user.id + '/Password', 'POST', { NewPw: pw });
    }
  });
  await runEmby('import', [...flags(source, manager, schema), '--mount-contract', contractFile], env);
  await cloneDirectory(source, template);
  const accounts = instance => new DatabaseSync(path.join(instance, 'data/users.db'));
  const originalAccounts = accounts(template);
  try {
    for (const user of users) {
      const { data } = originalAccounts.prepare('SELECT data FROM LocalUsersv2 WHERE guid=?').get(toBlob(user.id));
      const native = JSON.parse(data);
      delete native.Name;
      delete native.UsesIdForConfigurationPath;
      const name = '"Name" : "' + user.name + '"';
      const config = user.flag ? ', "UsesIdForConfigurationPath" : ' + user.flag : '';
      user.raw = '{ ' + (user.duplicate ? name + ',' : '') + name + config +
        ', "TargetExtension":{"wide":9007199254740993,"repeat":null,"repeat":{"private":[]}},' + JSON.stringify(native).slice(1);
      originalAccounts.prepare('UPDATE LocalUsersv2 SET data=? WHERE guid=?').run(user.raw, toBlob(user.id));
      if (user.flag !== 'true') {
        const directory = path.join(template, 'config/users', user.name);
        const idDirectory = path.join(template, 'config/users', nativeGuid(user.id).replaceAll('-', '').toLowerCase());
        try {
          await rename(idDirectory, directory);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'policy.xml'), '<UserPolicy><EnableMediaPlayback>false</EnableMediaPlayback></UserPolicy>');
        await writeFile(path.join(directory, 'fixture.txt'), user.name);
      }
    }
  } finally {
    originalAccounts.close();
  }
  function embyOptions(instance, edit) {
    const db = new DatabaseSync(path.join(instance, 'data/library.db'));
    try {
      const query = "SELECT e.ItemId,e.ExtradataTypeId,e.Value FROM ItemExtradata e JOIN ItemExtradataTypes t " +
        "ON t.ExtradataTypeId=e.ExtradataTypeId JOIN MediaItems m ON m.Id=e.ItemId WHERE t.Name='LibraryOptions' AND m.Name='Exchange'";
      const row = db.prepare(query).get();
      assert.ok(row);
      if (edit) db.prepare('UPDATE ItemExtradata SET Value=? WHERE ItemId=? AND ExtradataTypeId=?')
        .run(edit(row.Value), row.ItemId, row.ExtradataTypeId);
      return row.Value;
    } finally {
      db.close();
    }
  }
  const retained = '{ "Path":' + JSON.stringify(media) + ',"PathExtension":9007199254740993,"Duplicate":1,"Duplicate":2 }';
  const privateOptions = '"TargetOptions":9007199254740993,"TargetOptions":{"nested":9007199254740993}';
  embyOptions(template, original => {
    const parsed = JSON.parse(original);
    delete parsed.PathInfos;
    delete parsed.SaveLocalMetadata;
    return '{ "SaveLocalMetadata" : false, "PathInfos" : [' + retained + '], ' + privateOptions + ',' +
      JSON.stringify(parsed).slice(1);
  });
  const extra = path.join(root, 'settings-extra');
  await mkdir(extra);
  const xml = path.join(manager, 'data/root/default/Exchange/options.xml');
  const preservedPath = '<MediaPathInfo custom="kept"><Path>' + media + '</Path><PathExtension x="1">unknown</PathExtension></MediaPathInfo>';
  const keptXml = '<extension:LibraryData marker="yes" /><Unknown><![CDATA[<unchanged>]]></Unknown><!-- retained -->';
  await writeFile(xml, '<LibraryOptions xmlns:extension="urn:test">' + keptXml +
    '<SaveLocalMetadata note="keep">true</SaveLocalMetadata><PathInfos version="2">' + preservedPath +
    '<extension:ExtraInfo/><MediaPathInfo><Path>' + extra + '</Path></MediaPathInfo></PathInfos></LibraryOptions>');
  await postgres(schema, async db => {
    for (const user of users) await db.update('Users', { Id: nativeGuid(user.id) },
      { Username: 'Renamed' + user.name, NormalizedUsername: ('Renamed' + user.name).toUpperCase() });
  });
  const exported = await runEmby('export', [...flags(manager, target, schema), '--template', template], env);
  const issues = JSON.parse(await readFile(exported.report, 'utf8')).issues;
  assert.ok(issues.some(i => i.field === 'Username' && i.id === nativeGuid(users.at(-1).id) &&
    i.reason === 'Ambiguous JSON property Name'), JSON.stringify(issues));
  const targetAccounts = accounts(target);
  try {
    for (const user of users) {
      const { data } = targetAccounts.prepare('SELECT data FROM LocalUsersv2 WHERE guid=?').get(toBlob(user.id));
      let expected = user.duplicate ? user.raw : user.raw.replace('"Name" : "' + user.name, '"Name" : "Renamed' + user.name);
      if (!user.flag) expected = expected.slice(0, -1) + ',"UsesIdForConfigurationPath":true}';
      if (user.flag === 'null') expected = expected.replace('"UsesIdForConfigurationPath" : null', '"UsesIdForConfigurationPath" : true');
      assert.ok(data === expected, user.name + ' raw account fields changed');
      if (user.flag !== 'true') assert.equal(
        await readFile(path.join(target, 'config/users', user.id.replaceAll('-', '').toLowerCase(), 'fixture.txt'), 'utf8'), user.name);
    }
  } finally {
    targetAccounts.close();
  }
  const options = embyOptions(target);
  assert.ok(options.includes(retained) && options.includes(privateOptions), options);
  assert.equal(JSON.parse(options).SaveLocalMetadata, true);
  assert.deepEqual(JSON.parse(options).PathInfos.map(value => value.Path), [media, extra]);
  await host(target, async () => {
    for (const user of users.filter(user => !user.duplicate)) {
      token = null;
      const session = await call('/Users/AuthenticateByName', 'POST', { Username: 'Renamed' + user.name, Pw: pw });
      assert.equal(session.User.Id, user.id);
      if (user.flag !== 'true') assert.equal(session.User.Policy.EnableMediaPlayback, false);
    }
    await login();
  });
  const replacement = path.join(root, 'settings-replacement');
  await mkdir(replacement);
  embyOptions(target, current => JSON.stringify({ ...JSON.parse(current), SaveLocalMetadata: false,
    PathInfos: [{ Path: replacement }, { Path: media }] }));
  await runEmby('import', [...flags(target, back, schema + '_back'), '--mount-contract', contractFile], env);
  const xmlBack = await readFile(path.join(back, 'data/root/default/Exchange/options.xml'), 'utf8');
  assert.ok(xmlBack.includes(keptXml) && xmlBack.includes(preservedPath), xmlBack);
  assert.ok(xmlBack.includes('<SaveLocalMetadata note="keep">false</SaveLocalMetadata>') &&
    xmlBack.includes('<PathInfos version="2">') && xmlBack.includes('<extension:ExtraInfo/>'), xmlBack);
  assert.ok(xmlBack.indexOf(replacement) < xmlBack.indexOf(preservedPath) && !xmlBack.includes(extra), xmlBack);
  return { accountBytes: true, legacyPolicyAndPassword: true, ambiguousName: true, jsonAndXmlOptions: true };
}
