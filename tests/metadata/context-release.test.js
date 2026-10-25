import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { setupChildrenFixture } from './children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['postgres'];

const ownerId = '51be0000-0000-0000-0000-000000000001';
const firstId = '51be0000-0000-0000-0000-000000000002';
const lastId = '51be0000-0000-0000-0000-000000000003';
const missingId = '51be0000-0000-0000-0000-000000000004';
const options = { timeout: 60000 };

function failureValue(error) {
  if (error == null || typeof error !== 'object') return error;
  return Object.fromEntries(['message', 'code', 'status', 'statusCode', 'httpStatus', 'cause', 'errors']
    .filter(key => key in error).map(key => [key, key === 'errors' ? error.errors.map(failureValue)
      : key === 'cause' ? failureValue(error.cause) : error[key]]));
}

const aggregateValue = (primary, errors) => ({ message: primary.message, cause: failureValue(primary),
  errors: errors.map(failureValue) });

async function deadline(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Metadata context release did not settle.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

async function setup(t, extra = {}) {
  const fixture = await setupChildrenFixture(t);
  await fixture.seed({ target: 'owner', items: [
    { key: 'owner', type: 'Movie', Id: ownerId, Path: 'Z:\\ChildrenMetadata\\owner.mkv', Name: 'Owner' },
    { key: 'first', type: 'Video', Id: firstId, OwnerId: ownerId,
      Path: 'Z:\\ChildrenMetadata\\first.mkv', Name: 'First part' },
    { key: 'last', type: 'Video', Id: lastId, OwnerId: ownerId,
      Path: 'Z:\\ChildrenMetadata\\last.mkv', Name: 'Last part' },
  ] });
  const loadContext = createMetadataContextLoader({ ...fixture, fileSystem: testFileSystem, ...extra });
  return { ...fixture, loadContext };
}

test('postgres: concurrent context disposal and its scope await the actual state release', options, async t => {
  const fixture = await setup(t);
  const before = await fixture.database.rows('BaseItems');
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  const load = fixture.library.load.bind(fixture.library);
  fixture.library.load = async (...args) => {
    const state = await load(...args), dispose = state.dispose.bind(state);
    state.dispose = async settings => { started.resolve(); await gate.promise; await dispose(settings); };
    return state;
  };
  let first, second, secondSettled = false, scopeSettled = false;
  const work = fixture.loadContext.withScope(async () => {
    const loaded = await fixture.loadContext(ownerId);
    first = loaded.dispose();
    second = loaded.dispose();
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  });
  void work.then(() => { scopeSettled = true; }, () => { scopeSettled = true; });
  try {
    await deadline(started.promise);
    await setImmediate();
    assert.equal(secondSettled, false, 'A second disposer must await the active release.');
    assert.equal(scopeSettled, false, 'The scope must retain a context until its release has finished.');
    gate.resolve();
    await deadline(Promise.all([work, first, second]));
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  } finally {
    gate.resolve();
    fixture.library.load = load;
    await Promise.allSettled([work, first, second]);
  }
});

test('postgres: context cleanup attempts both state and relation release and retains both failures', options, async t => {
  const fixture = await setup(t);
  const before = await fixture.database.rows('BaseItems');
  const stateFailure = Object.assign(new Error('Controlled state release failure'), { code: 'state-release', status: 503 });
  const relationFailure = Object.assign(new Error('Controlled relation release failure', {
    cause: Object.assign(new Error('Connection closed during release'), { code: 'ECONNRESET' }),
  }), { code: 'relation-release', status: 503 });
  const load = fixture.library.load.bind(fixture.library);
  const flush = fixture.linkedChildren.flushReleases.bind(fixture.linkedChildren);
  let releasedState = false;
  fixture.library.load = async (...args) => {
    const state = await load(...args), dispose = state.dispose.bind(state);
    state.dispose = async settings => { await dispose(settings); releasedState = true; throw stateFailure; };
    return state;
  };
  fixture.linkedChildren.flushReleases = async settings => {
    await flush(settings);
    if (releasedState) throw relationFailure;
  };
  const loaded = await fixture.loadContext(ownerId);
  try {
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(loaded.dispose(), error => {
      assert.deepEqual(failureValue(error), aggregateValue(stateFailure, [stateFailure, relationFailure]));
      return true;
    });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  } finally {
    fixture.library.load = load;
    fixture.linkedChildren.flushReleases = flush;
  }
  await fixture.loadContext.withContext(ownerId, {}, current => assert.equal(current.item.Name, 'Owner'));
});

for (const boundary of ['consumer', 'scope', 'load']) test(`postgres: ${boundary} failure survives metadata cleanup failure`, options, async t => {
  const primary = Object.assign(new Error('Controlled metadata operation failure', {
    cause: Object.assign(new Error('Controlled upstream failure'), { code: 'ECONNRESET' }),
  }), { code: 'metadata-operation', status: 502 });
  const cleanup = Object.assign(new Error('Controlled state cleanup failure'), { code: 'state-cleanup', status: 503 });
  const fixture = await setup(t, boundary === 'load' ? {
    contextExtensions: () => [{ enrich() { throw primary; } }],
  } : {});
  const before = await fixture.database.rows('BaseItems');
  const load = fixture.library.load.bind(fixture.library);
  fixture.library.load = async (...args) => {
    const state = await load(...args), dispose = state.dispose.bind(state);
    state.dispose = async settings => { await dispose(settings); throw cleanup; };
    return state;
  };
  try {
    const work = boundary === 'load' ? fixture.loadContext(ownerId)
      : boundary === 'scope' ? fixture.loadContext.withScope(async () => {
        await fixture.loadContext(ownerId); throw primary;
      }) : fixture.loadContext.withContext(ownerId, {}, () => { throw primary; });
    await assert.rejects(work, error => {
      assert.deepEqual(failureValue(error), aggregateValue(primary, [primary, cleanup]));
      return true;
    });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  } finally { fixture.library.load = load; }
});

test('postgres: partial metadata previews drain every successful context before preserving load and cleanup failures', options, async t => {
  const fixture = await setup(t);
  const parent = await fixture.loadContext(ownerId);
  const before = await fixture.database.rows('BaseItems');
  const primary = Object.assign(new Error('Controlled preview load failure'), { code: 'preview-load', status: 404 });
  const cleanup = Object.assign(new Error('Controlled preview cleanup failure'), { code: 'preview-cleanup', status: 503 });
  const lastReleasing = Promise.withResolvers(), gate = Promise.withResolvers();
  parent.videoVersionDiscovery.previewOwnedParts = async () => [firstId, missingId, lastId].map(Id => ({ Id }));
  parent.loadDraftContext = draft => {
    if (draft.Id === missingId) throw primary;
    return fixture.loadContext(draft.Id).then(child => {
      const dispose = child.dispose.bind(child);
      child.dispose = async () => {
        if (draft.Id === lastId) { lastReleasing.resolve(); await gate.promise; }
        await dispose();
        if (draft.Id === firstId) throw cleanup;
      };
      return child;
    });
  };
  let settled = false;
  const work = parent.previewOwnedPartContexts();
  void work.then(() => { settled = true; }, () => { settled = true; });
  try {
    await deadline(lastReleasing.promise);
    await setImmediate();
    assert.equal(settled, false, 'A failed preview must await the remaining successful context releases.');
    gate.resolve();
    await assert.rejects(deadline(work), error => {
      assert.deepEqual(failureValue(error), aggregateValue(primary, [primary, cleanup]));
      return true;
    });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  } finally {
    gate.resolve();
    await Promise.allSettled([work, parent.dispose()]);
  }
});
