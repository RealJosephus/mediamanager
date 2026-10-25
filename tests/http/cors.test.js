import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTestApplication } from '../helpers/application.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

test('HTTP CORS matches the supplied native policy and middleware before authentication', async t => {
  const inputFile = new URL('./fixtures/cors/input.json', import.meta.url);
  const bytes = await readFile(inputFile), inputs = JSON.parse(bytes);
  const output = path.join(validationOutputRoot(), 'http-cors-' + randomUUID());
  const receipt = await recordOracle({ project: 'tests/http/fixtures/cors/Oracle.csproj', output,
    args: [fileURLToPath(inputFile), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(output, 'native.json')));
  assert.equal(receipt.passed, true); assert.equal(native.actualExecution, true);
  assert.equal(native.inputSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(native.assemblies.find(value => value.name === 'jellyfin').sha256, receipt.jellyfinDll.sha256);
  const configuration = { IsStartupWizardCompleted: true };
  let authentications = 0;
  const application = await createTestApplication({ configuration, baseUrl: '/media', tasks: { list: () => [] },
    // The oracle mounts the CORS branch directly, without network redirection.
    getNetworkConfiguration: () => ({ BaseUrl: '' }),
    authentication: {
      async authenticate() { authentications++; return { IsAuthenticated: false }; },
      authorize() { throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
    } });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const origin = `http://127.0.0.1:${application.server.address().port}`, actual = [];
  for (const row of inputs) {
    configuration.CorsHosts = row.hosts ?? ['*'];
    const before = authentications;
    const response = await fetch(origin + row.path, { method: row.method, headers: row.headers });
    await response.arrayBuffer();
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('access-control-') || name === 'vary'));
    actual.push({ name: row.name, status: response.status, headers });
    if (row.method === 'OPTIONS') assert.equal(authentications, before, row.name);
  }
  await writeFile(path.join(output, 'candidate.json'), JSON.stringify(actual, null, 2) + '\n');
  // Compare header token lists without treating optional comma whitespace as a
  // protocol difference. Origin and credentials remain exact opaque values.
  const project = rows => rows.map(row => ({ ...row, headers: Object.fromEntries(Object.entries(row.headers).map(([name, value]) =>
    [name, ['access-control-allow-methods', 'access-control-allow-headers', 'vary'].includes(name)
      ? value.split(',').map(value => value.trim()) : value])) }));
  assert.deepEqual(project(actual), project(native.results));
});
