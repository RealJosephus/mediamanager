import assert from 'node:assert/strict';
import { cp, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deliverySkip, dependencySkip, inside, install, json, nodeCommand, removeOwned, verifyFiles, writeJson } from './materials.js';

export async function prepareRelease(root) {
  root = await realpath(root);
  const manifest = await json(path.join(root, 'release.json'));
  await verifyFiles(root, manifest.files, { skip: deliverySkip });
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error('Installation work directory is redirected.');
  const work = path.join(parent, 'release-install-' + randomUUID()); await mkdir(work);
  try {
    const cache = path.join(work, 'cache'); await cp(path.join(root, 'dependency-cache'), cache, { recursive: true });
    const npm = await install(root, cache, path.join(work, 'config'), true);
    await verifyFiles(root, manifest.installedFiles, { prefix: 'node_modules', skip: dependencySkip });
    await verifyFiles(root, manifest.files, { skip: deliverySkip });
    const smoke = JSON.parse(await nodeCommand([path.join(root, 'tools/release/prepare.js'), '--smoke'], { cwd: root }));
    return { candidate: manifest.candidate, node: process.version, npm, platform: process.platform, architecture: process.arch, smoke };
  } finally { await removeOwned(parent, work); }
}

async function smokeRuntime(root) {
  const pkg = await json(path.join(root, 'package.json')), dependencies = [];
  for (const name of Object.keys(pkg.dependencies)) {
    const resolved = fileURLToPath(import.meta.resolve(name)); inside(root, await realpath(resolved));
    await import(name); dependencies.push(name);
  }
  const sdk = await json(path.join(root, 'packages/plugin-sdk/package.json'));
  for (const name of Object.keys(sdk.exports)) {
    const specifier = sdk.name + name.slice(1);
    inside(root, await realpath(fileURLToPath(import.meta.resolve(specifier)))); await import(specifier);
  }
  const plugins = [];
  for (const dependency of Object.values((await json(path.join(root, 'package-lock.json'))).packages)) {
    if (!dependency.link || !dependency.resolved.startsWith('plugins/')) continue;
    const directory = path.join(root, dependency.resolved), plugin = await json(path.join(directory, 'package.json'));
    const module = await import(pathToFileURL(path.join(directory, plugin.mediamanager.entry)));
    assert.equal(typeof module.activate, 'function'); plugins.push(plugin.mediamanager.id);
  }
  // Exercise the actual prebuilt native bindings after --ignore-scripts.
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#123456' } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 1);
  const { createCanvas } = await import('@napi-rs/canvas'); assert.ok(createCanvas(1, 1).toBuffer('image/png').length);
  assert.equal(typeof (await import('koffi')).default.load, 'function');
  await import(pathToFileURL(path.join(root, 'src/main.js')));
  for (const filename of ['import-jellyfin.js', 'export-jellyfin.js']) {
    assert.match(await nodeCommand([path.join(root, 'tools/database', filename), '--help'], { cwd: root }), /Usage:/u);
  }
  assert.match(await nodeCommand([path.join(root, 'tools/publish-target.js'), '--help'], { cwd: root }), /Usage:/u);
  // Resolve validate-reference's runtime imports before its documented argument guard.
  await assert.rejects(nodeCommand([path.join(root, 'tools/database/validate-reference.js')], { cwd: root }),
    error => error.message.includes('SOURCE_SQLITE NEW_EVIDENCE_DIRECTORY'));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MEDIAMANAGER_')));
  await assert.rejects(nodeCommand([path.join(root, 'src/main.js')], { cwd: root, env: environment }),
    error => error.message.includes('MEDIAMANAGER_POSTGRES is required'));
  return { dependencies, sdkExports: Object.keys(sdk.exports), plugins,
    nativeImageBindings: true, bootstrapConfigurationGuard: true, databaseCliHelp: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (process.argv.length === 3 && process.argv[2] === '--smoke') console.log(JSON.stringify(await smokeRuntime(root)));
  else if (process.argv.length <= 3) {
    const receipt = await prepareRelease(root);
    if (process.argv[2]) {
      const filename = path.resolve(process.argv[2]); inside(path.join(root, '.test-output'), filename);
      if (path.dirname(filename) !== path.join(root, '.test-output')) throw new Error('Receipt must be a new direct child of .test-output.');
      await writeJson(filename, receipt);
    }
    else console.log(JSON.stringify(receipt, null, 2));
  } else throw new Error('Usage: node tools/release/prepare.js [NEW_RECEIPT_PATH]');
}
