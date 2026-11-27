import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { applyProbeMetadata } from '../../src/storage/probe-metadata.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

test('a remux in 2024 does not date a 1999 film to 2024 during the standard video metadata refresh', () => {
  const item = applyNativeItemValues(newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie'), {
    Name:'1999 film', MediaType:'Video', ProductionYear:1999, PremiereDate:null, IsLocked:false, LockedFields:[], ProviderIds:{},
  });
  const probe = normalizeProbe({format:{duration:'1',format_name:'matroska',tags:{creation_time:'2024-04-15T10:10:00Z'}},
    streams:[{index:0,codec_type:'video',codec_name:'h264'}]}, {isAudio:false});
  const updated = applyProbeMetadata({item,context:{people:[]},libraryOptions:defaultLibraryOptions()},probe).Item;
  assert.deepEqual([updated.ProductionYear, updated.PremiereDate ?? null],[1999,null]);
});

test('a real release date takes precedence and a consistent mux date can date home video', () => {
  const mux = '2024-04-15T10:10:00Z';
  for (const [knownYear, tags, expectedYear, expectedDate] of [
    [null, { creation_time: mux }, 2024, '2024-04-15'],
    [2024, { creation_time: mux }, 2024, '2024-04-15'],
    [1999, { originaldate: '1999-05-01', creation_time: mux }, 1999, '1999-05-01'],
  ]) {
    const item = applyNativeItemValues(newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie'), {
      MediaType: 'Video', ProductionYear: knownYear, LockedFields: [], ProviderIds: {},
    });
    const probe = normalizeProbe({ format: { tags }, streams: [] }, { isAudio: false });
    const updated = applyProbeMetadata({ item, context: { people: [] }, libraryOptions: defaultLibraryOptions() }, probe).Item;
    assert.equal(updated.ProductionYear, expectedYear);
    assert.equal(updated.PremiereDate.slice(0, 10), expectedDate);
  }
});
