import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { cargoString, fileIdentity, inside, tree } from './materials.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), directory = 'tools/release/source-materials';
const hosts = {
  'linux/x64': { target: 'x86_64-unknown-linux-gnu', platform: 'linux-x64' },
  'darwin/arm64': { target: 'aarch64-apple-darwin', platform: 'darwin-arm64v8' }
};
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const slash = value => value.split(path.sep).join('/');

async function capture(output, target, platform) {
  const host = hosts[process.platform + '/' + process.arch];
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP
    || !host || host.target !== target || host.platform !== platform) {
    throw new Error('Capture POSIX librsvg source graphs on their declared actual GitHub Actions hosts and targets.');
  }
  output = path.resolve(output);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  inside(await realpath(process.env.RUNNER_TEMP), output); await mkdir(output);
  for (const name of ['logs', 'inputs', 'working-source', 'pristine', 'post-edit', 'effective', 'source-trees', 'toolchain', 'new-crates']) {
    await mkdir(path.join(output, name));
  }
  const receipt = {
    startedAt: new Date().toISOString(), completed: false,
    scope: 'Current post-edit POSIX librsvg-c default normal/build source dependency graph. Not a recovered historical compiler/cache/link graph, Meson optional-feature resolution, binary rebuild or complete aggregate build.',
    workflow: { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA,
      job: process.env.GITHUB_JOB, runner: process.env.RUNNER_NAME, image: process.env.ImageOS, imageVersion: process.env.ImageVersion },
    host: { platform: process.platform, architecture: process.arch, release: os.release(), version: os.version(), node: process.version, pid: process.pid },
    profile: { platform, target, compilerHost: null, package: 'librsvg-c', edges: ['normal', 'build'], defaultFeatures: true,
      extraFeatures: [], rustChannel: 'nightly', mesonExecuted: false },
    inputs: [], commands: [], selected: [], newSources: []
  };
  const save = () => writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const command = async (name, program, args, cwd, env = process.env) => {
    const record = { name, program, args, cwd, startedAt: new Date().toISOString(), completed: false };
    receipt.commands.push(record);
    const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid;
    const chunks = { stdout: [], stderr: [] }; let count = 0, failure, overflow = false, timedOut = false;
    const receive = (stream, chunk) => {
      count += chunk.length;
      if (count <= 32 * 1024 * 1024) chunks[stream].push(chunk);
      else if (!overflow) { overflow = true; failure = new Error('Source graph command exceeds its complete-output bound.'); child.kill(); }
    };
    child.stdout.on('data', chunk => receive('stdout', chunk)); child.stderr.on('data', chunk => receive('stderr', chunk));
    child.once('error', error => { failure ??= error; });
    let force;
    const timer = setTimeout(() => {
      timedOut = true; failure ??= new Error('Source graph command exceeded its ten-minute command budget.'); child.kill();
      force = setTimeout(() => child.kill('SIGKILL'), 5000); force.unref();
    }, 600000); timer.unref();
    const settled = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(timer); clearTimeout(force);
    Object.assign(record, { ...settled, finishedAt: new Date().toISOString(), completeOutput: !overflow, timedOut });
    const bytes = {};
    for (const stream of ['stdout', 'stderr']) {
      bytes[stream] = Buffer.concat(chunks[stream]);
      const relative = 'logs/' + name + '.' + stream;
      await writeFile(path.join(output, relative), bytes[stream], { flag: 'wx' });
      record[stream] = { path: relative, ...digest(bytes[stream]) };
    }
    failure ??= settled.code !== 0 || settled.signal ? new Error(`Source graph command failed (${name}: ${settled.signal ?? settled.code}).`) : undefined;
    record.completed = !failure;
    if (failure) record.error = { name: failure.name, message: failure.message, ...(failure.code ? { code: failure.code } : {}) };
    await writeFile(path.join(output, 'logs', name + '.process.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await save();
    if (failure) throw failure;
    return bytes.stdout;
  };
  const input = async (relative, pin) => {
    const filename = path.join(root, relative); inside(root, filename);
    const actual = await fileIdentity(filename);
    if (pin && (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256)) throw new Error('POSIX graph input changed: ' + relative);
    const previous = receipt.inputs.find(entry => entry.path === relative);
    if (previous && (previous.bytes !== actual.bytes || previous.sha256 !== actual.sha256)) throw new Error('POSIX graph input changed during capture: ' + relative);
    if (!previous) receipt.inputs.push({ path: relative, ...actual });
    return await readFile(filename);
  };
  const material = pin => input(path.posix.join(directory, pin.path), pin);
  let primary;
  try {
    await save();
    const git = async (name, args) => (await command(name, 'git', args, root)).toString('utf8').trim();
    receipt.candidate = { commit: await git('candidate-commit', ['rev-parse', 'HEAD']), tree: await git('candidate-tree', ['rev-parse', 'HEAD^{tree}']) };
    receipt.candidate.statusBefore = await git('candidate-status-before', ['status', '--porcelain=v1', '--untracked-files=all']);
    if (receipt.candidate.commit !== process.env.GITHUB_SHA || receipt.candidate.statusBefore) throw new Error('POSIX graph candidate is not the clean dispatched revision.');
    for (const name of ['.github/workflows/native-source-graph.yml', 'tools/release/capture-rsvg-posix-sources.js',
      'tools/release/materials.js', 'tools/release/license-texts.js']) {
      const bytes = await input(name), filename = path.join(output, 'inputs', 'producer', name);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
    }
    const offerBytes = await input(directory + '/source-offer.json'), offer = JSON.parse(offerBytes);
    await writeFile(path.join(output, 'inputs', 'source-offer.json'), offerBytes, { flag: 'wx' });
    const catalog = JSON.parse(await material(offer.nativeFullSources)), recipes = JSON.parse(await material(offer.recipeFragments));
    const library = catalog.sources.find(source => source.name === 'rsvg'), modification = library?.modifications?.posix;
    if (!library || !modification || modification.patches.length) throw new Error('POSIX librsvg source/inline edit contract changed.');
    await material(library.archive);
    await material(library.members);
    const recipe = recipes.sources.find(source => source.id === modification.sourceId);
    if (!recipe) throw new Error('POSIX librsvg producer recipe is absent.');
    const commit = JSON.parse(await material(recipe.commitReceipt)), gitTree = JSON.parse(await material(recipe.treeReceipt));
    if (commit.sha !== recipe.candidate.commit || commit.tree.sha !== recipe.candidate.tree || gitTree.sha !== recipe.candidate.tree || gitTree.truncated) {
      throw new Error('POSIX recipe original Git identity changed.');
    }
    for (const pin of [offer.nativeFullSources, offer.recipeFragments, recipe.commitReceipt, recipe.treeReceipt]) {
      const filename = path.join(output, 'inputs', pin.path); await mkdir(path.dirname(filename), { recursive: true });
      await copyFile(path.join(root, directory, pin.path), filename);
    }
    const recipeFiles = new Map();
    const names = ['.github/workflows/ci.yml', 'build.sh', 'versions.properties', modification.upstreamPath,
      ...recipe.files.filter(file => file.upstreamPath.startsWith('platforms/' + platform + '/')).map(file => file.upstreamPath)];
    for (const name of names) {
      const file = recipe.files.find(entry => entry.upstreamPath === name);
      if (!file) throw new Error('POSIX original recipe file is absent: ' + name);
      const bytes = await material(file), member = gitTree.tree.find(entry => entry.path === name);
      if (member?.type !== 'blob' || member.sha !== file.gitBlob
        || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== file.gitBlob) {
        throw new Error('POSIX recipe differs from its original Git blob: ' + name);
      }
      const filename = path.join(output, 'inputs', 'recipe', name); await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes, { flag: 'wx' }); recipeFiles.set(name, bytes.toString('utf8'));
    }
    const posix = recipeFiles.get(modification.upstreamPath), region = modification.originalRegion;
    if (!posix.includes(region) || !region.includes('-Dpixbuf{,-loader}=disabled') || !region.includes('${RUST_TARGET:+-Dtriplet=$RUST_TARGET}')) {
      throw new Error('POSIX original librsvg region/feature/target binding changed.');
    }
    const version = /^VERSION_RSVG=(.+)$/mu.exec(recipeFiles.get('versions.properties'))?.[1];
    if (version !== library.version) throw new Error('POSIX librsvg archive differs from its actual recipe version.');
    const channel = process.platform === 'linux' ? recipeFiles.get('platforms/' + platform + '/Dockerfile') : posix;
    if (!channel?.includes('--default-toolchain nightly')) throw new Error('POSIX recipe no longer declares the captured Rust channel.');
    receipt.recipe = { sourceId: recipe.id, repository: recipe.repository, candidate: recipe.candidate, version,
      platform, originalRegion: region, updateCommand: 'cargo update --workspace',
      hostScope: 'Native platform/default host target on the current CI runner; the original Linux container/bootstrap and historical SDK are not replayed.',
      optionalFeatures: 'Pixbuf is explicitly disabled. No extra Cargo avif/pixbuf feature is requested; Meson auto-detected optional variants are outside this graph.' };
    await writeFile(path.join(output, 'inputs', 'librsvg-original-region.sh'), region, { flag: 'wx' });
    const lines = region.split('\n'), first = lines.findIndex(line => line.startsWith("sed -i'.bak' "));
    const update = lines.indexOf('cargo update --workspace');
    const editLines = lines.slice(first, update);
    if (first < 0 || update <= first || editLines.filter(line => line.startsWith("sed -i'.bak' ")).length !== 3
      || editLines.some(line => line && !line.startsWith('#') && !line.startsWith("sed -i'.bak' "))) {
      throw new Error('POSIX inline edit span needs explicit review.');
    }
    const editScript = path.join(output, 'inputs', 'apply-posix-inline-edits.sh');
    await writeFile(editScript, '#!/usr/bin/env bash\nset -eu\n' + editLines.join('\n') + '\n', { flag: 'wx' });
    receipt.recipe.editScript = { path: 'inputs/apply-posix-inline-edits.sh', ...await fileIdentity(editScript) };
    await command('extract', 'tar', ['-xf', path.join(root, directory, library.archive.path), '-C', path.join(output, 'working-source')], root);
    const source = path.join(output, 'working-source', library.root.slice(0, -1)); inside(path.join(output, 'working-source'), source);
    const sourceTree = async name => {
      const entries = await tree(source);
      await writeFile(path.join(output, 'source-trees', name + '.json'), JSON.stringify(entries, null, 2) + '\n', { flag: 'wx' });
      return entries;
    };
    const pristine = await sourceTree('pristine');
    const preserve = async name => {
      const required = ['Cargo.lock', 'meson.build', 'meson_options.txt', 'rsvg/meson.build', 'meson/cargo_wrapper.py'];
      const files = (await tree(source)).filter(entry => !entry.kind && (required.includes(entry.path)
        || path.posix.basename(entry.path) === 'Cargo.toml' || entry.path.endsWith('.bak') || entry.path.startsWith('.cargo/')));
      for (const file of files) {
        const filename = path.join(output, name, file.path); await mkdir(path.dirname(filename), { recursive: true });
        await copyFile(path.join(source, file.path), filename);
      }
      return files;
    };
    receipt.pristine = await preserve('pristine');
    receipt.pristineLock = { path: 'pristine/Cargo.lock', ...await fileIdentity(path.join(source, 'Cargo.lock')) };
    const env = { ...process.env };
    const unset = Object.keys(env).filter(key => key.startsWith('CARGO_') || ['RUSTFLAGS', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTC_BOOTSTRAP', 'RUSTUP_TOOLCHAIN', 'RUST_TARGET'].includes(key));
    for (const key of unset) delete env[key];
    Object.assign(env, { CARGO_HOME: path.join(output, 'cargo-home'), CARGO_TARGET_DIR: path.join(output, 'target'),
      CARGO_TERM_COLOR: 'never', CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse', RUSTUP_TOOLCHAIN: 'nightly', PLATFORM: platform });
    receipt.environment = { clearedVariableNames: unset.sort(), CARGO_HOME: env.CARGO_HOME, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR,
      CARGO_REGISTRIES_CRATES_IO_PROTOCOL: env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL, RUSTUP_TOOLCHAIN: env.RUSTUP_TOOLCHAIN,
      PLATFORM: env.PLATFORM, RUST_TARGET: null };
    receipt.sed = (await command('sed-version', 'sed', ['--version'], source, env)).toString('utf8');
    if (!receipt.sed.includes('GNU sed')) throw new Error('Supply GNU sed explicitly for the original POSIX inline edit commands.');
    await command('bash-version', 'bash', ['--version'], source, env);
    await command('rustup-version', 'rustup', ['--version'], source, env);
    await command('toolchain-components', 'rustup', ['component', 'list', '--toolchain', 'nightly', '--installed'], source, env);
    receipt.cargo = (await command('cargo-version', 'cargo', ['--version', '--verbose'], source, env)).toString('utf8');
    receipt.rustc = (await command('rustc-version', 'rustc', ['--version', '--verbose'], source, env)).toString('utf8');
    receipt.profile.compilerHost = /^host: (.+)$/mu.exec(receipt.rustc)?.[1];
    if (receipt.profile.compilerHost !== target) throw new Error('POSIX Cargo graph compiler host differs from its actual declared target.');
    const sysroot = (await command('rustc-sysroot', 'rustc', ['--print', 'sysroot'], source, env)).toString('utf8').trim();
    receipt.toolchain = { sysroot, binaries: [], metadata: [] };
    for (const program of ['cargo', 'rustc']) {
      const filename = (await command(program + '-which', 'rustup', ['which', '--toolchain', 'nightly', program], source, env)).toString('utf8').trim();
      receipt.toolchain.binaries.push({ program, path: filename, ...await fileIdentity(filename) });
    }
    const metadataRoot = path.join(sysroot, 'lib', 'rustlib');
    for (const name of (await readdir(metadataRoot)).filter(name => ['components', 'rust-installer-version', 'multirust-channel-manifest.toml', 'multirust-config.toml'].includes(name) || name.startsWith('manifest-')).sort()) {
      const filename = path.join(metadataRoot, name);
      await copyFile(filename, path.join(output, 'toolchain', name));
      receipt.toolchain.metadata.push({ path: slash(path.relative(sysroot, filename)), ...await fileIdentity(filename) });
    }
    await command('inline-edits', 'bash', ['--noprofile', '--norc', '-ex', editScript], source, env);
    receipt.postEdit = await preserve('post-edit');
    const lockFile = path.join(source, 'Cargo.lock');
    receipt.postEditLock = { path: 'post-edit/Cargo.lock', ...await fileIdentity(lockFile) };
    if (receipt.postEditLock.sha256 !== receipt.pristineLock.sha256 || receipt.postEditLock.bytes !== receipt.pristineLock.bytes) {
      throw new Error('POSIX inline edits unexpectedly changed the pristine lock before its original regeneration command.');
    }
    await sourceTree('post-edit');
    await command('update-workspace', 'cargo', ['update', '--workspace'], source, env);
    receipt.effective = await preserve('effective');
    const effective = await sourceTree('effective'), lock = await readFile(lockFile);
    receipt.effectiveLock = { path: 'effective/Cargo.lock', ...digest(lock) };
    const allowedChanges = new Set(['Cargo.lock', 'meson.build', 'rsvg/Cargo.toml', 'librsvg-c/Cargo.toml',
      'meson.build.bak', 'rsvg/Cargo.toml.bak', 'librsvg-c/Cargo.toml.bak']);
    const originalByPath = new Map(pristine.map(entry => [entry.path, entry]));
    for (const entry of effective) {
      if (!isDeepStrictEqual(entry, originalByPath.get(entry.path)) && !allowedChanges.has(entry.path)) throw new Error('POSIX source changed outside its original inline edits/lock: ' + entry.path);
      originalByPath.delete(entry.path);
    }
    if (originalByPath.size) throw new Error('POSIX source members disappeared during original inline edits/lock regeneration.');
    for (const name of ['meson.build', 'rsvg/Cargo.toml', 'librsvg-c/Cargo.toml']) {
      if (isDeepStrictEqual(pristine.find(entry => entry.path === name), effective.find(entry => entry.path === name))) throw new Error('POSIX original inline edit did not affect its expected member: ' + name);
    }
    const args = ['tree', '--locked', '--target', target, '--package', 'librsvg-c', '--edges', 'normal,build',
      '--prefix', 'none', '--format', '{p} | {f}', '--color', 'never'];
    const raw = await command('library-tree', 'cargo', args, source, env);
    if (!(await readFile(lockFile)).equals(lock) || !isDeepStrictEqual(await sourceTree('after-tree'), effective)) throw new Error('Cargo tree changed the effective POSIX source or lock.');
    const packages = new Map();
    for (const block of lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1)) {
      const key = cargoString(block, 'name') + '@' + cargoString(block, 'version');
      const previous = packages.get(key) ?? []; previous.push(block); packages.set(key, previous);
    }
    const selected = new Map();
    for (const line of raw.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([A-Za-z0-9_-]+) v([^\s|]+)(.*?) \| (.*)$/u.exec(line);
      if (!match) throw new Error('Unrecognized original Cargo tree package row.');
      const key = match[1] + '@' + match[2], locked = packages.get(key);
      if (!locked) throw new Error('Cargo selected a dependency absent from the effective POSIX lock: ' + key);
      if (locked.length !== 1) throw new Error('Selected locked package needs explicit source disambiguation: ' + key);
      const block = locked[0];
      const entry = selected.get(key) ?? { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null,
        checksum: cargoString(block, 'checksum') ?? null, features: [], treeRows: [] };
      if (entry.source === null) {
        const location = /\(([^()]+)\)$/u.exec(match[3])?.[1];
        if (!location || !path.isAbsolute(location)) throw new Error('Selected workspace package has no original source path: ' + key);
        const actual = await realpath(location);
        const relative = actual === source ? '' : inside(source, actual);
        const manifest = path.posix.join(relative, 'Cargo.toml');
        if (!effective.some(member => member.path === manifest && !member.kind)) throw new Error('Selected workspace manifest is outside the original source archive: ' + key);
        if (entry.workspaceManifest && entry.workspaceManifest !== manifest) throw new Error('Selected workspace package has ambiguous original manifests: ' + key);
        entry.workspaceManifest = manifest;
      }
      entry.treeRows.push(line);
      entry.features = [...new Set([...entry.features, ...match[4].replace(/(?: )?\(\*\)$/u, '').split(',').filter(Boolean)])].sort();
      selected.set(key, entry);
    }
    if (!selected.has('librsvg-c@' + version) || selected.size < 2) throw new Error('Cargo tree did not supply the declared library dependency graph.');
    const held = [];
    for (const pin of [offer.rsvgCargoSources, offer.rsvgWindowsSources, offer.canvasCargoSources]) {
      const bytes = await material(pin), supplied = JSON.parse(bytes);
      await writeFile(path.join(output, 'inputs', pin.path), bytes, { flag: 'wx' });
      for (const entry of supplied.crates) held.push({ ...entry, catalog: pin.path });
    }
    for (const entry of selected.values()) {
      if (entry.source === null) { receipt.selected.push({ ...entry, suppliedBy: library.archive.path }); continue; }
      if (entry.source !== 'registry+https://github.com/rust-lang/crates.io-index' || !/^[a-f0-9]{64}$/u.test(entry.checksum ?? '')) {
        throw new Error('Selected source needs explicit non-registry acquisition: ' + entry.name);
      }
      const known = held.find(previous => previous.name === entry.name && previous.version === entry.version && previous.archive.sha256 === entry.checksum);
      if (known) {
        await material(known.archive); receipt.selected.push({ ...entry, supplied: known.archive.path, catalog: known.catalog }); continue;
      }
      const url = `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('Original selected Cargo source download failed: ' + entry.name + ' HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer()), identity = digest(bytes);
      if (identity.sha256 !== entry.checksum) throw new Error('Selected Cargo source differs from the effective POSIX lock checksum: ' + entry.name);
      const relative = 'new-crates/' + entry.name + '-' + entry.version + '.crate';
      await writeFile(path.join(output, relative), bytes, { flag: 'wx' });
      const acquired = { ...entry, url, response: { url: response.url, status: response.status, contentLength: response.headers.get('content-length'), etag: response.headers.get('etag') },
        acquired: relative, ...identity };
      receipt.selected.push(acquired); receipt.newSources.push(acquired); await save();
    }
    receipt.counts = { packages: receipt.selected.length, registry: receipt.selected.filter(entry => entry.source !== null).length,
      workspace: receipt.selected.filter(entry => entry.source === null).length, newlyAcquired: receipt.newSources.length };
    receipt.suppliedSelectionCovered = receipt.newSources.length === 0;
    for (const entry of receipt.inputs) {
      if (!isDeepStrictEqual(await fileIdentity(path.join(root, entry.path)), { bytes: entry.bytes, sha256: entry.sha256 })) throw new Error('POSIX graph input changed during capture: ' + entry.path);
    }
    for (const binary of receipt.toolchain.binaries) {
      if (!isDeepStrictEqual(await fileIdentity(binary.path), { bytes: binary.bytes, sha256: binary.sha256 })) throw new Error('Current graph tool binary changed during capture: ' + binary.program);
    }
    receipt.candidate.statusAfter = await git('candidate-status-after', ['status', '--porcelain=v1', '--untracked-files=all']);
    if (receipt.candidate.statusAfter || await git('candidate-commit-after', ['rev-parse', 'HEAD']) !== receipt.candidate.commit) throw new Error('POSIX graph candidate changed during capture.');
    receipt.completed = true;
  } catch (error) { primary = error; receipt.error = { name: error.name, message: error.message }; }
  receipt.finishedAt = new Date().toISOString();
  try { await save(); }
  catch (error) { if (primary) throw new AggregateError([primary, error], 'POSIX graph capture and receipt failed.', { cause: primary }); throw error; }
  if (primary) throw primary;
}

await capture(process.argv[2], process.argv[3], process.argv[4]);
