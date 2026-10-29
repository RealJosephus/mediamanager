import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import { IntroProviderManager } from '../../src/library/intro-providers.js';
import { createIntroPathResolver } from '../../src/library/intro-path-resolver.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { getNewItemId } from '../../src/core/identity.js';
import { guid, idKey, nonemptyId, libraryError } from '../../src/library/records.js';
import { nativeFileName } from '../../src/library/native-path.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const fixture = new URL('./fixtures/intro-providers/input.json', import.meta.url);
const bytes = await readFile(fixture), input = JSON.parse(bytes);
const nativeType = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.' : type === 'Audio' ? 'Audio.' : ''}${type}`;
export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('intro shutdown cancels provider work before HTTP request draining', async t => {
  const entered = Promise.withResolvers(), diagnostics = [];
  let providerSignal;
  const manager = new IntroProviderManager({ extensions: () => [{ async getIntros(item, { signal }) {
    providerSignal = signal;
    entered.resolve(); await delay(30000, undefined, { signal }); return [];
  } }], logger: { error: (...args) => diagnostics.push(args) } });
  const pending = manager.getIntros({}, {}); await entered.promise;
  manager.close();
  assert.deepEqual(await pending, []);
  assert.equal(providerSignal.aborted, true);
  t.diagnostic(inspect({ diagnostics }, { depth: null }));
});

test('intro provider ordering and resolution match the current native LibraryManager', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'intro-providers-' + randomUUID());
  await mkdir(output);
  const recording = await recordOracle({ project: 'tests/library/fixtures/intro-providers/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(fixture), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json'), 'utf8'));
  assert.equal(recording.passed, true);
  assert.equal(native.actualLibraryManagerExecution, true);
  assert.equal(native.inputSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(native.assemblies.find(value => value.FullName.startsWith('jellyfin,')).sha256, recording.jellyfinDll.sha256);
  const results = [];
  for (const sample of input.cases) {
    const configuration = { ...input.configuration, ...sample.configuration };
    const rows = new Map(input.items.map(item => [idKey(item.id), { Id: item.id, Type: item.type, Name: item.name }]));
    const paths = new Map(input.paths.map(item => [item.path, item]));
    for (const definition of input.paths) if (definition.type && definition.saved) {
      const Id = getNewItemId(definition.path, nativeType(definition.type), { programDataPath: input.programDataPath,
        enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds });
      rows.set(idKey(Id), { Id, Type: definition.type, Name: 'Persisted path video', Path: definition.path });
    }
    const diagnostics = [];
    const pipeline = new DirectoryItemResolverPipeline({ programDataPath: input.programDataPath, configuration,
      onError: error => diagnostics.push(error.message), resolvers: [{ id: 'controlled-intro',
        nativeTypes: Object.fromEntries(['Video', 'Movie', 'Audio'].map(type => [nativeType(type), { isFolder: false }])),
        resolveMultiple() { throw new Error('ResolvePath must use only the single-item chain.'); },
        resolveFile({ candidate }) {
          const definition = paths.get(candidate.identityPath);
          if (!definition?.type) return null;
          if (definition.throw) throw new Error('Controlled resolver failure.');
          return { nativeType: nativeType(definition.type), primary: candidate, consumedPaths: [candidate], traversal: 'none',
            draft: { Name: 'Unpersisted resolver name', IsFolder: false, MediaType: definition.type === 'Audio' ? 'Audio' : 'Video', SourceType: 'Library' } };
        },
      }] });
    const access = new Map(input.paths.map(definition => ['/intros/' + nativeFileName(definition.path), definition.path]));
    const resolvePath = createIntroPathResolver({ resolverPipeline: pipeline, applicationRootPath: input.programDataPath + '\\root',
      ignoreRule: { shouldIgnore: async () => false },
      identityMap: { resolve: ({ identityPath }) => '/intros/' + nativeFileName(identityPath), identityFor: accessPath => ({ identityPath: access.get(accessPath) }) },
      vfs: { stat: async () => ({ kind: 'file', size: 100n }) },
    });
    const starts = [], completions = [];
    const providers = sample.providers.map(provider => ({ async getIntros(item, { user }) {
      assert.equal(item.Name, 'Main feature'); assert.equal(user.Name, 'Intro reader');
      starts.push(provider.name);
      if (provider.delayMs) await delay(provider.delayMs);
      if (provider.throw) throw new Error('Controlled provider failure.');
      completions.push(provider.name); return provider.intros;
    } }));
    const manager = new IntroProviderManager({ extensions: () => providers, resolvePath,
      logger: { error: error => diagnostics.push(error.message ?? error) },
      getItem: async value => {
        const id = guid(value);
        if (!nonemptyId(id)) throw libraryError(400, "Guid can't be empty (Parameter 'id')");
        return rows.get(idKey(id)) ?? null;
      },
    });
    let status = 200, items = [];
    try { items = (await manager.getIntros({ Name: 'Main feature' }, { Name: 'Intro reader' }))
      .map(({ Id, Type, Name }) => ({ Id: idKey(Id), Type, Name })); }
    catch (error) { if (error.status !== 400) throw error; status = 400; }
    results.push({ name: sample.name, status, items, starts, completions });
  }
  await writeFile(path.join(output, 'node.json'), JSON.stringify({ results, scope: 'Production provider manager and single-item path adapter with controlled lookup/storage/resolver collaborators.' }, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(results, native.results);
});
