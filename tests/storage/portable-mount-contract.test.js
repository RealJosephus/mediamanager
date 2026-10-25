import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPortableMountRetarget,
  assertPortableMountStorageConfiguration,
  canonicalPortableMountContract,
  parsePortableMountContract,
  portableMountContractStateKey,
  projectPortableJellyfinPath,
  readPortableMountContract,
  serializePortableMountContract,
  writePortableMountContract,
} from '../../src/storage/portable-mount-contract.js';

const windowsContract = () => ({
  mounts: [{
    mountId: 'movies-main', identityRoot: 'Z:\\Media', accessRoot: '/vfs/movies', pathStyle: 'windows',
    caseSensitive: false, returnPolicy: 'required'
  }]
});

const posixContract = () => ({
  mounts: [{
    mountId: 'movies-main', identityRoot: '/srv/jellyfin/media', accessRoot: '/vfs/movies', pathStyle: 'posix',
    caseSensitive: true, returnPolicy: 'required'
  }]
});

test('portable mount contract contains only stable Jellyfin/VFS path metadata', () => {
  const canonical = canonicalPortableMountContract(windowsContract());
  assert.equal(parsePortableMountContract(serializePortableMountContract(canonical)).mounts[0].identityRoot, 'Z:\\Media');
  const versioned = windowsContract(); versioned.formatVersion = 1;
  assert.throws(() => canonicalPortableMountContract(versioned), /must contain exactly mounts/u);
  for (const extra of [
    { baseUrl: 'https://storage.invalid' },
    { credentialRef: 'TOKEN' },
    { backend: 'webdav' },
    { password: 'secret' },
  ]) {
    const value = windowsContract(); Object.assign(value.mounts[0], extra);
    assert.throws(() => canonicalPortableMountContract(value), /contain exactly/u);
  }
  const url = windowsContract(); url.mounts[0].identityRoot = 'https://storage.invalid/media';
  assert.throws(() => canonicalPortableMountContract(url), /filesystem path, not a URL/u);
  const invalidWindowsRoot = windowsContract(); invalidWindowsRoot.mounts[0].identityRoot = 'Z:\\Media\\CON';
  assert.throws(() => canonicalPortableMountContract(invalidWindowsRoot), /cannot be represented on Windows/u);
  const uncUserInfo = windowsContract(); uncUserInfo.mounts[0].identityRoot = '\\\\user@server\\media';
  assert.throws(() => canonicalPortableMountContract(uncUserInfo), /cannot contain user information/u);
  const invalidUncShare = windowsContract(); invalidUncShare.mounts[0].identityRoot = '\\\\server\\CON';
  assert.throws(() => canonicalPortableMountContract(invalidUncShare), /cannot be represented on Windows/u);
  const rootAccess = windowsContract(); rootAccess.mounts[0].accessRoot = '/';
  assert.throws(() => canonicalPortableMountContract(rootAccess), /named VFS namespace/u);
});

test('portable mount contract persists canonically through generic PostgreSQL state and cannot be replaced', async () => {
  const state = new Map();
  const database = {
    dialect: 'postgres',
    async getState(key) { return state.get(key); },
    async setState(key, value) { state.set(key, value); },
  };
  const written = await writePortableMountContract(database, windowsContract());
  assert.equal(state.get(portableMountContractStateKey), serializePortableMountContract(written));
  assert.deepEqual(await readPortableMountContract(database), written);
  await assert.rejects(writePortableMountContract(database, posixContract()), /differs/u);
  await assert.rejects(writePortableMountContract(database, posixContract(), { replace: true }), /differs/u);
  assert.deepEqual(await readPortableMountContract(database), written);
});

test('explicit retarget rewrites Windows identity paths to POSIX and rejects VFS access paths', () => {
  const source = canonicalPortableMountContract(windowsContract());
  const target = assertPortableMountRetarget(source, posixContract());
  assert.equal(projectPortableJellyfinPath('z:\\MEDIA\\Films\\One.mkv', source, target), '/srv/jellyfin/media/Films/One.mkv');
  assert.equal(projectPortableJellyfinPath('Z:\\Media\\Films\\One.mkv', source), 'Z:\\Media\\Films\\One.mkv');
  assert.equal(projectPortableJellyfinPath('z:/MEDIA/Films/One.mkv', source), 'z:/MEDIA/Films/One.mkv');
  assert.throws(() => projectPortableJellyfinPath('/vfs/movies/Films/One.mkv', source, target), /VFS access path/u);
  assert.throws(() => projectPortableJellyfinPath('https://storage.invalid/Films/One.mkv', source, target), /storage protocol URL/u);
  assert.equal(projectPortableJellyfinPath('https://stream.invalid/One.m3u8', source, target, { protocolPolicy: 'media' }),
    'https://stream.invalid/One.m3u8');
  assert.throws(() => projectPortableJellyfinPath('rclone:remote/One.mkv', source, target, { protocolPolicy: 'media' }),
    /storage protocol URL/u);
  assert.equal(projectPortableJellyfinPath('ftp://stream.invalid/One.m3u8', source, target, { protocolPolicy: 'media' }),
    'ftp://stream.invalid/One.m3u8');
  assert.throws(() => projectPortableJellyfinPath('https://user:secret@stream.invalid/One.m3u8', source, target, {
    protocolPolicy: 'media',
  }), /storage protocol URL/u);
  assert.throws(() => projectPortableJellyfinPath('Y:\\Other\\One.mkv', source, target, { requireMount: true }),
    /outside every portable mount/u);
  assert.throws(() => projectPortableJellyfinPath('relative\\One.mkv', source, target, { requireMount: true }),
    /outside every portable mount/u);
  assert.equal(projectPortableJellyfinPath('%AppDataPath%\\playlists', source, target, {
    allowInternalPath: true, requireMount: true,
  }), '%AppDataPath%\\playlists');
  assert.throws(() => projectPortableJellyfinPath('%AppDataPath%\\..\\secret', source, target, {
    allowInternalPath: true, requireMount: true,
  }), /outside every portable mount/u);
  assert.throws(() => projectPortableJellyfinPath('custom:opaque-value', source, target, { requireMount: true }),
    /storage protocol URL/u);
  assert.throws(() => projectPortableJellyfinPath('custom:opaque-value', source, target),
    /storage protocol URL/u);
  assert.equal(projectPortableJellyfinPath('ImagePath: \u4e2d\u6587 / caf\u00e9', source, target),
    'ImagePath: \u4e2d\u6587 / caf\u00e9');
  const incompatible = posixContract(); incompatible.mounts[0].accessRoot = '/other';
  assert.throws(() => assertPortableMountRetarget(source, incompatible), /preserve mountId, accessRoot and returnPolicy/u);
});

test('explicit retarget rewrites POSIX identity paths to Windows with target filesystem validation', () => {
  const source = posixContract(); source.mounts[0].identityRoot = '/mnt/media';
  const target = windowsContract(); target.mounts[0].identityRoot = 'R:\\Jellyfin';
  assert.equal(projectPortableJellyfinPath('/mnt/media/Films/One.mkv', source, target),
    'R:\\Jellyfin\\Films\\One.mkv');
  assert.throws(() => projectPortableJellyfinPath('/mnt/media/Films/CON.mkv', source, target),
    /cannot be represented on Windows/u);
});

test('retarget rejects output that aliases an internal VFS access namespace', () => {
  const source = windowsContract();
  const target = posixContract(); target.mounts[0].identityRoot = '/vfs/movies/identity';
  assert.throws(() => projectPortableJellyfinPath('Z:\\Media\\Films\\One.mkv', source, target, {
    requireMount: true,
  }), /retarget produced VFS access path/u);
});

test('retarget rejects a path captured by a different nested target mount', () => {
  const source = windowsContract();
  source.mounts.push({
    ...source.mounts[0],
    mountId: 'special-main',
    identityRoot: 'Y:\\Special',
    accessRoot: '/vfs/special',
  });
  const target = posixContract();
  target.mounts.push({
    ...target.mounts[0],
    mountId: 'special-main',
    identityRoot: '/srv/jellyfin/media/special',
    accessRoot: '/vfs/special',
  });
  assert.throws(() => projectPortableJellyfinPath(
    'Z:\\Media\\special\\One.mkv', source, target, { requireMount: true }),
  /changed portable mount identity/u);
});

test('VFS access namespaces fail closed before broad POSIX identity mounts', () => {
  const source = posixContract();
  source.mounts[0].identityRoot = '/';
  assert.throws(() => projectPortableJellyfinPath('/vfs/movies/Films/One.mkv', source, source, {
    requireMount: true,
  }), /VFS access path/u);
  assert.throws(() => projectPortableJellyfinPath('/srv/media\\mixed-separator.mkv', posixContract(), posixContract(), {
    requireMount: true,
  }), /outside every portable mount/u);
});

test('portable mount identity roots cannot become ambiguous through mixed case policies', () => {
  const value = windowsContract();
  value.mounts.push({ ...value.mounts[0], mountId: 'movies-alias', identityRoot: 'z:\\MEDIA',
    accessRoot: '/vfs/alias', caseSensitive: true });
  assert.throws(() => canonicalPortableMountContract(value), /identity roots are ambiguous/u);
});

test('runtime storage mappings must exactly match and be backed by the persisted contract', () => {
  const configuration = {
    mounts: [{ path: '/vfs', instanceId: 'remote', capabilities: {} }],
    prefixes: [{ identityRoot: 'z:\\MEDIA', accessRoot: '/vfs/movies', style: 'windows', caseSensitive: false,
      returnAccess: 'Validated return path' }],
    bindings: [{ itemId: 'item', accessPath: '/vfs/movies/One.mkv' }],
  };
  assert.deepEqual(assertPortableMountStorageConfiguration(windowsContract(), configuration),
    canonicalPortableMountContract(windowsContract()));

  const drifted = structuredClone(configuration);
  drifted.prefixes[0].identityRoot = 'Y:\\Media';
  assert.throws(() => assertPortableMountStorageConfiguration(windowsContract(), drifted),
    /differ from the persisted/u);
  const unbacked = structuredClone(configuration);
  unbacked.mounts[0].path = '/other';
  assert.throws(() => assertPortableMountStorageConfiguration(windowsContract(), unbacked),
    /not backed by a configured VFS mount/u);
  const escapedBinding = structuredClone(configuration);
  escapedBinding.bindings[0].accessPath = '/other/One.mkv';
  assert.throws(() => assertPortableMountStorageConfiguration(windowsContract(), escapedBinding),
    /outside the persisted/u);
});
