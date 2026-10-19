import path from 'node:path';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { dependencyClosure, describeFile, filesIn, sha256 } from './inventory.js';
import { recordedInput, recordedInputMapPath, repositoryRoot, validationPath } from './paths.js';
import { collageFontFiles } from '../../src/images/font-collection.js';
import { resolveCollageSystemFonts } from '../../src/images/system-fonts/index.js';
import { alistBuildInputs } from './alist-inputs.js';
import { nativeBuildInputs } from './native-build-inputs.js';
import { nativeInstanceInputs } from './native-instance-inputs.js';
import { currentNativeSqliteInputs } from './current-native-sqlite-inputs.js';
import { jellyfinWebInputs } from './jellyfin-web-inputs.js';
import { browserInputs } from './browser-inputs.js';

const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);

// These loaders read historical descriptors as bytes, rather than merely
// quoting provenance. Keep their reviewed execution contract at the actual
// caller/kind boundary: another kind imported by the shared loader is optional.
const executionManifests = new Map([
  ['tests/consumer-contracts/consumer-readers.test.js', ['consumer', 'readers']],
  ['tests/playback/http-native.test.js', ['consumer', 'readers']],
  ['tests/consumer-contracts/date-roundtrip.test.js', ['consumer', 'date-roundtrip']],
  ['tests/metadata/playlist-items.test.js', ['consumer', 'playlist-layouts']],
  ...['local-xml-provider', 'nfo-episode-blocks', 'nfo-scalar-provider']
    .map(kind => [`tests/metadata/${kind}.test.js`, ['reader-layout', kind]]),
  ['tests/library/genre-studio-filter-http.test.js', ['byname']],
  ...['native-byname-filter-inputs', 'native-byname-filter-wire']
    .map(name => [`tests/library/${name}.test.js`, ['byname', 'all']]),
]);
const sealedExecutionManifests = new Map([
  ['tests/metadata/search-lookup.test.js', ['search-lookup-sources', 'tests/metadata/fixtures/metadata-search-lookup/provenance.json']],
  ['tests/plugins/native-repeat.test.js', ['nfo-repeats', 'tests/metadata/fixtures/nfo-partial-reader/repeat.json']],
  ['tests/core/parental-rating-unicode.test.js', ['sealed-rating', 'tests/core/fixtures/parental-rating-unicode/provenance.json']],
  ['tests/http/password-reset-consumer.test.js', ['password-reader', 'tests/http/fixtures/password-reset/consumer.json']],
  ['tests/http/shows-api.test.js', ['sealed-shows', 'tests/http/fixtures/shows-api/provenance.json']],
  ['tests/http/startup.test.js', ['sealed-startup', 'tests/http/fixtures/startup/provenance.json']],
  ['tests/images/splashscreen.test.js', ['splashscreen-sources', 'tests/images/fixtures/splashscreen/files.json']],
  ['tests/library/collection-playlist-resolution.test.js', ['sealed-collection-playlist', 'tests/library/fixtures/collection-playlist-resolution/provenance.json']],
  ['tests/library/collection-post-scan.test.js', ['collection-task-sources', 'tests/library/fixtures/collection-post-scan/provenance.json']],
  ['tests/library/native-conflict-inputs.js', ['conflict', 'tests/library/fixtures/native-conflict-inputs/binding.json']],
  ['tests/core/native-charset.test.js', ['sealed-charset', 'tests/core/fixtures/native-charset/provenance.json']],
  ['tests/core/native-json-encoder.test.js', ['sealed-json', 'tests/core/fixtures/native-json-encoder/provenance.json']],
  ['tests/http/item-deletion.test.js', ['sealed-http-delete', 'tests/http/fixtures/item-deletion/provenance.json']],
  ['tests/library/delete-dto-permission.test.js', ['sealed-delete-dto', 'tests/library/fixtures/delete-dto-permission/provenance.json']],
  ['tests/library/native-item-cache.test.js', ['sealed-warm', 'tests/library/fixtures/native-item-cache/provenance.json']],
  ['tests/library/warm-item-deletion.test.js', ['sealed-warm', 'tests/library/fixtures/warm-item-deletion/provenance.json']],
  ['tests/http/warm-item-deletion.test.js', ['sealed-warm', 'tests/http/fixtures/warm-item-deletion/provenance.json']],
  ['tests/metadata/local-xml-stream.test.js', ['sealed-xml-prefix', 'tests/metadata/fixtures/local-xml-save-prefix/provenance.json']],
  ['tests/metadata/local-xml-prefix-seal.test.js', ['sealed-xml-prefix-history', 'tests/metadata/fixtures/local-xml-save-prefix/provenance.json']],
]);

export function executionManifestContract(consumer) {
  const sealed = sealedExecutionManifests.get(consumer);
  if (sealed) return { kind: sealed[0], manifest: sealed[1], loader: sealed[0] === 'sealed-warm'
    ? 'tests/library/warm-fixture-seal.js' : consumer };
  const contract = executionManifests.get(consumer);
  if (!contract) return null;
  const [kind, argument] = contract;
  return { kind, ...(argument ? { argument } : {}),
    loader: kind === 'consumer' ? 'tests/consumer-contracts/fixture.js'
      : kind === 'reader-layout' ? 'tests/metadata/reader-layout-fixture.js' : 'tests/library/native-byname-filter-inputs.js',
    manifest: kind === 'consumer' ? `tests/consumer-contracts/fixtures/${argument}/provenance.json`
      : kind === 'reader-layout' ? 'tests/metadata/fixtures/reader-layouts/provenance.json'
        : 'tests/library/fixtures/native-byname-filter-inputs/binding.json' };
}

// Export the descriptor projection so changes to the loader contracts can be
// checked with small in-repository records, without requiring historical tools.
export function executionManifestReferences(contract, content, filename) {
  const references = [], local = name => path.resolve(path.dirname(filename), name);
  const add = (descriptor, options = {}) => {
    if (!descriptor || typeof descriptor.filename !== 'string') throw new Error('Invalid execution input descriptor.');
    references.push({ ...descriptor, ...options });
  };
  if (contract.kind === 'search-lookup-sources') {
    for (const [name, descriptor] of Object.entries(content.files)) {
      add({ ...descriptor, filename: name === 'buildProperties'
        ? path.resolve(repositoryRoot, 'tests/Directory.Build.props') : local(descriptor.filename) });
    }
    for (const source of content.sources) add({ filename: path.resolve(process.env.MEDIAMANAGER_JELLYFIN_SOURCE ?? 'D:/jellyfin',
      source.filename.slice('D:/jellyfin/'.length)), sha256: source.sha256 });
    add(content.oracle.record);
  } else if (contract.kind === 'nfo-repeats' || contract.kind === 'nfo-repeat') {
    add(content.input);
    for (const record of content.recordings) for (const descriptor of [record.dotnet, record.jellyfinDll,
      record.oracleAssembly, ...record.sourceFiles, ...record.outputs]) add(descriptor);
    for (const descriptor of content.outputs) add(descriptor);
    add({ filename: local('provenance.json') }, { nested: 'nfo-repeat-source' });
    if (contract.kind === 'nfo-repeats') add({ filename: local('../nfo-scalar-provider/repeat.json') }, { nested: 'nfo-repeat' });
  } else if (contract.kind === 'nfo-repeat-source') {
    for (const [filename, sha256] of Object.entries(content.jellyfin.sources)) {
      for (const root of [content.jellyfin.root, 'D:/mediamanager-validation/20261005/jellyfin-baseline/source']) {
        add({ filename: path.join(root, filename), sha256 });
      }
    }
    for (const [filename, descriptor] of Object.entries(content.runtime.assemblies)) {
      add({ ...descriptor, filename: path.join(path.dirname(content.runtime.jellyfinDll.path), filename) });
    }
  } else if (contract.kind === 'sealed-rating') {
    for (const descriptor of [content.rawRecording, content.oracleAssembly]) add(descriptor);
    for (const source of content.sources) for (const name of ['designated', 'isolated']) add({ ...source[name], sha256: source.sha256 });
    for (const assembly of content.actualLoadedAssemblies) add({ filename: assembly.Filename, sha256: assembly.Sha256 });
  } else if (contract.kind === 'password-reader') {
    add({ filename: content.rawReading, sha256: content.readingSha256 }, { nested: 'password-reading' });
    add({ filename: content.manifest, sha256: content.manifestSha256 }, { nested: 'password-manifest' });
    for (const descriptor of [...content.producerSources, ...content.sources]) add(descriptor);
  } else if (contract.kind === 'password-reading') {
    for (const descriptor of content.assemblies) add(descriptor);
  } else if (contract.kind === 'password-manifest') {
    for (const row of content) add(row.source);
  } else if (contract.kind === 'sealed-shows') {
    for (const descriptor of [content.input, content.native, content.fixture, content.record, content.repeat]) {
      add({ ...descriptor, filename: descriptor.filename ?? descriptor.path });
    }
    for (const source of content.jellyfin.sources) for (const root of [content.jellyfin.repository,
      'D:/mediamanager-validation/20261005/jellyfin-baseline/source']) {
      add({ filename: path.join(root, source.path), sha256: source.sha256 });
    }
    for (const record of content.recordings) for (const descriptor of [...record.sourceFiles, record.dotnet,
      record.jellyfinDll, record.oracleAssembly, ...record.outputs]) add(descriptor);
  } else if (contract.kind === 'sealed-startup') {
    add({ filename: content.rawRecording, sha256: content.nativeSha256 });
    add(content.repeat);
    for (const source of content.sources) for (const root of ['D:/jellyfin', content.jellyfin.buildSource]) {
      add({ filename: path.join(root, source.filename), sha256: source.sha256 });
    }
    for (const descriptor of [...content.assemblies, ...content.nativeLibraries, ...content.oracleSources]) add(descriptor);
  } else if (contract.kind === 'splashscreen-sources') {
    for (const source of content.consumerSources) add(source);
  } else if (contract.kind === 'collection-task-sources') {
    for (const source of content.sources) add({ filename: path.join('D:/jellyfin', source.path), sha256: source.sha256 });
  } else if (contract.kind === 'sealed-collection-playlist') {
    add({ filename: content.jellyfin.source });
    for (const descriptor of [content.record, content.raw, content.native, content.dotnet, content.jellyfinDll,
      ...content.files, ...content.jellyfin.sources, ...content.resolution]) {
      add({ ...descriptor, filename: descriptor.filename ?? descriptor.path });
    }
  } else if (contract.kind === 'conflict') {
    add(content.independentNativeAudit);
    for (const recording of content.recordings) {
      for (const descriptor of [recording.originalRecorder, recording.libraryManagerSource, ...recording.executableBindings,
        ...recording.repetitions]) add(descriptor);
    }
  } else if (contract.kind === 'sealed-xml-prefix' || contract.kind === 'sealed-xml-prefix-history') {
    add({ filename: local('native.json'), sha256: content.nativeSha256 });
    add({ filename: content.rawRecording, sha256: content.nativeSha256 }, { recorded: true });
    for (const source of content.oracleSources) add({ filename: local(source.name), sha256: source.sha256 });
    for (const source of content.sources) for (const filename of [source.designated, source.isolated]) {
      add({ filename, sha256: source.sha256 }, { recorded: true });
    }
    if (contract.kind === 'sealed-xml-prefix-history') {
      for (const assembly of content.loadedAssemblies) add(assembly, { recorded: true });
    }
  } else if (contract.kind === 'sealed-charset') {
    for (const file of content.files) add({ filename: local(file.filename.split(/[\\/]/u).at(-1)), sha256: file.sha256 });
    add({ filename: local('native.json'), sha256: content.native.sha256 });
    add({ filename: path.resolve(repositoryRoot, 'src/core/resources/native-charset-models.json'), sha256: content.tables.sha256 });
    for (const descriptor of [content.record, content.raw, content.native, content.modelRaw, content.tables,
      content.dotnet, content.jellyfin.packages, ...content.resolution, ...content.upstream.sources, ...content.loadedAssemblies,
      content.repeat.record, content.repeat.raw, content.repeat.models]) {
      add({ ...descriptor, filename: descriptor.filename ?? descriptor.path });
    }
  } else if (['sealed-json', 'sealed-http-delete', 'sealed-delete-dto', 'sealed-warm'].includes(contract.kind)) {
    // Match the seal's two real reads: path.resolve(fixtureRoot, filename)
    // followed by the raw original filename. Foreign-platform paths are not
    // silently relocated into the current checkout or recorded-input map.
    for (const file of Object.values(content.files)) add({ ...file, filename: local(file.filename) });
    add(content.files.rawRecording);
    add({ filename: content.repeat.filename, sha256: contract.kind === 'sealed-http-delete' ? content.repeat.rawSha256 : content.repeat.sha256 });
    if (contract.kind === 'sealed-json') {
      for (const descriptor of [content.jellyfin.assembly, content.runtime.dotnet, content.runtime.oracleAssembly]) add(descriptor);
    } else {
      if (contract.kind === 'sealed-delete-dto') add({ filename: content.sourceControl.path, sha256: content.sourceControl.sha256 });
      if (contract.kind === 'sealed-warm') {
        for (const descriptor of [content.jellyfin.sourceCapture, content.jellyfin.boundBuildAudit,
          ...Object.values(content.runtime), ...Object.values(content.repeat.runtime)]) add(descriptor);
      }
      for (const assembly of content.assemblies) add({ filename: `${content.jellyfin.assemblyDirectory}/${assembly.name}.dll`, sha256: assembly.sha256 });
    }
  } else if (contract.kind === 'consumer') {
    for (const file of content.files) {
      add({ filename: local(file.filename), sha256: file.sha256 }, file.filename === 'native.json' ? { nested: 'consumer-native' } : {});
      add({ filename: file.source, sha256: file.sha256 });
    }
    for (const reference of content.references) add(reference,
      reference.filename.endsWith('/record.json') ? { nested: 'consumer-record' } : {});
  } else if (contract.kind === 'reader-layout') {
    const record = content.records.find(record => record.kind === contract.argument);
    add(record, { nested: 'reader-record' });
    for (const suffix of ['input', 'native', 'comparison']) {
      const name = `${contract.argument}-${suffix}.json`, descriptor = content.files.find(file => file.filename === name);
      add({ ...descriptor, filename: local(name) });
    }
  } else if (contract.kind === 'consumer-native') {
    for (const descriptor of content.assemblies ?? []) if (descriptor.filename) add(descriptor);
  } else if (contract.kind === 'consumer-record' || contract.kind === 'reader-record') {
    for (const descriptor of content.sourceFiles) add(descriptor,
      contract.kind === 'consumer-record' ? { sourceArchiveFallback: true } : {});
    for (const descriptor of [content.dotnet, content.jellyfinDll, content.oracleAssembly]) add(descriptor);
  } else if (contract.kind === 'identity') {
    for (const descriptor of [content.reference.sourceDatabase, ...content.preparationInputFiles,
      ...content.independentNativeAudits, content.runtimeDirectory, content.sdkDirectory]) add(descriptor);
  } else if (contract.kind === 'byname') {
    add(content.independentNativeAudit);
    for (const recording of content.recordings) {
      if (contract.argument === 'all' || ['genre', 'studio'].includes(recording.kind)) {
        for (const descriptor of recording.repetitions) add(descriptor);
      } else {
        // Other kinds contribute only these files to source verification;
        // their unused repetitions and response recordings are not required.
        const root = recording.repetitions[0].filename;
        add({ filename: path.join(root, 'provenance.json') });
        for (const name of ['reference-runtime-manifest.json', 'source-config-manifest.json', 'prepared-config-manifest.json']) {
          add({ ...recording.artifacts.find(file => file.path === name), filename: path.join(root, name) });
        }
        for (const file of recording.configuration.finalEntries.filter(file => file.type === 'file')) {
          add({ filename: path.join(root, 'reference/config', file.path), sha256: file.sha256 });
        }
      }
    }
  } else throw new Error('Unknown execution manifest contract.');
  return references;
}

export async function captureInputIdentity({ selected, dependencies, preflight, environment = process.env }) {
  const closure = dependencyClosure(dependencies, selected);
  const targets = new Map();
  const add = (filename, reason, required = true, expectedDigests = [], invalidDigest = false) => {
    const absolute = path.resolve(repositoryRoot, filename);
    if (!targets.has(absolute)) targets.set(absolute, { reasons: new Set(), requiredReasons: new Set(), expectedDigests: new Set() });
    targets.get(absolute).reasons.add(reason);
    if (required) targets.get(absolute).requiredReasons.add(reason);
    targets.get(absolute).invalidDigest ||= invalidDigest;
    for (const digest of expectedDigests) targets.get(absolute).expectedDigests.add(digest);
  };
  if (closure.some(entry => entry.path === 'src/images/user-view-collage.js')) {
    for (const filename of collageFontFiles()) add(filename, 'runtime:collage-system-font');
  }
  // Importing this collector also imports the resolver's source. Resolve OS
  // policy only for actual consumers, never merely because that source is in
  // the dependency closure. The renderer opts in when it uses the new bridge.
  const usesSystemFonts = closure.some(entry => ['tests/images/system-fonts-runtime.test.js',
    'tests/validation/input-identity.test.js'].includes(entry.path)
    || entry.path === 'src/images/user-view-collage.js'
      && entry.imports.includes('src/images/system-fonts/index.js'));
  if (environment.MEDIAMANAGER_CI_ALIST_REFERENCE === 'true'
    && closure.some(entry => entry.services?.includes('alist'))) {
    for (const input of await alistBuildInputs(environment)) add(input.filename, 'service:alist-build-input', true, [input.sha256]);
  }
  let systemFonts;
  if (usesSystemFonts) {
    const resolved = await resolveCollageSystemFonts();
    const bindConfiguration = async (filename, parents = new Set()) => {
      const actual = await realpath(filename), info = await lstat(actual), logical = await lstat(filename);
      const binding = { filename, actual, ...(logical.isSymbolicLink() ? { linkTarget: await readlink(filename) } : {}) };
      if (info.isFile()) {
        add(actual, 'runtime:collage-font-configuration');
        return { ...binding, kind: 'file' };
      }
      if (!info.isDirectory()) throw new Error('Fontconfig inputs must be files or include directories.');
      if (parents.has(actual)) throw new Error('Fontconfig input directories contain a symbolic-link cycle.');
      const ancestors = new Set([...parents, actual]), entries = [];
      for (const name of (await readdir(filename)).sort()) entries.push(await bindConfiguration(path.join(filename, name), ancestors));
      return { ...binding, kind: 'directory', entries };
    };
    const configurationBindings = [];
    for (const filename of resolved.configurationFiles) configurationBindings.push(await bindConfiguration(filename));
    systemFonts = { ...resolved, configurationBindings };
    // OS fontconfig entries and shared libraries commonly use symbolic links.
    // Resolve them on each capture and bind actual bytes; a retargeted link
    // therefore changes the input identity instead of bypassing file checks.
    for (const filename of systemFonts.files) add(await realpath(filename), 'runtime:collage-selected-font');
    for (const filename of systemFonts.libraryFiles ?? []) add(await realpath(filename), 'runtime:collage-font-library');
  }
  const dotnetExecutables = [...preflight.services.filter(service => service.name === 'dotnet').map(service => service.filename),
    ...preflight.tools.filter(tool => tool.name === 'dotnet').map(tool => tool.executable)].filter(Boolean);
  const usesDotnet = dotnetExecutables.length > 0 || closure.some(entry => entry.services?.includes('dotnet') || entry.tools?.includes('dotnet'));
  if (usesDotnet && (environment.MEDIAMANAGER_CI_DOTNET_ROOT || environment.GITHUB_ACTIONS === 'true' && environment.DOTNET_INSTALL_DIR)) {
    if (![environment.MEDIAMANAGER_CI_DOTNET_ROOT, environment.DOTNET_INSTALL_DIR,
      environment.MEDIAMANAGER_DOTNET, environment.RUNNER_TEMP].every(value => typeof value === 'string' && path.isAbsolute(value))) {
      throw new Error('CI .NET provisioning requires a verified isolated installation and executable.');
    }
    const root = path.resolve(environment.MEDIAMANAGER_CI_DOTNET_ROOT);
    if (path.relative(root, path.resolve(environment.RUNNER_TEMP, 'mediamanager-dotnet')) !== ''
      || path.relative(root, path.resolve(environment.DOTNET_INSTALL_DIR)) !== '') {
      throw new Error('CI .NET inputs must use the declared isolated runner installation.');
    }
    const executable = path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
    for (const directory of [root, ...['host', 'shared', 'sdk/10.0.401', 'packs'].map(name => path.join(root, name))]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CI .NET inputs require physical SDK and runtime directories.');
    }
    const executableInfo = await lstat(executable), installed = await realpath(executable);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('The isolated dotnet executable must be an ordinary file.');
    for (const selectedExecutable of [environment.MEDIAMANAGER_DOTNET, ...dotnetExecutables]) {
      if (path.relative(installed, await realpath(path.resolve(selectedExecutable))) !== '') {
        throw new Error('CI .NET consumers must use the verified isolated executable.');
      }
    }
    // Bind the complete install, including reference packs and SDK manifests;
    // do not redirect historical .tools/dotnet recording paths into this build.
    add(root, 'runtime:dotnet-installation');
    add(executable, 'runtime:dotnet-executable');
  }
  // A shared fixture can be reached by several consumers. Deduplicate traversal
  // per consumer so every transitive input retains its actual dependency owners.
  const inspectedManifests = new Map(), inspectedDirectories = new Map();
  const directoryFiles = new Map(), manifestContents = new Map();
  function alreadyInspected(cache, filename, reason) {
    if (!cache.has(filename)) cache.set(filename, new Set());
    const consumers = cache.get(filename);
    if (consumers.has(reason)) return true;
    consumers.add(reason); return false;
  }
  async function bindDirectoryManifests(directory, reason, siblingOnly = false) {
    if (alreadyInspected(inspectedDirectories, directory + (siblingOnly ? '\0siblings' : '\0tree'), reason)) return;
    if (!directoryFiles.has(directory)) {
      try { directoryFiles.set(directory, await filesIn(directory)); }
      catch (error) { if (error.code === 'ENOENT') directoryFiles.set(directory, []); else throw error; }
    }
    const files = directoryFiles.get(directory);
    // A file consumer can construct sibling filenames, but does not thereby
    // consume manifests belonging to every nested fixture in a shared root.
    // Explicit directory dependencies still bind their complete tree.
    for (const file of files.filter(file => file.endsWith('.json') && (!siblingOnly || path.dirname(file) === directory))) {
      await bindManifestReferences(file, reason);
    }
  }
  async function bindManifestReferences(filename, reason) {
    if (!filename.endsWith('.json') || alreadyInspected(inspectedManifests, filename, reason)) return;
    if (!manifestContents.has(filename)) {
      try { manifestContents.set(filename, JSON.parse(await readFile(filename, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) manifestContents.set(filename, null); else throw error; }
    }
    const content = manifestContents.get(filename);
    if (content === null) return;
    const references = new Map();
    const reference = (target, descriptor) => {
      const previous = references.get(target), expectedDigests = new Set(previous?.expectedDigests ?? []);
      if (descriptor.required) for (const digest of descriptor.expectedDigests ?? []) expectedDigests.add(digest.toLowerCase());
      references.set(target, { ...descriptor, required: descriptor.required || previous?.required === true,
        siblingDirectory: descriptor.siblingDirectory || previous?.siblingDirectory === true,
        invalidDigest: descriptor.invalidDigest || previous?.invalidDigest === true, expectedDigests });
    };
    function visit(value, key, owner) {
      if (typeof value === 'string') {
        const logical = value.replaceAll('\\', '/');
        const declaredDigests = ['path', 'filename', 'root'].includes(key) && owner
          ? ['sha256', 'entriesSha256'].filter(name => Object.hasOwn(owner, name)).map(name => owner[name]) : [];
        const requiredPin = owner?.required === true && declaredDigests.length > 0;
        const hashBound = declaredDigests.some(isDigest);
        const invalidDigest = requiredPin && !declaredDigests.every(isDigest);
        if (/^\.agent-docs\/(?:evidence|baselines|oracle|reference-instance)(?:\/|$)/u.test(logical)
          && !logical.split('/').includes('..') && !/[\r\n]/u.test(logical)) {
          const target = validationPath(logical, repositoryRoot, environment);
          reference(target, { logical, siblingDirectory: true, required: owner?.required === true,
            expectedDigests: declaredDigests.filter(isDigest), invalidDigest });
        } else {
          const sourcePath = ['sourceInstance', 'sourceDatabase', 'sourceRoot', 'initialDatabase', 'manifestPath'].includes(key);
          const mapped = recordedInput(value, declaredDigests.filter(isDigest));
          const target = mapped?.filename ?? validationPath(value, repositoryRoot, environment);
          const local = path.relative(repositoryRoot, target).replaceAll('\\', '/');
          const workspaceInput = /^(?:\.agent-temp|\.tools|\.test-output)(?:\/|$)/u.test(local);
          const initializedRoot = key === 'root' && owner?.initializedFromEmpty === true;
          const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value);
          if (!/[\r\n]/u.test(value) && (((hashBound || requiredPin) && (absolute || workspaceInput)) || (workspaceInput && (sourcePath || initializedRoot)))) {
            // Explicit hash-bound/source descriptors are inputs; ordinary DTO Path values are business data.
            if (mapped) add(recordedInputMapPath, `${reason}:recorded-input-map`);
            reference(target, { logical: value, siblingDirectory: false, required: owner?.required === true,
              expectedDigests: [...declaredDigests.filter(isDigest), ...(mapped ? [mapped.sha256] : [])], invalidDigest });
          }
        }
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey, value);
      }
    }
    visit(content);
    for (const [target, { logical, siblingDirectory, required, expectedDigests, invalidDigest }] of [...references].sort(([left], [right]) => left.localeCompare(right))) {
      add(target, `${reason}:manifest-reference:${logical}`, required, expectedDigests, invalidDigest);
      const description = await describeFile(target, { recursive: false });
      // Historical provenance paths remain descriptive unless a consumer
      // explicitly declares the hash-bound input required for execution.
      if (siblingDirectory && (description.kind === 'file' || path.extname(target))) {
        add(path.dirname(target), `${reason}:manifest-reference-directory`, false);
        await bindDirectoryManifests(path.dirname(target), reason, true);
      }
      if (description.available && description.kind === 'file') await bindManifestReferences(target, reason);
      if (description.available && description.kind === 'directory') await bindDirectoryManifests(target, reason);
    }
  }
  async function bindExecutionManifest(filename, consumer, contract) {
    const reason = `${consumer}:execution-manifest`;
    add(filename, reason);
    let content;
    try { content = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    for (const descriptor of executionManifestReferences(contract, content, filename)) {
      // Only an explicitly reviewed recordedInputPath consumer can relocate
      // evidence. Other contracts still read their original filename directly.
      let target = path.resolve(repositoryRoot, descriptor.filename);
      const pins = ['sha256', 'entriesSha256'].filter(key => Object.hasOwn(descriptor, key)).map(key => descriptor[key]);
      if (descriptor.recorded) {
        const mapped = recordedInput(descriptor.filename, pins);
        target = mapped?.filename ?? validationPath(descriptor.filename, repositoryRoot, environment);
        if (mapped) add(recordedInputMapPath, `${reason}:recorded-input-map`);
      }
      if (descriptor.sourceArchiveFallback && environment.MEDIAMANAGER_RECORDED_SOURCE_ARCHIVE && isDigest(descriptor.sha256)) {
        try { await lstat(target); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          target = path.resolve(environment.MEDIAMANAGER_RECORDED_SOURCE_ARCHIVE, descriptor.sha256);
        }
      }
      add(target, `${reason}:${descriptor.filename}`, true, pins.filter(isDigest).map(value => value.toLowerCase()),
        !pins.every(isDigest));
      if (descriptor.nested) await bindExecutionManifest(target, consumer, { kind: descriptor.nested });
    }
  }
  for (const { path: consumer } of closure) {
    const contract = executionManifestContract(consumer);
    if (!contract) continue;
    const consumerClosure = dependencyClosure(dependencies, [consumer]);
    if (!consumerClosure.some(entry => entry.path === contract.loader)) {
      throw new Error(`Reviewed execution input loader is missing from the dependency closure: ${consumer}`);
    }
    await bindExecutionManifest(path.resolve(repositoryRoot, contract.manifest), consumer, contract);
    if (['byname', 'conflict'].includes(contract.kind)) await bindExecutionManifest(
      path.resolve(repositoryRoot, 'tests/library/fixtures/native-identity-inputs/binding.json'), consumer, { kind: 'identity' });
  }
  for (const entry of closure) {
    for (const importedFile of entry.importedFiles || []) {
      add(importedFile, `${entry.path}:imported-local-file`);
    }
    for (const reference of entry.declaredReferences.filter(reference => reference.required)) {
      if (!reference.dynamic) {
        add(reference.filename, `${entry.path}:${reference.logicalPath}`);
        // A fixture's manifest may reference sibling files whose paths are constructed dynamically.
        if (reference.kind === 'file') {
          add(path.dirname(reference.filename), `${entry.path}:fixture-directory`);
          await bindDirectoryManifests(path.dirname(reference.filename), entry.path, true);
        }
        if (reference.available && reference.kind === 'directory') await bindDirectoryManifests(reference.filename, entry.path);
        if (reference.available && reference.kind === 'file') await bindManifestReferences(reference.filename, entry.path);
      } else {
        const prefix = reference.logicalPath.split(/\$\{|[?*]/u)[0];
        add(validationPath(prefix.endsWith('/') ? prefix : path.dirname(prefix), repositoryRoot, environment),
          `${entry.path}:dynamic-reference-directory`);
      }
    }
    for (const fixture of entry.fixtureReferences || []) {
      add(fixture.filename, `${entry.path}:local-fixture`);
      add(path.dirname(fixture.filename), `${entry.path}:local-fixture-directory`);
      await bindDirectoryManifests(path.dirname(fixture.filename), entry.path, true);
      await bindManifestReferences(fixture.filename, entry.path);
    }
  }
  const usesCurrentNativeSqlite = environment.MEDIAMANAGER_CI_NATIVE_SQLITE === 'true'
    && closure.some(entry => entry.services?.includes('currentNativeSqlite'));
  const usesNativeInstance = environment.MEDIAMANAGER_CI_NATIVE_INSTANCE === 'true'
    && closure.some(entry => entry.services?.includes('nativeInstance'));
  if (environment.MEDIAMANAGER_CI_NATIVE_REFERENCE === 'true'
    && (usesCurrentNativeSqlite || usesNativeInstance || closure.some(entry => entry.services?.includes('jellyfinDll')))) {
    for (const input of (await nativeBuildInputs(environment)).inputs) {
      add(input.filename, `runtime:native-reference:${input.reason}`, true, input.sha256 ? [input.sha256] : []);
    }
  }
  if (usesCurrentNativeSqlite) {
    for (const input of (await currentNativeSqliteInputs(environment)).inputs) {
      add(input.filename, 'runtime:current-native-sqlite', true, [input.sha256]);
    }
  } else if (usesNativeInstance) {
    for (const input of (await nativeInstanceInputs(environment)).inputs) {
      add(input.filename, 'runtime:native-instance', true, [input.sha256]);
    }
  }
  if (environment.MEDIAMANAGER_CI_WEB_CLIENTS === 'true') {
    if (closure.some(entry => entry.services?.includes('jellyfinWeb'))) {
      for (const input of (await jellyfinWebInputs(environment)).inputs) {
        add(input.filename, 'runtime:jellyfin-web', true, [input.sha256]);
      }
    }
    if (closure.some(entry => entry.services?.includes('browser'))) {
      for (const input of (await browserInputs(environment)).inputs) {
        add(input.filename, 'runtime:browser', true, [input.sha256]);
      }
    }
  }
  for (const service of preflight.services) {
    if (!service.filename) continue;
    add(service.filename, `service:${service.name}`);
    if (service.name === 'jellyfinDll') add(path.dirname(service.filename), 'service:jellyfin-runtime-directory');
    if (service.name === 'dotnet') {
      for (const directory of ['shared', 'host', 'sdk']) add(path.join(path.dirname(service.filename), directory), `service:dotnet-${directory}`);
    }
  }
  for (const tool of preflight.tools) {
    add(tool.executable, `tool:${tool.name}`);
    if (tool.name === 'dotnet') {
      for (const directory of ['shared', 'host', 'sdk']) add(path.join(path.dirname(tool.executable), directory), `tool:dotnet-${directory}`);
    }
    // Chocolatey shims declare the executable that they dispatch; bind both files.
    const shim = `${tool.executable}.shim`;
    try {
      const source = await readFile(shim, 'utf8');
      add(shim, `tool:${tool.name}-shim`);
      const target = /^path\s*=\s*"?([^"\r\n]+)"?\s*$/mu.exec(source)?.[1];
      if (target) add(target.trim(), `tool:${tool.name}-shim-target`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  add(process.execPath, 'runtime:node');
  add(path.join(repositoryRoot, 'node_modules'), 'runtime:node-modules');
  const entries = [];
  for (const [filename, { reasons, requiredReasons, expectedDigests, invalidDigest }] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
    const description = await describeFile(filename, {workspaceLinks:filename===path.join(repositoryRoot,'node_modules')});
    const expected = [...expectedDigests].sort();
    entries.push({ reasons: [...reasons].sort(), requiredReasons: [...requiredReasons].sort(), required: requiredReasons.size > 0, ...description,
      ...(invalidDigest ? { invalidExpectedDigest: true } : {}),
      ...(expected.length || invalidDigest ? { expectedDigests: expected,
        expectedDigestMatched: !invalidDigest && expected.every(digest => digest === (description.sha256 ?? description.entriesSha256)) } : {}) });
  }
  const services = preflight.services.filter(service => !service.filename).map(service => ({ ...service }));
  const tools = preflight.tools.map(({ name, executable, available, version, errorCode }) => ({
    name, executable, available, version, ...(errorCode ? { errorCode } : {}),
  }));
  const identity = { entries, services, tools, ...(systemFonts ? { systemFonts } : {}), preflightReady: preflight.ready,
    ready: entries.filter(entry => entry.required).every(entry => entry.available && entry.expectedDigestMatched !== false) && preflight.ready };
  return { schemaVersion: 2, scope: 'Selected tests and their transitive local src/test/tool imports: imported local data files, declared/local fixture inputs, fixture siblings, transitive JSON provenance/hash-bound/source descriptors, configured native/runtime dependencies, Node modules and tool executables; service availability/version. Explicit required descriptors must exist and match every declared digest before execution. Required ownership is recorded per reason; optional consumers of the same file do not inherit another consumer\'s requirement. Ordinary DTO paths are not interpreted as dependencies. Dynamic reads outside these inputs require separate evidence.',
    ...identity, entriesSha256: sha256(JSON.stringify(identity)) };
}

export function inputsUnchanged(before, after) { return before.entriesSha256 === after.entriesSha256; }
