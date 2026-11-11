import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

export const hostedEmbyOrigin = 'https://app.emby.media/';
const builderPath = fileURLToPath(import.meta.url);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

export function hostedEmbyVersion(entry) {
  const versions = new Set(Array.from(entry.toString('utf8').matchAll(/\sdata-appversion\s*=\s*(["'])([^"'<>]+)\1/giu),
    match => match[2].trim()));
  assert.ok(versions.size === 1 && !versions.has(''), 'The hosted Emby entry must declare its client version.');
  return versions.values().next().value;
}

export function hostedEmbyCatalog(worker) {
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
  assert.ok(catalog?.length, 'The hosted Emby worker does not declare a resource catalog.');
  assert.equal(new Set(catalog.map(([relative]) => relative)).size, catalog.length, 'The hosted resource catalog lists a path twice.');
  for (const [relative, md5] of catalog) {
    assert.equal(typeof relative, 'string');
    assert.match(md5, /^[a-f0-9]{32}$/iu);
  }
  return catalog;
}

export function hostedEmbyMember(root, relative) {
  assert.ok(typeof relative === 'string' && relative && !/[<>:"\\|?*#%\u0000-\u001f]/u.test(relative)
    && !relative.split('/').some(part => !part || /[ .]$/u.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part)), 'Invalid hosted Emby resource path.');
  return path.join(root, relative);
}

export async function captureHostedEmbyWeb(environment, request = fetch) {
  assert.equal(environment.GITHUB_ACTIONS, 'true', 'Hosted Emby inputs must be frozen in GitHub Actions.');
  assert.ok(environment.RUNNER_TEMP && environment.GITHUB_ENV);
  const output = path.join(environment.RUNNER_TEMP, 'mediamanager-emby-web');
  const runtime = path.join(output, 'runtime');
  const external = path.join(output, 'external');
  const receipts = path.join(output, 'receipts');
  await mkdir(output); // Never replace a previously captured input.
  await mkdir(runtime);
  await mkdir(external);
  await mkdir(receipts);
  const files = new Map(), origin = new URL(hostedEmbyOrigin).origin;
  const receipt = { schemaVersion: 1, kind: 'emby-web', status: 'started', origin: hostedEmbyOrigin,
    repository: environment.GITHUB_REPOSITORY, commit: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT,
    started: new Date().toISOString(), clientInteractionValidated: false,
    provenance: 'Unmodified public hosted client resources, downloaded for isolated interoperability testing.',
    distribution: 'Client resources are not included in repository or published CI artifacts.' };

  async function download(url) {
    const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(60000), redirect: 'error' });
    assert.equal(response.status, 200, `Cannot download hosted client resource: ${url.pathname}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length <= 64 * 1024 * 1024, `Hosted client resource exceeds the size limit: ${url.pathname}`);
    return { bytes, url: url.href, contentType: response.headers.get('content-type') };
  }

  async function capture(relative, declaredMd5 = null, url = new URL(relative, hostedEmbyOrigin)) {
    const filename = hostedEmbyMember(runtime, relative);
    if (files.has(relative)) return readFile(filename);
    const downloaded = await download(url);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, downloaded.bytes, { flag: 'wx' });
    files.set(relative, { path: relative, url: downloaded.url, contentType: downloaded.contentType,
      bytes: downloaded.bytes.length, sha256: hash(downloaded.bytes),
      ...(declaredMd5 ? { declaredMd5, actualMd5: hash(downloaded.bytes, 'md5') } : {}) });
    return downloaded.bytes;
  }

  async function captureLinked(reference, base = hostedEmbyOrigin) {
    const url = new URL(reference, base);
    if (url.origin === origin) return capture(decodeURIComponent(url.pathname.slice(1)) || 'index.html', null, url);
  }

  try {
    const builder = await readFile(builderPath);
    receipt.builder = { path: builderPath, bytes: builder.length, sha256: hash(builder) };
    const entry = await capture('index.html');
    receipt.version = hostedEmbyVersion(entry);
    const worker = await capture('serviceworker.js');
    const catalog = hostedEmbyCatalog(worker);
    receipt.catalogEntries = catalog.length;

    for (const [tag] of entry.toString('utf8').matchAll(/<(?:link|script)\b[^>]*>/giu)) {
      const reference = /\s(?:href|src)\s*=\s*(["'])([^"']+)\1/iu.exec(tag)?.[2];
      if (!reference) continue;
      const bytes = await captureLinked(reference);
      if (bytes && /\srel\s*=\s*(["'])manifest\1/iu.test(tag)) {
        const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        for (const icon of manifest.icons ?? []) await captureLinked(icon.src, new URL(reference, hostedEmbyOrigin));
      }
    }

    for (const [relative, md5] of catalog) {
      const filename = hostedEmbyMember(runtime, relative);
      const existing = files.get(relative);
      if (existing) Object.assign(existing, { declaredMd5: md5, actualMd5: hash(await readFile(filename), 'md5') });
    }
    const queue = catalog.filter(([relative]) => !files.has(relative));
    // Limit simultaneous public-source requests. No downloaded script is executed.
    const downloads = await Promise.allSettled(Array.from({ length: 6 }, async () => {
      while (queue.length) { const [relative, md5] = queue.shift(); await capture(relative, md5); }
    }));
    const failed = downloads.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;

    // The app can load browser plugins at startup that its worker omits.
    if (files.has('app.js')) {
      const app = await readFile(hostedEmbyMember(runtime, 'app.js'), 'utf8');
      const paths = new Set(Array.from(app.matchAll(/(["'])\.\/(modules\/[^"'\\]+\/plugin\.js)\1/gu), match => match[2]));
      const resources = [...paths].filter(relative => !files.has(relative));
      for (const relative of resources) await capture(relative);
      receipt.bootstrapModules = { source: 'app.js', resources };
    }

    // Freeze the Cast scripts used by the fixed Chromium browser. The real
    // browser still makes the external requests and verifies the response bytes.
    receipt.externalResources = [];
    for (const [index, url] of [
      'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js',
      'http://www.gstatic.com/eureka/clank/156/cast_sender.js',
    ].entries()) {
      const response = await request(url, { signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, `Cannot capture external client script: ${url}`);
      assert.equal(new URL(response.url).hostname, 'www.gstatic.com');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length <= 8 * 1024 * 1024);
      const relative = `external/${index}.js`;
      await writeFile(path.join(output, relative), bytes, { flag: 'wx' });
      receipt.externalResources.push({ path: relative, url, resolvedUrl: response.url,
        bytes: bytes.length, sha256: hash(bytes), contentType: response.headers.get('content-type') });
    }

    for (const [relative, bytes] of [['index.html', entry], ['serviceworker.js', worker]]) {
      const current = await download(new URL(relative, hostedEmbyOrigin));
      assert.equal(hash(current.bytes), hash(bytes), `Hosted Emby ${relative} changed during capture. Start a fresh run.`);
    }
    const runtimeManifest = { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
    const manifestBytes = Buffer.from(JSON.stringify(runtimeManifest, null, 2) + '\n');
    await writeFile(path.join(receipts, 'runtime-manifest.json'), manifestBytes, { flag: 'wx' });
    Object.assign(receipt, { status: 'succeeded', entryAndCatalogUnchanged: true,
      runtimeManifest: { path: 'receipts/runtime-manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) },
      declaredChecksumDifferences: runtimeManifest.files.filter(file => file.declaredMd5 && file.declaredMd5.toLowerCase() !== file.actualMd5)
        .map(file => ({ path: file.path, declaredMd5: file.declaredMd5, actualMd5: file.actualMd5 })),
      checksumMeaning: 'Worker checksums are retained as published metadata; actual SHA-256 binds served bytes, including hosted entry substitutions.' });
    await appendFile(environment.GITHUB_ENV, `MEDIAMANAGER_EMBY_WEB_ROOT=${runtime}\nMEDIAMANAGER_EMBY_WEB_INPUT_ROOT=${output}\n`);
  } catch (error) {
    Object.assign(receipt, { status: 'failed', failure: { name: error.name, message: error.message } });
    throw error;
  } finally {
    receipt.finished = new Date().toISOString();
    await writeFile(path.join(receipts, 'input-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === builderPath) {
  await captureHostedEmbyWeb(process.env);
}
