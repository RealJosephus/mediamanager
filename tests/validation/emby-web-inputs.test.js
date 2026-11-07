import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureHostedEmbyWeb } from '../../tools/ci/fetch-emby-web.js';
import { embyWebInputs } from '../../tools/validation/emby-web-inputs.js';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-hosted-emby-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'mediamanager-emby-web');
  const environment = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: temporary, GITHUB_ENV: path.join(temporary, 'env'),
    GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'candidate', GITHUB_RUN_ID: 'job', GITHUB_RUN_ATTEMPT: '1',
    MEDIAMANAGER_EMBY_WEB_INPUT_ROOT: output, MEDIAMANAGER_EMBY_WEB_ROOT: path.join(output, 'runtime') };
  const receipt = path.join(output, 'receipts', 'input-receipt.json');
  return { environment, receipt };
}

function publication(version, extra = false) {
  const catalog = new Map([['app.js', extra ? "const plugins = ['./modules/reader/plugin.js'];" : 'const plugins = [];']]);
  if (extra) catalog.set('chunks/latest.js', 'const latest = true;');
  const checksums = [...catalog].map(([name, content]) => [name, createHash('md5').update(content).digest('hex')]);
  return new Map([...catalog,
    ['index.html', `<link rel='manifest' href='ui/client.webmanifest'><script data-appversion="${version}" src="bootstrap.js?v=${version}"></script>`],
    ['serviceworker.js', `const precacheConfig = ${JSON.stringify(checksums)};`],
    ['bootstrap.js', 'const boot = true;'],
    ['ui/client.webmanifest', '{"icons":[{"src":"icon.png"}]}'],
    ['ui/icon.png', 'icon'],
    ['modules/reader/plugin.js', 'const plugin = true;'],
  ]);
}

function hostedRequest(assets, replace = () => undefined) {
  const requests = [];
  const request = async (input, options) => {
    const url = new URL(input);
    requests.push(url.href);
    if (url.hostname === 'www.gstatic.com') {
      const response = new Response('Cast');
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    }
    assert.equal(url.origin, 'https://app.emby.media');
    assert.equal(options.cache, 'no-store');
    const name = url.pathname.slice(1), count = requests.filter(item => item === url.href).length;
    const body = replace(name, count) ?? assets.get(name);
    assert.notEqual(body, undefined, `Unexpected request: ${url.href}`);
    return new Response(body);
  };
  return { request, requests };
}

test('hosted Emby captures the current entry, catalog and linked resources on each run', async t => {
  for (const [version, extra] of [['27.1.0', false], ['28.0.5', true]]) {
    const { environment, receipt } = await fixture(t);
    const { request, requests } = hostedRequest(publication(version, extra));
    await captureHostedEmbyWeb(environment, request);
    const supplied = await embyWebInputs(environment);
    assert.equal(supplied.receipt.version, version);
    assert.equal(supplied.receipt.catalogEntries, extra ? 2 : 1);
    assert.deepEqual(supplied.receipt.bootstrapModules.resources, extra ? ['modules/reader/plugin.js'] : []);
    const declarations = await readFile(environment.GITHUB_ENV, 'utf8');
    assert.equal(declarations, `MEDIAMANAGER_EMBY_WEB_ROOT=${supplied.runtime}\nMEDIAMANAGER_EMBY_WEB_INPUT_ROOT=${supplied.root}\n`);
    assert.ok(requests.includes(`https://app.emby.media/bootstrap.js?v=${version}`));
    assert.ok(requests.includes('https://app.emby.media/ui/icon.png'));
    assert.equal(requests.includes('https://app.emby.media/modules/reader/plugin.js'), extra);
    assert.deepEqual(requests.filter(url => /\/(?:index\.html|serviceworker\.js)(?:$|\?)/u.test(url)),
      ['index.html', 'serviceworker.js', 'index.html', 'serviceworker.js'].map(name => `https://app.emby.media/${name}`));

    await writeFile(receipt, JSON.stringify({ ...supplied.receipt, version: 'different' }));
    await assert.rejects(embyWebInputs(environment), /captured Emby Web version differs/u);
  }
});

test('hosted Emby rejects entry or worker changes before publishing the inputs', async t => {
  const assets = publication('29.0.0');
  for (const changed of ['index.html', 'serviceworker.js']) {
    const { environment, receipt } = await fixture(t);
    const { request } = hostedRequest(assets, (name, count) => name === changed && count === 2 ? assets.get(name) + '\n' : undefined);
    await assert.rejects(captureHostedEmbyWeb(environment, request), new RegExp(`${changed} changed during capture`, 'u'));
    await assert.rejects(readFile(environment.GITHUB_ENV), { code: 'ENOENT' });
    const report = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.version, '29.0.0');
  }
});
