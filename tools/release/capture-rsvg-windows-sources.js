import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cargoString, fileIdentity, gitCommand, inside, json } from './materials.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = 'tools/release/source-materials', inputs = [];
const target = 'x86_64-pc-windows-gnullvm';

async function read(pin) {
  const filename = path.join(root, directory, pin.path), actual = await fileIdentity(filename);
  if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) throw new Error('Windows source graph input changed: ' + pin.path);
  inputs.push({ path: pin.path, ...actual });
  return await readFile(filename);
}

async function command(program, args, cwd, output, name, env = process.env) {
  const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let bytes = 0, failed = false, failure;
  const record = (chunks, chunk) => {
    bytes += chunk.length;
    if (bytes <= 32 * 1024 * 1024) chunks.push(chunk);
    else if (!failed) { failed = true; failure = new Error('Source graph command output exceeds its complete-output bound.'); child.kill(); }
  };
  child.stdout.on('data', chunk => record(stdout, chunk)); child.stderr.on('data', chunk => record(stderr, chunk));
  child.on('error', error => { if (!failed) { failed = true; failure = error; } });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  await writeFile(path.join(output, 'logs', name + '.stdout'), out, { flag: 'wx' });
  await writeFile(path.join(output, 'logs', name + '.stderr'), err, { flag: 'wx' });
  if (failed) throw failure;
  if (result.code !== 0 || result.signal) throw new Error(`Source graph command failed (${name}: ${result.signal ?? result.code}).`);
  return out;
}

async function capture(output) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('Capture native source graphs in GitHub Actions.');
  output = path.resolve(output); inside(process.env.RUNNER_TEMP, output);
  await mkdir(output); await mkdir(path.join(output, 'logs')); await mkdir(path.join(output, 'working-source'));
  await mkdir(path.join(output, 'effective')); await mkdir(path.join(output, 'pristine')); await mkdir(path.join(output, 'new-crates'));
  const candidate = { commit: (await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim(), tree: (await gitCommand(['rev-parse', 'HEAD^{tree}'], { cwd: root })).trim() };
  const receipt = { candidate, target, package: 'librsvg-c', features: [], completed: false,
    scope: 'Current declared default Windows library dependency graph from the original source and Windows patch. Not a recovered historical compile/link graph or proof of a complete aggregate build.' };
  receipt.inputs = inputs;
  let failed = false, primary;
  try {
    const offer = await json(path.join(root, directory, 'source-offer.json'));
    const catalog = JSON.parse(await read(offer.nativeFullSources));
    const library = catalog.sources.find(source => source.name === 'rsvg'); await read(library.archive);
    const recipes = JSON.parse(await read(offer.recipeFragments));
    const windows = recipes.sources.find(source => source.id === library.modifications.windows.sourceId);
    const overrides = windows.files.find(file => file.upstreamPath === 'build/overrides.mk');
    const overrideText = (await read(overrides)).toString('utf8');
    if (!overrideText.includes("-Dtriplet='$(PROCESSOR)-pc-windows-gnullvm'") || !overrideText.includes('-Dpixbuf=disabled')) {
      throw new Error('Windows source graph target differs from the actual producer recipe.');
    }
    await command('tar', ['-xf', path.join(root, directory, library.archive.path), '-C', path.join(output, 'working-source')], root, output, 'extract');
    const source = path.join(output, 'working-source', library.root.slice(0, -1));
    await command('git', ['init'], source, output, 'source-git');
    const changed = ['Cargo.lock', 'meson.build', 'rsvg/Cargo.toml', 'librsvg-c/Cargo.toml', 'rsvg/meson.build'];
    for (const name of changed) {
      await mkdir(path.dirname(path.join(output, 'pristine', name)), { recursive: true });
      await copyFile(path.join(source, name), path.join(output, 'pristine', name));
    }
    for (let index = 0; index < library.modifications.windows.patches.length; index += 1) {
      const patch = library.modifications.windows.patches[index], original = windows.files.find(file => file.path === patch.path);
      if (!original) throw new Error('Windows source graph patch is absent from its original recipe.');
      await read(original);
      await command('git', ['apply', path.join(root, directory, patch.path)], source, output, 'patch-' + index);
    }
    for (const name of changed) {
      await mkdir(path.dirname(path.join(output, 'effective', name)), { recursive: true });
      await copyFile(path.join(source, name), path.join(output, 'effective', name));
    }
    const lockFile = path.join(source, 'Cargo.lock'), lock = await readFile(lockFile), lockIdentity = await fileIdentity(lockFile);
    receipt.effectiveLock = lockIdentity;
    const env = { ...process.env, CARGO_HOME: path.join(output, 'cargo-home'), RUSTUP_TOOLCHAIN: 'stable' };
    receipt.cargo = (await command('cargo', ['+stable', '--version', '--verbose'], source, output, 'cargo-version', env)).toString('utf8');
    receipt.rustc = (await command('rustc', ['+stable', '--version', '--verbose'], source, output, 'rustc-version', env)).toString('utf8');
    const args = ['+stable', 'tree', '--locked', '--target', target, '--package', 'librsvg-c', '--edges', 'normal,build',
      '--prefix', 'none', '--format', '{p} | {f}', '--color', 'never'];
    const raw = await command('cargo', args, source, output, 'library-tree', env);
    if (!(await readFile(lockFile)).equals(lock)) throw new Error('Cargo changed the effective Windows source lock.');
    const packages = new Map(lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1)
      .map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
    const selected = new Map();
    for (const line of raw.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([A-Za-z0-9_-]+) v([^\s|]+)/u.exec(line);
      if (!match) throw new Error('Unrecognized original Cargo tree package row.');
      const key = match[1] + '@' + match[2], block = packages.get(key);
      if (!block) throw new Error('Cargo selected a dependency absent from the effective source lock: ' + key);
      selected.set(key, { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null, checksum: cargoString(block, 'checksum') ?? null });
    }
    const held = JSON.parse(await read(offer.rsvgCargoSources));
    receipt.selected = [];
    for (const entry of selected.values()) {
      if (entry.source === null) { receipt.selected.push(entry); continue; }
      if (entry.source !== 'registry+https://github.com/rust-lang/crates.io-index' || !entry.checksum) throw new Error('Selected source needs an explicit non-registry acquisition.');
      const known = held.crates.find(source => source.name === entry.name && source.version === entry.version && source.archive.sha256 === entry.checksum);
      if (known) {
        await read(known.archive); receipt.selected.push({ ...entry, supplied: known.archive.path }); continue;
      }
      const url = `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('Original selected Cargo source download failed: ' + entry.name);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== entry.checksum) throw new Error('Selected Cargo source differs from the effective Windows lock checksum.');
      const filename = path.join(output, 'new-crates', entry.name + '-' + entry.version + '.crate');
      await writeFile(filename, bytes, { flag: 'wx' });
      receipt.selected.push({ ...entry, url, acquired: path.relative(output, filename).split(path.sep).join('/'), bytes: bytes.length });
    }
    for (const input of inputs) {
      const actual = await fileIdentity(path.join(root, directory, input.path));
      if (actual.bytes !== input.bytes || actual.sha256 !== input.sha256) throw new Error('Windows source graph input changed during capture.');
    }
    receipt.completed = true;
  } catch (error) { failed = true; primary = error; }
  try { await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Source graph capture and receipt failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
}

await capture(process.argv[2]);
