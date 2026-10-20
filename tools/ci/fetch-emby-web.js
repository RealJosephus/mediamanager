import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const version = '26.0.37';
const origin = 'https://app.emby.media/';
const entryPin = '1837ef206fe9bae76e50953ef3ebb26925fd5d5e177e38d665658067aaf778c1';
const workerPin = 'c5006626c1c01f414d20f185fde26867f2480f2f1610c9b969fe998ad5945f57';
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Hosted Emby inputs must be frozen in GitHub Actions.');
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV);
const output = path.join(process.env.RUNNER_TEMP, 'mediamanager-emby-web');
const runtime = path.join(output, 'runtime');
const external = path.join(output, 'external');
const receipts = path.join(output, 'receipts');
await mkdir(output); // Never replace a previously captured input.
await mkdir(runtime);
await mkdir(external);
await mkdir(receipts);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const files = new Map();
const receipt = { schemaVersion: 1, kind: 'emby-web', status: 'started', version, origin,
  repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  started: new Date().toISOString(), clientInteractionValidated: false,
  provenance: 'Unmodified public hosted client resources, downloaded for isolated interoperability testing.',
  distribution: 'Client resources are not included in repository or published CI artifacts.' };
const member = relative => {
  assert.equal(typeof relative, 'string');
  assert.ok(relative && !/[:\\?#%\r\n\0]/u.test(relative)
    && !relative.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid hosted client resource path.');
  return path.join(runtime, relative);
};
async function download(relative) {
  const url = new URL(relative, origin);
  url.searchParams.set('v', version);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert.equal(response.status, 200, `Cannot download hosted client resource: ${relative}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length <= 64 * 1024 * 1024, `Hosted client resource exceeds the size limit: ${relative}`);
  return { bytes, url: url.href, contentType: response.headers.get('content-type') };
}
async function capture(relative, declaredMd5 = null) {
  if (files.has(relative)) return readFile(member(relative));
  const filename = member(relative);
  const downloaded = await download(relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, downloaded.bytes, { flag: 'wx' });
  files.set(relative, { path: relative, url: downloaded.url, contentType: downloaded.contentType,
    bytes: downloaded.bytes.length, sha256: hash(downloaded.bytes),
    ...(declaredMd5 ? { declaredMd5, actualMd5: hash(downloaded.bytes, 'md5') } : {}) });
  return downloaded.bytes;
}
try {
  const builderPath = fileURLToPath(import.meta.url), builder = await readFile(builderPath);
  receipt.builder = { path: builderPath, bytes: builder.length, sha256: hash(builder) };
  const entry = await capture('index.html'), worker = await capture('serviceworker.js');
  assert.equal(hash(entry), entryPin, 'The designated hosted client entry changed.');
  assert.equal(hash(worker), workerPin, 'The designated hosted client catalog changed.');
  assert.ok(entry.toString('utf8').includes(`data-appversion="${version}"`));
  let catalog;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === 'precacheConfig') {
      assert.equal(catalog, undefined, 'The worker declares multiple precache catalogs.');
      assert.equal(node.init?.type, 'ArrayExpression');
      catalog = node.init.elements.map(pair => {
        assert.equal(pair?.type, 'ArrayExpression');
        assert.equal(pair.elements.length, 2);
        return pair.elements.map(value => { assert.equal(value?.type, 'Literal'); return value.value; });
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(worker.toString('utf8'), { ecmaVersion: 'latest' }));
  assert.equal(catalog?.length, 858, 'The designated hosted resource catalog changed.');
  assert.equal(new Set(catalog.map(([relative]) => relative)).size, catalog.length);
  for (const [relative, md5] of catalog) {
    member(relative);
    assert.match(md5, /^[a-f0-9]{32}$/u);
    const existing = files.get(relative);
    if (existing) Object.assign(existing, { declaredMd5: md5,
      actualMd5: hash(await readFile(member(relative)), 'md5') });
  }
  const queue = catalog.filter(([relative]) => !files.has(relative));
  // Limit simultaneous public-source requests. No downloaded script is executed.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) { const [relative, md5] = queue.shift(); await capture(relative, md5); }
  }));
  // app.js loads these browser plugins at startup although the published
  // service-worker catalog omits them. Their player implementations are lazy.
  const bootstrapModules = ['modules/ebookplayer/plugin.js', 'modules/pdfplayer/plugin.js'];
  for (const relative of bootstrapModules) await capture(relative);
  receipt.bootstrapModules = { source: 'app.js', resources: bootstrapModules };
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await capture('manifest.json')));
  const linked = [...entry.toString('utf8').matchAll(/<link\b[^>]*\bhref="([^"]+)"/giu)].map(match => match[1]);
  for (const icon of manifest.icons ?? []) linked.push(icon.src);
  for (const relative of new Set(linked)) {
    if (/^[a-z]+:|^\/\//iu.test(relative)) continue;
    await capture(relative.replace(/^\.\//u, ''));
  }
  // The unmodified Chrome client also loads the public Cast sender. Freeze its
  // original responses and require the browser's real network bytes to match;
  // no request interception or substituted client response is used.
  receipt.externalResources = [];
  for (const [index, url] of [
    'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js',
    'http://www.gstatic.com/eureka/clank/156/cast_sender.js',
  ].entries()) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, `Cannot capture external client script: ${url}`);
    assert.equal(new URL(response.url).hostname, 'www.gstatic.com');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= 8 * 1024 * 1024);
    const relative = `external/${index}.js`;
    await writeFile(path.join(output, relative), bytes, { flag: 'wx' });
    receipt.externalResources.push({ path: relative, url, resolvedUrl: response.url,
      bytes: bytes.length, sha256: hash(bytes), contentType: response.headers.get('content-type') });
  }
  assert.equal(hash((await download('index.html')).bytes), entryPin, 'The hosted entry changed during capture.');
  assert.equal(hash((await download('serviceworker.js')).bytes), workerPin, 'The hosted catalog changed during capture.');
  const runtimeManifest = { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  const manifestBytes = Buffer.from(JSON.stringify(runtimeManifest, null, 2) + '\n');
  await writeFile(path.join(receipts, 'runtime-manifest.json'), manifestBytes, { flag: 'wx' });
  Object.assign(receipt, { status: 'succeeded', catalogEntries: catalog.length, entryAndCatalogUnchanged: true,
    runtimeManifest: { path: 'receipts/runtime-manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) },
    declaredChecksumDifferences: runtimeManifest.files.filter(file => file.declaredMd5 && file.declaredMd5 !== file.actualMd5)
      .map(file => ({ path: file.path, declaredMd5: file.declaredMd5, actualMd5: file.actualMd5 })),
    checksumMeaning: 'Worker checksums are retained as published metadata; actual SHA-256 binds served bytes, including hosted entry substitutions.' });
  await appendFile(process.env.GITHUB_ENV, `MEDIAMANAGER_EMBY_WEB_ROOT=${runtime}\nMEDIAMANAGER_EMBY_WEB_INPUT_ROOT=${output}\n`);
} catch (error) {
  Object.assign(receipt, { status: 'failed', failure: { name: error.name, message: error.message } });
  throw error;
} finally {
  receipt.finished = new Date().toISOString();
  await writeFile(path.join(receipts, 'input-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
}
