import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseLibraryOptions } from '../../library/options.js';
import { canonicalPortableMountContract } from '../../storage/portable-mount-contract.js';
import { exists } from './files.js';

export const savedMounts = (root) => path.join(root, 'config', 'mediamanager-mounts.json');
export async function embyLibraryMounts(root) {
  const libraries = path.join(root, 'root', 'default'),
    mounts = new Map();
  const paths = [];
  const db = new DatabaseSync(path.join(root, 'data', 'library.db'), { readOnly: true });
  try {
    for (const row of db
      .prepare(
        "SELECT e.Value FROM ItemExtradata e JOIN ItemExtradataTypes t ON t.ExtradataTypeId=e.ExtradataTypeId WHERE t.Name='LibraryOptions'",
      )
      .iterate())
      paths.push(...(JSON.parse(row.Value).PathInfos ?? []));
  } finally {
    db.close();
  }
  if (await exists(libraries)) {
    for (const entry of await readdir(libraries, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const options = path.join(libraries, entry.name, 'options.xml');
      if (!(await exists(options))) continue;
      const library = parseLibraryOptions(await readFile(options, 'utf8'));
      paths.push(...(library.PathInfos ?? []));
    }
  }
  for (const info of paths) {
    const identityRoot = info?.Path;
    if (typeof identityRoot !== 'string' || !identityRoot) continue;
    const windows = /^(?:[a-z]:[\\/]|\\\\)/iu.test(identityRoot);
    if (!(windows ? path.win32 : path.posix).isAbsolute(identityRoot)) continue;
    const hash = createHash('sha256').update(identityRoot).digest('hex').slice(0, 14);
    mounts.set(identityRoot, {
      mountId: 'library-' + hash,
      identityRoot,
      accessRoot: '/media/' + hash,
      pathStyle: windows ? 'windows' : 'posix',
      caseSensitive: !windows,
      returnPolicy: 'required',
    });
  }
  return canonicalPortableMountContract({ mounts: [...mounts.values()] });
}
