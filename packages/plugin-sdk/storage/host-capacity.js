import { readFile, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

async function linuxVolumes() {
  try {
    const table = await readFile('/proc/self/mountinfo', 'utf8');
    return table.split('\n').flatMap(entry => {
      const separator = entry.indexOf(' - ');
      if (separator < 0) return [];
      const encoded = entry.slice(0, separator).split(' ')[4];
      return encoded ? [{ mount: encoded.replace(/\\([0-7]{3})/gu, (_match, code) =>
        String.fromCharCode(Number.parseInt(code, 8))), type: entry.slice(separator + 3).split(' ', 1)[0] }] : [];
    });
  } catch {
    // Other Unix environments are not guaranteed to expose procfs.
    return [];
  }
}

async function volumeRoot(filename) {
  const device = (await stat(filename, { bigint: true })).dev;
  let root = filename;
  for (let parent = path.dirname(root); root !== parent; parent = path.dirname(root)) {
    if ((await stat(parent, { bigint: true })).dev !== device) break;
    root = parent;
  }
  return root;
}

/** Read capacity available to this process from the filesystem owning a path. */
export async function hostFolderCapacity(filename, { signal } = {}) {
  signal?.throwIfAborted();
  const target = await realpath(filename);
  const { bavail, blocks, bsize } = await statfs(target, { bigint: true });
  if (bsize <= 0n || bavail < 0n || blocks < bavail) return null;
  const volumes = process.platform === 'linux' ? await linuxVolumes() : [];
  const mounted = volumes.filter(({ mount }) => target === mount
    || target.startsWith(mount.endsWith(path.sep) ? mount : mount + path.sep))
    .sort((left, right) => right.mount.length - left.mount.length)[0];
  const deviceId = mounted?.mount ?? (process.platform === 'win32' ? path.parse(target).root : await volumeRoot(target));
  const type = mounted?.type ?? '';
  const storageType = deviceId.startsWith('\\\\') || /^(?:nfs[0-9]*|cifs|smb[0-9]*|9p|afs|fuse\.sshfs)$/u.test(type) ? 'Network'
    : /^(?:tmpfs|ramfs)$/u.test(type) ? 'Ram'
      : /^(?:iso9660|udf)$/u.test(type) ? 'CDRom'
        : 'Fixed';
  signal?.throwIfAborted();
  return { freeBytes: bavail * bsize, usedBytes: (blocks - bavail) * bsize, deviceId, storageType };
}
