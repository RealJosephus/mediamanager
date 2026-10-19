import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { setupChildrenFixture } from './children-fixture.js';

const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
for (const failCallback of [false, true]) test('postgres: owned ordinal callback '
  + (failCallback ? 'retains its real SQL primary through page release failure' : 'propagates a real page release failure after a successful callback'), options, async t => {
  const fixture = await setupChildrenFixture(t);
  const Id = 'fc1d0000-0000-0000-0000-000000000001';
  await fixture.seed({ target: 'item', items: [{ key: 'item', type: 'Movie', Id,
    Name: 'Owned ordinal item', Path: 'Z:\\ChildSelection\\OrdinalRelease.mkv' }] });
  const loaded = await fixture.loadContext(Id, { includeChildren: false });
  const cohort = await createNativeItemCohort({ linkedChildren: fixture.linkedChildren });
  let sequence, primary, cleanup, released = 0;
  try {
    await cohort.capture(loaded.item, { ordinal: 1n });
    const pageOwner = {
      async page(options) {
        const page = await cohort.page(options);
        return { entries: page.entries, async release() {
          await page.release(); released += 1;
          await fixture.linkedChildren.withSession(async session => {
            try { await session.client.query('SELECT 1 / 0'); }
            catch (error) { cleanup = error; throw error; }
          });
        } };
      },
      count: () => cohort.count(), release: () => cohort.release()
    };
    sequence = metadataChildSequence(pageOwner, fixture.linkedChildren, fixture.store);
    await assert.rejects(sequence.withItemAtOrdinal(1n, async item => {
      assert.equal(item.Id, Id); assert.equal(item.Name, 'Owned ordinal item');
      if (failCallback) await fixture.store.run(async session => {
        try { await session.client.query("SELECT 'invalid-integer'::integer"); }
        catch (error) { primary = error; throw error; }
      });
      return 'Callback completed';
    }), error => {
      assert.equal(released, 1, 'the real typed page released before the secondary SQL fault');
      assert.equal(cleanup?.code, '22012');
      if (failCallback) {
        assert.equal(primary?.code, '22P02'); assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary); assert.deepEqual(error.errors, [primary, cleanup]);
      } else { assert.equal(primary, undefined); assert.equal(error, cleanup); }
      return true;
    });
  } finally {
    try { if (sequence) await sequence.close(); else await cohort.release(); }
    finally { await loaded.dispose(); }
  }
  await fixture.linkedChildren.withSession(async session => {
    for (const table of ['item_states', 'item_cohorts', 'pins']) assert.equal(BigInt((await session.client.query(
      `SELECT count(*) AS count FROM "${fixture.linkedChildren.schemaName}".${table}`)).rows[0].count), 0n, table);
  });
});
