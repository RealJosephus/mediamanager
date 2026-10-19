import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryService } from '../../src/library/library-service.js';
import { UserViewService } from '../../src/library/user-view-service.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';

test('library closure cancels view refreshes before rejecting their later library dependencies', { timeout: 5000 }, async () => {
  const active = Promise.withResolvers(), refreshEntered = Promise.withResolvers();
  const finishRead = Promise.withResolvers(), finishRefresh = Promise.withResolvers();
  const errors = [], store = {
    run: operation => Promise.resolve().then(() => operation({})),
    enqueue: operation => Promise.resolve().then(() => operation({}))
  };
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'view-close', onError: error => errors.push(error), configuration: { CacheSize: 16 } });
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder'); item.Id = 'eb150000000000000000000000000001';
  const lookup = library.getItemRecord.bind(library);
  library.getItemRecord = (id, options) => id === item.Id ? Promise.resolve(item) : lookup(id, options);
  let refreshSignal, pending;
  const views = new UserViewService({fileSystem: testFileSystem,  library, metadata: { async refresh(id, { signal }) {
    refreshSignal = signal; refreshEntered.resolve(); await finishRefresh.promise; signal.throwIfAborted();
    await library.getItemRecord('eb150000000000000000000000000002');
  } }, images: {}, updates: {} });
  library.userViews = views;
  try {
    pending = library.withItemRecord(item.Id, {}, async () => { active.resolve(); await finishRead.promise; });
    await active.promise;
    views.queueRefresh({ Id: 'eb150000000000000000000000000002' }); await refreshEntered.promise;
    const closing = library.close(), cancelledBeforeRejection = refreshSignal.aborted;
    await assert.rejects(library.getItemRecord('eb150000000000000000000000000003'), { status: 503 });
    finishRefresh.resolve(); await views.drain();
    const observed = { cancelledBeforeRejection,
      errors: errors.map(error => ({ message: error.message, status: error.status, stack: error.stack })) };
    finishRead.resolve(); await pending; await closing;
    assert.equal(cancelledBeforeRejection, true, JSON.stringify(observed));
    assert.deepEqual(errors, []);
  } finally {
    finishRefresh.resolve(); finishRead.resolve();
    await pending?.catch(() => {}); await library.close();
  }
});
