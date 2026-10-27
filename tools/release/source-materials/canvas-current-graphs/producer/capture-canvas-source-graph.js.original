import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoString, fileIdentity, gitCommand, inside, json } from './materials.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), directory = 'tools/release/source-materials';
const targets = { 'linux/x64': 'x86_64-unknown-linux-gnu', 'win32/x64': 'x86_64-pc-windows-msvc', 'darwin/arm64': 'aarch64-apple-darwin' };

async function command(program, args, cwd, output, name, env) {
  const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = { stdout: [], stderr: [] }; let bytes = 0, failed = false, primary;
  const receive = (stream, chunk) => {
    bytes += chunk.length;
    if (bytes <= 32 * 1024 * 1024) chunks[stream].push(chunk);
    else if (!failed) { failed = true; primary = new Error('Canvas source graph command exceeds its complete-output bound.'); child.kill(); }
  };
  child.stdout.on('data', chunk => receive('stdout', chunk)); child.stderr.on('data', chunk => receive('stderr', chunk));
  child.on('error', error => { if (!failed) { failed = true; primary = error; } });
  const settled = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  if (!failed && (settled.code !== 0 || settled.signal)) { failed = true; primary = new Error(`Canvas source graph command failed (${name}: ${settled.signal ?? settled.code}).`); }
  const outputBytes = {}, errors = failed ? [primary] : [];
  for (const stream of ['stdout', 'stderr']) {
    outputBytes[stream] = Buffer.concat(chunks[stream]);
    try { await writeFile(path.join(output, 'logs', name + '.' + stream), outputBytes[stream], { flag: 'wx' }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length > 1) throw new AggregateError(errors, 'Canvas source graph command and output failed.', { cause: errors[0] });
  if (errors.length) throw errors[0];
  return outputBytes.stdout;
}

async function capture(output, target) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || targets[process.platform + '/' + process.arch] !== target) {
    throw new Error('Capture Canvas source graphs on each actual declared GitHub Actions host/target.');
  }
  output = path.resolve(output); inside(process.env.RUNNER_TEMP, output); await mkdir(output);
  for (const name of ['logs', 'working-source', 'new-crates']) await mkdir(path.join(output, name));
  const sourceRoot = path.join(output, 'working-source'), inputs = [];
  const candidate = { commit: (await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim(), tree: (await gitCommand(['rev-parse', 'HEAD^{tree}'], { cwd: root })).trim() };
  const receipt = { candidate, target, host: { platform: process.platform, architecture: process.arch }, package: 'canvas', features: [],
    inputs, completed: false, scope: 'Current default Canvas normal/build dependency graph on its actual declared host/target from the original manifest/lock. Not a recovered historical cache/link graph or modified binary build.' };
  const read = async pin => {
    const filename = path.join(root, directory, pin.path), actual = await fileIdentity(filename);
    if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) throw new Error('Canvas source graph input changed: ' + pin.path);
    inputs.push({ path: pin.path, ...actual }); return await readFile(filename);
  };
  let failed = false, primary;
  try {
    const offer = await json(path.join(root, directory, 'source-offer.json'));
    const native = JSON.parse(await read(offer.nativePackages)), supplied = JSON.parse(await read(offer.canvasCargoSources));
    receipt.canvasCommit = native.canvas.candidate.commit;
    for (const file of native.canvas.files) {
      const bytes = await read(file), filename = path.join(sourceRoot, file.upstreamPath); inside(sourceRoot, filename);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
    }
    const lockFile = path.join(sourceRoot, 'Cargo.lock'), lock = await readFile(lockFile);
    receipt.originalLock = await fileIdentity(lockFile);
    await copyFile(lockFile, path.join(output, 'Cargo.lock'));
    const env = { ...process.env, CARGO_HOME: path.join(output, 'cargo-home'), CARGO_TARGET_DIR: path.join(output, 'target'), RUSTUP_TOOLCHAIN: 'stable' };
    receipt.cargo = (await command('cargo', ['+stable', '--version', '--verbose'], sourceRoot, output, 'cargo-version', env)).toString('utf8');
    receipt.rustc = (await command('rustc', ['+stable', '--version', '--verbose'], sourceRoot, output, 'rustc-version', env)).toString('utf8');
    if (!receipt.rustc.split(/\r?\n/u).includes('host: ' + target)) throw new Error('Canvas source graph compiler host differs from the actual declared target.');
    const raw = await command('cargo', ['+stable', 'tree', '--locked', '--target', target, '--package', 'canvas', '--edges', 'normal,build',
      '--prefix', 'none', '--format', '{p} | {f}', '--color', 'never'], sourceRoot, output, 'library-tree', env);
    if (!(await readFile(lockFile)).equals(lock)) throw new Error('Cargo changed the original Canvas source lock.');
    const packages = new Map(lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1)
      .map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
    const selected = new Map();
    for (const line of raw.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([A-Za-z0-9_-]+) v([^\s|]+)/u.exec(line); if (!match) throw new Error('Unrecognized Canvas Cargo tree source row.');
      const key = match[1] + '@' + match[2], block = packages.get(key); if (!block) throw new Error('Canvas Cargo selected a package outside the original source lock.');
      selected.set(key, { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null, checksum: cargoString(block, 'checksum') ?? null });
    }
    receipt.selected = []; receipt.newSources = [];
    for (const entry of selected.values()) {
      if (entry.source === null) { receipt.selected.push(entry); continue; }
      if (entry.source !== 'registry+https://github.com/rust-lang/crates.io-index') throw new Error('Canvas source graph needs an explicit non-registry acquisition.');
      const previous = supplied.crates.find(source => source.name === entry.name && source.version === entry.version && source.archive.sha256 === entry.checksum);
      if (previous) { await read(previous.archive); receipt.selected.push({ ...entry, supplied: previous.archive.path }); continue; }
      const url = `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error('Missing Canvas graph source download failed.');
      const bytes = Buffer.from(await response.arrayBuffer()); if (createHash('sha256').update(bytes).digest('hex') !== entry.checksum) throw new Error('Missing Canvas graph source differs from its original lock checksum.');
      const filename = path.join(output, 'new-crates', entry.name + '-' + entry.version + '.crate'); await writeFile(filename, bytes, { flag: 'wx' });
      const acquired = { ...entry, url, acquired: path.relative(output, filename).split(path.sep).join('/'), bytes: bytes.length };
      receipt.selected.push(acquired); receipt.newSources.push(acquired);
    }
    receipt.suppliedSelectionCovered = receipt.newSources.length === 0;
    for (const input of inputs) {
      const actual = await fileIdentity(path.join(root, directory, input.path));
      if (actual.bytes !== input.bytes || actual.sha256 !== input.sha256) throw new Error('Canvas source graph input changed during capture.');
    }
    receipt.completed = true;
  } catch (error) { failed = true; primary = error; }
  try { await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Canvas source graph capture and receipt failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
}

await capture(process.argv[2], process.argv[3]);
