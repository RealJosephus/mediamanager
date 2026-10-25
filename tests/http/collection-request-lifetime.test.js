import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApplication } from '../helpers/application.js';

test('Collection HTTP keeps its request context through DTO projection and closes new admission before draining', async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const actions = [];
  const application = await createTestApplication({
    configuration: { IsStartupWizardCompleted: true },
    authentication: { authenticate: async () => ({}), authorize() {} },
    runWithContext: async operation => {
      actions.push('scope-start');
      try { return await operation(); } finally { actions.push('scope-dispose'); }
    },
    collections: { withCreatedItem: async (_options, consume) => {
      actions.push('owner-acquire');
      try { return await consume({ Id: '11111111-1111-1111-1111-111111111111' }); }
      finally { actions.push('owner-release'); }
    } },
    library: { getItemDto: async item => {
      actions.push('dto-start'); entered.resolve(); await resume.promise;
      actions.push('dto-finish'); return { Id: item.Id };
    } },
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { resume.resolve(); application.beginClose(); await application.drainRequests();
    await new Promise(resolve => application.server.close(resolve)); });
  const address = `http://127.0.0.1:${application.server.address().port}/Collections?name=Lifetime`;
  const request = fetch(address, { method: 'POST' });
  await entered.promise;
  application.beginClose();
  let drained = false;
  const drain = application.drainRequests().then(() => { drained = true; });
  assert.equal((await fetch(address, { method: 'POST' })).status, 503);
  assert.equal(drained, false);
  assert.deepEqual(actions, ['scope-start', 'owner-acquire', 'dto-start']);
  resume.resolve();
  assert.equal((await request).status, 200);
  await drain;
  assert.deepEqual(actions, ['scope-start', 'owner-acquire', 'dto-start', 'dto-finish', 'owner-release', 'scope-dispose']);
});
