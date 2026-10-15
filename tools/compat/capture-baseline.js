import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], {
  maxBuffer: 32 * 1024 * 1024,
});

const isWithin = (root, filename) => {
  const suffix = relative(root, filename);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};

async function resolvedExistingAncestor(filename) {
  const suffix = [];
  let current = resolve(filename);
  for (;;) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

export async function captureBaseline(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  const initialHead = git(source, ['rev-parse', 'HEAD']).toString().trim();
  const initialStatus = git(source, ['status', '--porcelain=v1', '-z']).toString();
  const [resolvedSource, resolvedDestination] = await Promise.all([
    realpath(source),
    resolvedExistingAncestor(destination),
  ]);
  if (isWithin(resolvedSource, resolvedDestination)) {
    throw new Error('The baseline destination must be outside the reference checkout.');
  }
  // Exclusive creation prevents mixing captures or overwriting evidence.
  await mkdir(destination);
  const names = [...new Set(git(source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean))].sort();
  const files = [];
  for (const name of names) {
    const sourcePath = resolve(source, name);
    const safe = relative(source, sourcePath);
    if (safe.startsWith('..') || isAbsolute(safe)) throw new Error(`Unsafe source path: ${name}`);
    let stat;
    try { stat = await lstat(sourcePath); }
    catch (error) { if (error.code === 'ENOENT') { files.push({ path: name, deleted: true }); continue; } throw error; }
    if (!stat.isFile()) throw new Error(`Unsupported baseline object: ${name}`);
    const bytes = await readFile(sourcePath);
    const targetPath = resolve(destination, 'source', name);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes, { flag: 'wx' });
    files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
  }
  const contentDigest = hash(files.map(file => `${file.path}\t${file.deleted ? 'DELETED' : file.sha256}\n`).join(''));
  const manifest = {
    capturedAt: new Date().toISOString(), source,
    head: initialHead,
    status: initialStatus,
    ordering: 'JavaScript UTF-16 code-unit order; forward-slash paths; LF records',
    contentDigest, files,
  };
  await writeFile(resolve(destination, 'tracked.patch'), git(source, ['diff', '--binary', 'HEAD']), { flag: 'wx' });
  await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  // Verify the source did not change while being captured.
  for (const file of files) {
    if (file.deleted) {
      try { await lstat(resolve(source, file.path)); throw new Error(`Source appeared during capture: ${file.path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (hash(await readFile(resolve(source, file.path))) !== file.sha256) {
      throw new Error(`Source changed during capture: ${file.path}`);
    }
  }
  if (git(source, ['status', '--porcelain=v1', '-z']).toString() !== manifest.status) {
    throw new Error('Source status changed during capture.');
  }
  if (git(source, ['rev-parse', 'HEAD']).toString().trim() !== manifest.head) {
    throw new Error('Source HEAD changed during capture.');
  }
  await writeFile(resolve(destination, 'verified.json'), JSON.stringify({ contentDigest, verifiedAt: new Date().toISOString() }));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source = 'D:/jellyfin', destination = '.agent-docs/baselines/jellyfin-current'] = process.argv;
  await mkdir(dirname(resolve(destination)), { recursive: true });
  const result = await captureBaseline(source, destination);
  console.log(JSON.stringify({ head: result.head, files: result.files.length, contentDigest: result.contentDigest }));
}
