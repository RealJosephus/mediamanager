import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/http/application.js';

test('HTTP JSON selects one Accept offer for both its DTO names and content type', async t => {
  const userId = 'a'.repeat(32);
  const result = { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: true },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, UserId: userId }), authorize() {} },
    users: { getUser: async id => { assert.equal(id, userId); return { Id: id }; } },
    library: { getViews: async (_input, { user }) => { assert.equal(user.Id, userId); return result; } }
  });
  t.after(() => new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())));
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  // The first offer is the exact header sent by the designated Web SDK.
  const sdkAccept = 'application/json,application/json; profile=CamelCase,application/json; profile=PascalCase,text/html';
  const cases = [
    { accept: sdkAccept },
    { accept: sdkAccept, route: `/Users/${userId}/Views` },
    { accept: 'application/json; profile="CamelCase"', profile: 'CamelCase' },
    { accept: 'application/json; profile=PascalCase', profile: 'PascalCase' },
    { accept: 'application/json; profile=CamelCase;q=0.2,application/json;q=0.9' },
    { accept: 'application/json;q=0.2,application/json; profile=CamelCase;q=0.9', profile: 'CamelCase' },
    { accept: 'application/json; profile=PascalCase,application/json; profile=CamelCase', profile: 'PascalCase' },
    { accept: 'application/json;profile=CamelCase,application/json;profile=PascalCase', profile: 'CamelCase' },
    { accept: 'application/*,application/json;profile=CamelCase' },
    { accept: 'application/json;q=1;profile=CamelCase' },
    { accept: 'text/html;profile=CamelCase' }
  ];
  for (const { accept, profile, route = `/UserViews?userId=${userId}` } of cases) {
    const response = await fetch(origin + route, { headers: { Accept: accept } });
    assert.equal(response.status, 200, accept);
    assert.equal(response.headers.get('content-type'), 'application/json'
      + (profile ? `; profile="${profile}"` : '') + '; charset=utf-8', accept);
    assert.deepEqual(await response.json(), profile === 'CamelCase'
      ? { items: [], totalRecordCount: 0, startIndex: 0 } : result, accept);
  }
});
