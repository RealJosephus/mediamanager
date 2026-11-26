import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createTestApplication } from '../helpers/application.js';

for (const baseUrl of ['', '/media']) test(`database readiness at ${baseUrl}/health follows connectivity on each request`, async t => {
  let available = true, queries = 0;
  const app = await createTestApplication({
    baseUrl, configuration: {}, authentication: {},
    store: { run: operation => operation({ client: { async query(sql) {
      assert.equal(sql, 'SELECT 1'); queries++;
      if (!available) throw new Error('private database diagnostic');
      return { rowCount: 1 };
    } } }) },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  if (baseUrl) {
    const redirect = await fetch(origin + '/health', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), baseUrl + '/health');
    assert.equal(queries, 0);
  }
  const url = origin + baseUrl + '/health';
  for (available of [true, false, true]) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, available ? 200 : 503);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.match(response.headers.get('cache-control'), /no-store/u);
    assert.equal(await response.text(), available ? 'Healthy' : 'Unhealthy');
  }
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(queries, 4);
});
