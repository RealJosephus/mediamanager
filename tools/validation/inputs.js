import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dependencyClosure, describeFile, filesIn, sha256 } from './inventory.js';
import { recordedInput, recordedInputMapPath, repositoryRoot, validationPath } from './paths.js';

const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);

export async function captureInputIdentity({ selected, dependencies, preflight, environment = process.env }) {
  const targets = new Map();
  const add = (filename, reason, required = true, expectedDigests = [], invalidDigest = false) => {
    const absolute = path.resolve(repositoryRoot, filename);
    if (!targets.has(absolute)) targets.set(absolute, { reasons: new Set(), requiredReasons: new Set(), expectedDigests: new Set() });
    targets.get(absolute).reasons.add(reason);
    if (required) targets.get(absolute).requiredReasons.add(reason);
    targets.get(absolute).invalidDigest ||= invalidDigest;
    for (const digest of expectedDigests) targets.get(absolute).expectedDigests.add(digest);
  };
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
  for (const entry of dependencyClosure(dependencies, selected)) {
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
