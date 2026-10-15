import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validationPath } from '../validation/paths.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });

export async function verifyBaseline(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isAbsolute(manifest.source) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Invalid reference baseline manifest.');
  }
  const records = [];
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes('\0')
      || isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid reference baseline file path.');
    }
    records.push(`${file.path}\t${file.deleted === true ? 'DELETED' : file.sha256}\n`);
  }
  const paths = manifest.files.map(file => file.path);
  const sorted = [...paths].sort();
  if (new Set(paths).size !== paths.length || paths.some((name, index) => name !== sorted[index])) {
    throw new Error('Reference baseline paths must be unique and sorted in UTF-16 code-unit order.');
  }
  if (hash(records.join('')) !== manifest.contentDigest) throw new Error('Reference manifest aggregate digest changed.');
  const head = () => git(manifest.source, ['rev-parse', 'HEAD']).toString().trim();
  const status = () => git(manifest.source, ['status', '--porcelain=v1', '-z']).toString();
  const names = () => [...new Set(git(manifest.source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean))].sort();
  const checkRepository = () => {
    if (head() !== manifest.head) throw new Error('Reference HEAD changed.');
    if (status() !== manifest.status) throw new Error('Reference Git status changed.');
    if (JSON.stringify(names()) !== JSON.stringify(paths)) throw new Error('Reference file discovery changed.');
  };
  checkRepository();
  for (const file of manifest.files) {
    const filename = resolve(manifest.source, file.path);
    let stat;
    try { stat = await lstat(filename); }
    catch (error) { if (error.code !== 'ENOENT' || !file.deleted) throw error; }
    if (file.deleted === true) {
      if (stat) throw new Error(`Reference deleted file reappeared: ${file.path}`);
      continue;
    }
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported reference object: ${file.path}`);
    const bytes = await readFile(filename);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error(`Reference file changed: ${file.path}`);
  }
  checkRepository();
  return { source: manifest.source, head: manifest.head, verifiedFiles: paths.length,
    contentUnchanged: true, statusUnchanged: true, fileDiscoveryUnchanged: true, contentDigest: manifest.contentDigest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyBaseline(validationPath(process.argv[2] ?? '.agent-docs/baselines/jellyfin-current/manifest.json'))));
}
