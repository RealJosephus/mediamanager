import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dependencyClosure, describeFile, filesIn, sha256 } from './inventory.js';
import { recordedInput, recordedInputMapPath, repositoryRoot, validationPath } from './paths.js';
import { collageFontFiles } from '../../src/images/font-collection.js';

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
]);

export function executionManifestContract(consumer) {
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
  if (contract.kind === 'consumer') {
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
      if (['genre', 'studio'].includes(recording.kind)) {
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
  async function bindDirectoryManifests(directory, reason) {
    if (alreadyInspected(inspectedDirectories, directory, reason)) return;
    if (!directoryFiles.has(directory)) {
      try { directoryFiles.set(directory, await filesIn(directory)); }
      catch (error) { if (error.code === 'ENOENT') directoryFiles.set(directory, []); else throw error; }
    }
    const files = directoryFiles.get(directory);
    for (const file of files.filter(file => file.endsWith('.json'))) await bindManifestReferences(file, reason);
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
        await bindDirectoryManifests(path.dirname(target), reason);
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
      // These consumers read the original filename directly. An evidence-map
      // relocation must not claim availability until its consumer uses it too.
      let target = path.resolve(repositoryRoot, descriptor.filename);
      const pins = ['sha256', 'entriesSha256'].filter(key => Object.hasOwn(descriptor, key)).map(key => descriptor[key]);
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
    if (contract.kind === 'byname') await bindExecutionManifest(
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
          await bindDirectoryManifests(path.dirname(reference.filename), entry.path);
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
      await bindDirectoryManifests(path.dirname(fixture.filename), entry.path);
      await bindManifestReferences(fixture.filename, entry.path);
    }
  }
  if (environment.MEDIAMANAGER_CI_NATIVE_REFERENCE === 'true' && closure.some(entry => entry.services?.includes('jellyfinDll'))) {
    // This is a promised same-run build, not a replacement for historical pins.
    // Bind it during planning as well as strict preflight, even when files are
    // missing, so a broken provision cannot silently remove its consumers.
    if (!environment.MEDIAMANAGER_NATIVE_BUILD_ROOT || !environment.MEDIAMANAGER_JELLYFIN_DLL) {
      throw new Error('Native reference provisioning requires its build root and Jellyfin DLL path.');
    }
    const root = path.resolve(environment.MEDIAMANAGER_NATIVE_BUILD_ROOT), runtime = path.join(root, 'runtime');
    if (path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL) !== path.join(runtime, 'jellyfin.dll')
      || environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY && path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY) !== runtime) {
      throw new Error('Native reference consumers must use the same-run build runtime directory.');
    }
    const reason = 'runtime:native-reference';
    for (const directory of ['runtime', 'receipts', 'source-offer']) add(path.join(root, directory), `${reason}:${directory}`);
    add(path.join(runtime, 'jellyfin.dll'), `${reason}:entry-assembly`);
    for (const filename of ['build-receipt.json', 'runtime-manifest.json', 'source-before.json', 'source-after.json', 'nuget-manifest.json']) {
      add(path.join(root, 'receipts', filename), `${reason}:receipt`);
    }
    const read = async filename => {
      try { return JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const bind = (directory, descriptor) => {
      if (!descriptor || typeof descriptor.path !== 'string' || /[:\\\r\n\0]/u.test(descriptor.path)
        || descriptor.path.split('/').some(part => !part || part === '.' || part === '..')
        || !isDigest(descriptor.sha256)) throw new Error('Invalid native build evidence descriptor.');
      add(path.join(directory, descriptor.path), `${reason}:build-manifest`, true, [descriptor.sha256.toLowerCase()]);
    };
    const receipt = await read(path.join(root, 'receipts/build-receipt.json'));
    if (receipt) {
      if (receipt.schemaVersion !== 1 || receipt.status !== 'succeeded' || receipt.sdkActual !== '10.0.401'
        || receipt.sourceUnchanged !== true || receipt.sourceBefore?.sha256 !== receipt.sourceAfter?.sha256
        || !Array.isArray(receipt.sourceOffer) || receipt.sourceOffer.length !== 4) {
        throw new Error('The native reference build did not finish with unchanged sealed sources.');
      }
      for (const [field, variable] of [['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
        if (environment[variable] && receipt[field] !== environment[variable]) throw new Error('Native reference evidence belongs to another candidate or workflow run.');
      }
      for (const descriptor of [receipt.runtimeManifest, receipt.sourceBefore, receipt.sourceAfter, receipt.nugetManifest]) {
        bind(path.join(root, 'receipts'), descriptor);
      }
      for (const descriptor of receipt.sourceOffer) bind(path.join(root, 'source-offer'), descriptor);
    }
    const manifest = await read(path.join(root, 'receipts/runtime-manifest.json'));
    if (manifest) {
      if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'jellyfin.dll')
        || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Invalid native runtime file manifest.');
      for (const descriptor of manifest.files) bind(runtime, descriptor);
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
  const identity = { entries, services, tools, preflightReady: preflight.ready,
    ready: entries.filter(entry => entry.required).every(entry => entry.available && entry.expectedDigestMatched !== false) && preflight.ready };
  return { schemaVersion: 2, scope: 'Selected tests and their transitive local src/test/tool imports: imported local data files, declared/local fixture inputs, fixture siblings, transitive JSON provenance/hash-bound/source descriptors, configured native/runtime dependencies, Node modules and tool executables; service availability/version. Explicit required descriptors must exist and match every declared digest before execution. Required ownership is recorded per reason; optional consumers of the same file do not inherit another consumer\'s requirement. Ordinary DTO paths are not interpreted as dependencies. Dynamic reads outside these inputs require separate evidence.',
    ...identity, entriesSha256: sha256(JSON.stringify(identity)) };
}

export function inputsUnchanged(before, after) { return before.entriesSha256 === after.entriesSha256; }
