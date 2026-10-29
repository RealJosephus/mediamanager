import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { acquireTestResource } from './test-resource-lease.js';

function invalid(code, key, directory, message) {
  return Object.assign(new Error(message), { code, resource: key, directory, owner: null });
}

/** Settle every real release in reverse admission order, retaining ordered failures. */
export async function settleTestResourceRelease(leases) {
  const errors = [];
  for (const lease of leases.toReversed()) {
    try { await lease.release(); } catch (error) { errors.push(error); }
  }
  return errors;
}

/** Acquire a complete file declaration set in the same physical-root/key order in every process. */
export async function acquireTestResources(declarations, { signal } = {}) {
  signal?.throwIfAborted();
  const resources = new Map(), leases = [];
  for (const declaration of declarations) {
    if (declaration.enabled !== undefined && !declaration.enabled) continue;
    signal?.throwIfAborted();
    const key = declaration.key, root = declaration.root === undefined ? process.env.MEDIAMANAGER_TEST_RESOURCE_ROOT : declaration.root;
    if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(key)) {
      throw invalid('test-resource-key-invalid', key, null, 'A test resource requires a single lowercase key.');
    }
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw invalid('test-resource-root-required', key, null, 'MEDIAMANAGER_TEST_RESOURCE_ROOT must name an absolute job-local output directory.');
    }
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw invalid('test-resource-root-invalid', key, root, 'The test resource root must be a physical output directory.');
    }
    const physicalRoot = await realpath(root), identity = process.platform === 'win32' ? physicalRoot.toLowerCase() : physicalRoot;
    const id = JSON.stringify([identity, key]);
    if (!resources.has(id)) resources.set(id, { key, root: physicalRoot, identity, declarations: [] });
    resources.get(id).declarations.push(declaration);
  }
  const ordered = [...resources.values()].toSorted((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1
    : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  try {
    for (const resource of ordered) {
      signal?.throwIfAborted();
      leases.push(await acquireTestResource(resource.key, { root: resource.root, signal,
        onWait: async owner => {
          for (const declaration of resource.declarations) await declaration.onWait?.({ ...owner });
        } }));
    }
    signal?.throwIfAborted();
    return leases;
  } catch (primary) {
    const cleanup = await settleTestResourceRelease(leases);
    if (cleanup.length) throw new AggregateError([primary, ...cleanup], primary?.message, { cause: primary });
    throw primary;
  }
}
