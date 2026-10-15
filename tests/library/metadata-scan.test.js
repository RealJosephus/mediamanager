import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { idKey } from '../../src/library/records.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';

const input = JSON.parse(await readFile(new URL('./fixtures/metadata-scan/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/metadata-scan/native.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('metadata traversal oracle seals native sources, callbacks, input and recorded output', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/metadata-scan/provenance.json', import.meta.url), 'utf8'));
  for (const [name, filename] of Object.entries({ input: './fixtures/metadata-scan/input.json', native: './fixtures/metadata-scan/native.json',
    oracle: './fixtures/metadata-scan/Program.cs', project: './fixtures/metadata-scan/Oracle.csproj', buildProperties: '../Directory.Build.props' })) {
    assert.equal(hash(await readFile(new URL(filename, import.meta.url))), provenance.files[name].sha256, name);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(native.results.length, input.length);
  for (const scenario of native.results) assert.equal(scenario.error ?? null, null, `${scenario.name} must not hide an oracle callback failure`);
});

function fixture(scenario) {
  const byName = new Map(), byId = new Map(), children = new Map(), links = [], definitions = new Map();
  let sequence = 0;
  const create = (definition, parent) => {
    const item = { Id: String(++sequence), Type: definition.type, Name: definition.name, ParentId: parent?.Id,
      IsFolder: ['Folder', 'Series', 'Season', 'MusicAlbum'].includes(definition.type),
      Path: Object.hasOwn(definition, 'path') ? definition.path : definition.virtual ? null : `https://media.invalid/${definition.name}`,
      PremiereDate: definition.premiere, Artists: definition.artists ?? [], AlbumArtists: definition.albumArtists ?? [] };
    item.LocationType = item.Path ? 'Remote' : 'Virtual';
    byName.set(item.Name, item); byId.set(idKey(item.Id), item); definitions.set(item.Id, definition);
    children.set(item.Id, (definition.children ?? []).map(child => create(child, item)));
    return item;
  };
  const root = create(scenario.root);
  for (const definition of scenario.external ?? []) create(definition);
  for (const [Id, definition] of definitions) {
    for (const [index, name] of (definition.links ?? []).entries()) links.push({ ParentId: Id, ChildId: byName.get(name).Id, SortOrder: index });
    if (definition.byName === false) byId.get(Id).ParentId = root.Id;
  }
  const state = { items: [...byId.values()], byId, links, children: item => [...children.get(item.Id)] };
  const calls = [], artistLookups = [], errors = [], controller = new AbortController();
  const metadata = { loadContext: { linkedChildren: { async flushReleases() {} } }, validateRefresh() {}, async refresh(Id, options) {
    options.signal?.throwIfAborted();
    const item = byId.get(idKey(Id));
    calls.push({ name: item.Name, type: item.Type, metadataMode: options.MetadataRefreshMode, imageMode: options.ImageRefreshMode,
      automated: options.IsAutomated, replaceAllMetadata: options.ReplaceAllMetadata, forceSave: options.ForceSave,
      ...(options.RefreshPaths == null ? {} : { refreshPaths: options.RefreshPaths }) });
    if (item.Name === scenario.fail) throw Object.assign(new Error('Injected refresh failure'), { name: 'IOException' });
    if (item.Name === scenario.cancelAfter) controller.abort(Object.assign(new Error('The operation was canceled.'), { name: 'OperationCanceledException' }));
    return { UpdateType: definitions.get(item.Id).updateType ?? ItemUpdateType.None };
  } };
  const library = { store: { run: operation => operation({}) }, load: async () => state,
    itemCreation: { retainItem: () => ({ release() {} }) },
    getArtist: async name => { artistLookups.push(name); return byName.get(name); } };
  const physical = item => item.Type === 'MusicArtist' && !item.ParentId ? [] : children.get(item.Id);
  const recursive = item => {
    const result = new Map();
    const visit = parent => { for (const child of physical(parent)) { result.set(child.Id, child); if (child.IsFolder) visit(child); } };
    visit(item);
    for (const link of links.filter(link => link.ParentId === item.Id).sort((a,b)=>a.SortOrder-b.SortOrder)) {
      const child = byId.get(idKey(link.ChildId)); if (child) result.set(child.Id, child);
    }
    return [...result.values()];
  };
  const configuration = { LibraryScanFanoutConcurrency: 1 };
  const scanner = new LibraryMetadataScanService({ library, metadata, configuration,
    scheduler: new LibraryTaskScheduler({ configuration }),
    stateLoader: async reference => ({ children: { physical: async item => ownedSequence(physical(item)),
      recursive: async item => ownedSequence(recursive(item)) },
      item: byId.get(idKey(typeof reference === 'string' ? reference : reference.Id)), async close() {} }),
    logger: { error: (error, log) => errors.push({ type: error.name, message: error.message, log }) } });
  const options = { MetadataRefreshMode: scenario.metadataMode ?? 'Default', ImageRefreshMode: scenario.imageMode ?? 'None',
    IsAutomated: scenario.automated ?? true, ReplaceAllMetadata: scenario.replaceAllMetadata ?? false,
    ForceSave: scenario.forceSave ?? false, RefreshPaths: scenario.refreshPaths ?? [], signal: controller.signal };
  return { scanner, library, metadata, root, children, byName, controller, calls, artistLookups, errors, options };
}

function ownedSequence(items) {
  let closed = false;
  return { async *pages() { assert.equal(closed,false); for (let index=0;index<items.length;index+=128) yield items.slice(index,index+128); },
    async count() { assert.equal(closed,false); return BigInt(items.length); }, async close() { closed=true; } };
}

for (const scenario of input) test(`native metadata scan traversal: ${scenario.name}`, async () => {
  const { scanner, root, calls, artistLookups, errors, options } = fixture(scenario);
  const receipt = await scanner.refreshChildren(root, options, { recursive: scenario.recursive ?? true });
  const expected = native.results.find(entry => entry.name === scenario.name);
  assert.deepEqual({ name: scenario.name, calls, artistLookups, errors, error: null }, { ...expected, error: expected.error ?? null });
  assert.equal(receipt.attemptedCount, calls.length);
  assert.equal(receipt.errors.length, errors.length);
  assert.equal(receipt.cancelled, Boolean(scenario.cancelAfter));
});

test('ordinary folder children are reloaded after its metadata provider commits', async () => {
  const scenario = input[0];
  const { scanner, metadata, root, byName, children, options, calls } = fixture(scenario);
  const refresh = metadata.refresh;
  metadata.refresh = async (Id, options) => {
    const result = await refresh(Id, options);
    if (Id === byName.get('nested').Id) children.set(Id, [byName.get('sibling')]);
    return result;
  };
  await scanner.refreshChildren(root, options);
  assert.deepEqual(calls.map(entry => entry.name), ['nested', 'sibling', 'sibling']);
});

test('bounded native fanout drains failures and nested folders without occupying another worker', async () => {
  const { scanner, metadata, root, options, calls, byName } = fixture(input[0]);
  scanner.configuration.LibraryScanFanoutConcurrency = 2;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, maximum = 0;
  const refresh = metadata.refresh;
  metadata.refresh = async (Id, options) => {
    maximum = Math.max(maximum, ++active);
    try {
      if (Id === byName.get('nested').Id) { entered.resolve(); await release.promise; }
      if (Id === byName.get('sibling').Id) { await entered.promise; release.resolve(); }
      return await refresh(Id, options);
    } finally { active--; }
  };
  const result = await scanner.refreshChildren(root, options);
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.equal(result.attemptedCount, 3); assert.deepEqual(result.errors, []);
  assert.deepEqual(calls.map(entry => entry.name).sort(), ['movie', 'nested', 'sibling']);
});

test('accessible child traversal preserves the supplied snapshot order and excludes retained siblings', async () => {
  const { scanner, root, byName, calls, options } = fixture(input[0]);
  assert.equal(root.Name, 'root');
  const result = await scanner.refreshAccessibleChildren(ownedSequence([byName.get('sibling'), byName.get('nested')]), options,
    { recursive: false });
  assert.deepEqual(calls.map(entry => entry.name), ['sibling', 'nested']);
  assert.equal(result.attemptedCount, 2);
  assert.deepEqual(result.errors, []);
});

test('container entry refreshes a Series itself before and after its native child order', async () => {
  const scenario = input.find(value => value.name === 'series refreshes seasons before episodes and skips old virtual episodes');
  const { scanner, byName, calls, options } = fixture(scenario);
  const result = await scanner.refreshContainer(byName.get('series'), options);
  const expected = native.results.find(value => value.name === scenario.name);
  assert.deepEqual(calls, expected.calls);
  assert.equal(calls[0].name, 'series');
  assert.equal(calls.at(-1).name, 'series');
  assert.equal(result.attemptedCount, calls.length);
});

test('an empty Series container refreshes itself twice without reporting invalid progress', async () => {
  const scenario = { root: { type: 'Series', name: 'empty' } };
  const { scanner, root, calls, options } = fixture(scenario), progress = [];
  await scanner.refreshContainer(root, options, { reportProgress: value => progress.push(value) });
  assert.deepEqual(calls.map(entry => entry.name), ['empty', 'empty']);
  assert.deepEqual(progress, []);
});

test('a pre-cancelled accessible workset is skipped and completes scheduler progress', async () => {
  const { scanner, byName, controller, calls, options } = fixture(input[0]), progress = [];
  controller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  const result = await scanner.refreshAccessibleChildren(ownedSequence([byName.get('nested'), byName.get('sibling')]), options,
    { recursive: true, reportProgress: value => progress.push(value) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.cancelled, true);
  assert.deepEqual(progress, [100]);
});

test('provider failures remain receipt failures rather than scheduler errors', async () => {
  const { scanner, metadata, byName, options } = fixture(input[0]);
  metadata.refresh = async () => ({ UpdateType: ItemUpdateType.None, Failures: 2 });
  const result = await scanner.refreshAccessibleChildren(ownedSequence([byName.get('sibling')]), options, { recursive: false });
  assert.equal(result.attemptedCount, 1);
  assert.equal(result.providerFailures, 2);
  assert.deepEqual(result.errors, []);
});

test('ordinary recursive child cache is released after an isolated descendant failure', async () => {
  const scenario = input.find(value => value.name === 'leaf failure is logged while sibling work continues');
  const { scanner, byName, options } = fixture(scenario);
  const nested = byName.get('nested'), stale = { Id: 'stale' }, fresh = { Id: 'fresh' };
  setFolderChildren(nested, [stale]);
  const result = await scanner.refreshAccessibleChildren(ownedSequence([nested]), options, { recursive: true });
  assert.equal(result.errors.length, 1);
  let queried = 0;
  assert.deepEqual(readCachedFolderChildren(nested, {}, () => { queried++; return [fresh]; }), [fresh]);
  assert.equal(queried, 1);
});
