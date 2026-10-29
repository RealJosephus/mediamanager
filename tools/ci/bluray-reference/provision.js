import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, constants } from 'node:fs';
import { access, appendFile, lstat, mkdir, open, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { downloadOriginalIso } from './http-source.js';
import { safeMember } from './torrent.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url)), execute = promisify(execFile);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const ordered = values => values.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--output', '--archive-tool'].includes(key) && value && !Object.hasOwn(options, key)); options[key] = value;
}
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.MEDIAMANAGER_CI_BLURAY_REFERENCE, 'true');
assert.ok(process.env.RUNNER_TEMP && options['--output'] && options['--archive-tool']);
const temporaryRoot = await realpath(process.env.RUNNER_TEMP), output = path.resolve(options['--output']);
assert.equal(path.dirname(output), temporaryRoot, 'Use a fresh direct child of the actual runner temporary directory.');
await mkdir(output);
const evidence = path.join(output, 'evidence'), work = path.join(output, 'work'), media = path.join(output, 'media');
await mkdir(evidence); await mkdir(work); await mkdir(media);
const deadline = AbortSignal.timeout(55 * 60_000);
const state = { schemaVersion: 1, phase: 'starting', passed: false, sourceComplete: false, payloadComplete: false,
  startedAt: new Date().toISOString(), http: [], processes: [], errors: [] };
const save = () => writeFile(path.join(evidence, 'acquisition.json'), json(state));
const phase = async value => { state.phase = value; await save(); console.log('Complete original Blu-ray: ' + value); };
async function digestFile(filename, md5 = false) {
  const before = await lstat(filename, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink());
  const sha = createHash('sha256'), legacy = md5 ? createHash('md5') : null; let bytes = 0;
  for await (const chunk of createReadStream(filename, { signal: deadline })) { bytes += chunk.length; sha.update(chunk); legacy?.update(chunk); }
  const after = await lstat(filename, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'An original input changed during hashing.');
  assert.equal(BigInt(bytes), before.size);
  return { bytes, sha256: sha.digest('hex'), ...(legacy ? { md5: legacy.digest('hex') } : {}) };
}
async function command(label, executable, args, timeoutMs = 10 * 60_000) {
  const record = { label, executable, args, startedAt: new Date().toISOString(), passed: false };
  state.processes.push(record); await save();
  const child = spawn(executable, args, { cwd: work, windowsHide: true, shell: false,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let length = 0, failure, force;
  const stop = error => { failure ??= error; child.kill('SIGTERM'); force ??= setTimeout(() => child.kill('SIGKILL'), 10000); };
  const collect = chunks => chunk => { length += chunk.length; if (length <= 8 * 1024 * 1024) chunks.push(Buffer.from(chunk)); else stop(new Error('Disc reader diagnostic limit exceeded.')); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr)); child.once('error', error => { failure ??= error; });
  const timer = setTimeout(() => stop(new Error('Disc reader exceeded its acquisition budget.')), timeoutMs);
  const abort = () => stop(deadline.reason); deadline.addEventListener('abort', abort, { once: true });
  if (deadline.aborted) abort();
  try { await new Promise(resolve => child.once('close', (code, signal) => { record.code = code; record.signal = signal; resolve(); })); }
  finally { clearTimeout(timer); clearTimeout(force); deadline.removeEventListener('abort', abort); }
  for (const [name, chunks] of [['stdout', stdout], ['stderr', stderr]]) {
    const bytes = Buffer.concat(chunks); await writeFile(path.join(evidence, label + '.' + name + '.txt'), bytes, { flag: 'wx' });
    record[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  record.finishedAt = new Date().toISOString(); record.passed = !failure && record.code === 0;
  if (failure) record.error = { name: failure.name, message: failure.message };
  await save(); assert.equal(record.passed, true, label + ' failed; retain its actual reader output.');
  return Buffer.concat(stdout).toString('utf8');
}
function members(listing) {
  const result = [];
  for (const block of listing.split(/(?=^Path = )/mu)) {
    const fields = Object.fromEntries(block.split(/\r?\n/u).map(line => /^([^=]+?) = (.*)$/u.exec(line)).filter(Boolean).map(match => [match[1], match[2]]));
    if (!fields.Path || fields.Type) continue;
    assert.ok(!fields['Symbolic Link'] && !fields['Hard Link']);
    const member = safeMember(fields.Path.replaceAll('\\', '/')), kind = fields.Folder === '+' || /^D/u.test(fields.Attributes ?? '') ? 'directory' : 'file';
    const bytes = Number(fields.Size); assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
    result.push({ path: member, kind, bytes: kind === 'directory' ? 0 : bytes });
  }
  assert.ok(result.length > 0 && result.length < 10000);
  assert.equal(new Set(result.map(member => member.path.toLowerCase())).size, result.length);
  return ordered(result);
}
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = safeMember(prefix ? prefix + '/' + entry.name : entry.name), filename = path.join(directory, entry.name);
    const info = await lstat(filename); assert.ok(!info.isSymbolicLink());
    if (info.isDirectory()) result.push({ path: name, kind: 'directory', bytes: 0 }, ...await inventory(filename, name));
    else { assert.ok(info.isFile()); result.push({ path: name, kind: 'file', ...await digestFile(filename) }); }
  }
  return ordered(result);
}
try {
  await phase('bind-current-source-and-real-host-reader');
  const sourceBytes = await readFile(new URL('./sintel.json', import.meta.url)), source = JSON.parse(sourceBytes);
  assert.match(source.iso.sha256, /^[a-f0-9]{64}$/u, 'The consumer supply requires the reviewed complete ISO SHA256.');
  const manifestBytes = await readFile(new URL('./first-sintel-ci/complete-files.json', import.meta.url)), originalManifest = JSON.parse(manifestBytes);
  const producerPaths = ['tools/ci/bluray-reference/provision.js', 'tools/ci/bluray-reference/http-source.js', 'tools/ci/bluray-reference/torrent.js',
    'tools/ci/bluray-reference/sintel.json', 'tools/ci/bluray-reference/first-sintel-ci/complete-files.json', '.github/workflows/ci.yml',
    ...source.metadata.map(member => 'tools/ci/bluray-reference/' + member.path)];
  state.producer = { identity: Object.fromEntries(['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA',
    'GITHUB_JOB', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'RUNNER_OS', 'RUNNER_ARCH'].map(name => {
    assert.ok(process.env[name], 'Missing same-run source identity ' + name); return [name, process.env[name]];
  })), checkout: { head: (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
    tree: (await execute('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository })).stdout.trim() },
  node: { filename: await realpath(process.execPath), version: process.version, ...await digestFile(process.execPath) }, files: [] };
  assert.equal(state.producer.checkout.head, process.env.GITHUB_SHA);
  for (const relative of producerPaths) state.producer.files.push({ path: relative, ...await digestFile(path.join(repository, relative)) });
  await writeFile(path.join(evidence, 'source.json'), sourceBytes, { flag: 'wx' });
  await writeFile(path.join(evidence, 'media-inventory.json'), manifestBytes, { flag: 'wx' });
  for (const member of source.metadata) {
    const filename = path.join(repository, 'tools/ci/bluray-reference', safeMember(member.path));
    assert.deepEqual(await digestFile(filename), { bytes: member.bytes, sha256: member.sha256 });
    await writeFile(path.join(evidence, 'original-' + path.basename(member.path)), await readFile(filename), { flag: 'wx' });
  }
  const archive = await realpath(options['--archive-tool']); await access(archive, constants.X_OK);
  const handle = await open(archive, 'r'); const magic = Buffer.alloc(4);
  try { assert.equal((await handle.read(magic, 0, 4, 0)).bytesRead, 4); } finally { await handle.close(); }
  assert.ok(process.platform === 'win32' ? magic.subarray(0, 2).toString('ascii') === 'MZ'
    : process.platform === 'linux' ? magic.toString('hex') === '7f454c46'
      : ['cafebabe', 'bebafeca', 'feedfacf', 'cffaedfe', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')),
  'Bind the actual platform reader image, never another host path or launcher.');
  state.archiveTool = { filename: archive, platform: process.platform, architecture: process.arch, magic: magic.toString('hex'), ...await digestFile(archive), dependencies: [] };
  if (process.platform === 'win32') {
    const dll = path.join(path.dirname(archive), '7z.dll'); state.archiveTool.dependencies.push({ filename: dll, ...await digestFile(dll) });
  }
  const formats = await command('archive-formats', archive, ['i', '-sccUTF-8'], 30000);
  assert.match(formats, /7-Zip/iu); assert.match(formats, /\bUdf\b/iu);
  const disk = await statfs(output, { bigint: true });
  state.availableBytes = String(disk.bavail * disk.bsize);
  assert.ok(disk.bavail * disk.bsize > BigInt(source.iso.bytes) * 2n + 512n * 1024n ** 2n);
  await phase('download-entire-frozen-official-iso');
  const image = path.join(work, source.iso.filename);
  state.download = await downloadOriginalIso(source.iso, image, { signal: deadline, timeoutMinutes: source.downloadTimeoutMinutes,
    onResponse: async observation => { state.http.push(observation); await save(); },
    onProgress: async value => { state.download = value; await save(); } });
  const persisted = await digestFile(image, true);
  assert.deepEqual(persisted, { bytes: source.iso.bytes, sha256: source.iso.sha256, md5: source.iso.md5 });
  state.sourceComplete = true;
  await phase('test-and-extract-every-original-udf-member');
  const listing = await command('iso-members', archive, ['l', '-slt', '-sccUTF-8', image]); assert.match(listing, /Type = Udf\b/iu);
  const listed = members(listing), expectedMembers = originalManifest.map(({ path, kind, bytes }) => ({ path, kind, bytes }));
  assert.deepEqual(listed, expectedMembers, 'The entire original UDF member set must match the complete first acquisition.');
  await writeFile(path.join(evidence, 'original-members.json'), json(listed), { flag: 'wx' });
  await command('iso-test', archive, ['t', '-y', '-sccUTF-8', image]);
  await command('iso-extract', archive, ['x', '-y', '-sccUTF-8', '-o' + media, image]);
  const actual = await inventory(media);
  assert.deepEqual(actual, originalManifest, 'Every original directory, complete BDMV file and stream must retain its exact bytes.');
  const bdmv = actual.filter(member => member.kind === 'file' && member.path.startsWith('BDMV/'));
  assert.equal(bdmv.length, 14); assert.equal(bdmv.reduce((sum, member) => sum + member.bytes, 0), 1592116024);
  await writeFile(path.join(evidence, 'bdmv-files.json'), json(bdmv), { flag: 'wx' });
  assert.deepEqual(await digestFile(image, true), persisted);
  for (const file of [state.archiveTool, ...state.archiveTool.dependencies]) assert.deepEqual(await digestFile(file.filename), { bytes: file.bytes, sha256: file.sha256 });
  for (const file of state.producer.files) assert.deepEqual(await digestFile(path.join(repository, file.path)), { bytes: file.bytes, sha256: file.sha256 });
  const receipt = { schemaVersion: 1, complete: true, sourceId: 'sintel', source: { descriptorSha256: hash(sourceBytes), ...source.iso },
    producer: state.producer, archiveTool: state.archiveTool, download: persisted, originalIso: image, sourceArchiveRetained: true,
    mediaRoot: media, discRoot: media, bdmvRoot: path.join(media, 'BDMV'),
    inventory: { filename: 'media-inventory.json', sha256: hash(manifestBytes), bytes: manifestBytes.length, entries: actual.length },
    completeFiles: bdmv.length, completeBdmvBytes: 1592116024,
    acceptance: { completeOriginalAcquired: true, actualNativeBdInfo: false, actualProbe: false, actualScan: false,
      databaseExchange: false, releaseAcceptance: false } };
  await writeFile(path.join(evidence, 'receipt.json'), json(receipt), { flag: 'wx' });
  state.payloadComplete = true; state.passed = true; await phase('complete');
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, 'MEDIAMANAGER_TEST_BLURAY_REFERENCE=' + path.join(evidence, 'receipt.json') + '\n');
} catch (error) {
  state.errors.push({ name: error.name, message: error.message, stack: error.stack, code: error.code }); process.exitCode = 1;
} finally { state.finishedAt = new Date().toISOString(); await save(); }
