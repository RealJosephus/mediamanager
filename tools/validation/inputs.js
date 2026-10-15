import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dependencyClosure, describeFile, filesIn, sha256 } from './inventory.js';
import { repositoryRoot, validationPath } from './paths.js';

export async function captureInputIdentity({ selected, dependencies, preflight, environment = process.env }) {
  const targets = new Map();
  const add = (filename, reason, required = true) => {
    const absolute = path.resolve(repositoryRoot, filename);
    if (!targets.has(absolute)) targets.set(absolute, { reasons: new Set(), required: false });
    targets.get(absolute).reasons.add(reason);
    targets.get(absolute).required ||= required;
  };
  const inspectedManifests = new Set();
  const inspectedDirectories = new Set();
  async function bindDirectoryManifests(directory, reason) {
    if (inspectedDirectories.has(directory)) return;
    inspectedDirectories.add(directory);
    let files;
    try { files = await filesIn(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const file of files.filter(file => file.endsWith('.json'))) await bindManifestReferences(file, reason);
  }
  async function bindManifestReferences(filename, reason) {
    if (inspectedManifests.has(filename) || !filename.endsWith('.json')) return;
    inspectedManifests.add(filename);
    let content;
    try { content = JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    const references = new Map();
    function visit(value, key, owner) {
      if (typeof value === 'string') {
        const logical = value.replaceAll('\\', '/');
        if (/^\.agent-docs\/(?:evidence|baselines|oracle|reference-instance)(?:\/|$)/u.test(logical)
          && !logical.split('/').includes('..') && !/[\r\n]/u.test(logical)) {
          const target = validationPath(logical, repositoryRoot, environment);
          references.set(target, { logical, siblingDirectory: true });
        } else {
          const hashBound = ['path', 'filename', 'root'].includes(key)
            && /^[a-f0-9]{64}$/iu.test(owner?.sha256 || owner?.entriesSha256 || '');
          const sourcePath = ['sourceInstance', 'sourceDatabase', 'sourceRoot', 'initialDatabase', 'manifestPath'].includes(key);
          const target = validationPath(value, repositoryRoot, environment);
          const local = path.relative(repositoryRoot, target).replaceAll('\\', '/');
          const workspaceInput = /^(?:\.agent-temp|\.tools|\.test-output)(?:\/|$)/u.test(local);
          const initializedRoot = key === 'root' && owner?.initializedFromEmpty === true;
          const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value);
          if (!/[\r\n]/u.test(value) && ((hashBound && (absolute || workspaceInput)) || (workspaceInput && (sourcePath || initializedRoot)))) {
            // Explicit hash-bound/source descriptors are inputs; ordinary DTO Path values are business data.
            references.set(target, { logical: value, siblingDirectory: false });
          }
        }
      } else if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey, value);
      }
    }
    visit(content);
    for (const [target, { logical, siblingDirectory }] of [...references].sort(([left], [right]) => left.localeCompare(right))) {
      add(target, `${reason}:manifest-reference:${logical}`, false);
      const description = await describeFile(target, { recursive: false });
      // Provenance paths can be metadata rather than reads; bind their state without claiming they are mandatory.
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
  for (const [filename, { reasons, required }] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({ reasons: [...reasons].sort(), required, ...await describeFile(filename,
      {workspaceLinks:filename===path.join(repositoryRoot,'node_modules')}) });
  }
  const services = preflight.services.filter(service => !service.filename).map(service => ({ ...service }));
  const tools = preflight.tools.map(({ name, executable, available, version, errorCode }) => ({
    name, executable, available, version, ...(errorCode ? { errorCode } : {}),
  }));
  const identity = { entries, services, tools, preflightReady: preflight.ready,
    ready: entries.filter(entry => entry.required).every(entry => entry.available) && preflight.ready };
  return { schemaVersion: 1, scope: 'Selected tests and their transitive local src/test/tool imports: imported local data files, declared/local fixture inputs, fixture siblings, transitive JSON provenance/hash-bound/source descriptors, configured native/runtime dependencies, Node modules and tool executables; service availability/version. Ordinary DTO paths are not interpreted as dependencies. Dynamic reads outside these inputs require separate evidence.',
    ...identity, entriesSha256: sha256(JSON.stringify(identity)) };
}

export function inputsUnchanged(before, after) { return before.entriesSha256 === after.entriesSha256; }
