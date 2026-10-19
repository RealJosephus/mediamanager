import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { CollectionService } from '../../src/library/collection-service.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore, emptyLinkedChildrenPlan } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, acquireNativeItemLinkOwner, publishNativeItemLinks } from '../../src/library/native-item-entity.js';
import { serializeLocalXml } from '../../src/metadata/local-xml.js';
import { idKey } from '../../src/library/records.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { updateMetadataFromChildren } from '../../src/metadata/children-metadata.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
const collectionId = 'cf100000-0000-0000-0000-000000999999';
const childId = index => 'cf100000-0000-0000-0000-' + String(index + 1).padStart(12, '0');
export async function verifyChildMetadataRatingConsumer(t, samples, nativePair) {
  const database = await createPostgresTestDatabase(null, 'child_rating'), store = new DomainStore(database);
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  t.after(async () => {
    await linkedChildren.flushReleases(); await linkedChildren.close();
    await dropPostgresTestDatabase(database); await store.close();
  });
  await linkedChildren.initialize();
  for (const sample of samples) {
    const item = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.BoxSet'), {
      Id: collectionId, Name: sample.Name, OfficialRating: 'Original', MetadataCountryCode: sample.Country,
    });
    const owner = acquireNativeItemLinkOwner(item);
    const cohort = await createNativeItemCohort({ linkedChildren });
    const sequence = metadataChildSequence(cohort, linkedChildren, store);
    try {
      for (const [index, OfficialRating] of sample.Ratings.entries()) {
        const child = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie'), {
          Id: childId(index), OfficialRating,
        });
        const childOwner = acquireNativeItemLinkOwner(child);
        try { await cohort.capture(child, { ordinal: BigInt(index + 1) }); }
        finally { childOwner.release(); await linkedChildren.flushReleases(); }
      }
      await updateMetadataFromChildren(item, sequence, true, 0, { defaultCountry: 'US' });
      assert.equal(item.OfficialRating, nativePair(sample).OfficialRating, sample.Name);
    } finally {
      await sequence.close(); owner.release(); await linkedChildren.flushReleases();
    }
  }
}
export async function verifyCollectionRatingConsumer(t, samples, nativePair) {
  const database = await createPostgresTestDatabase(null, 'collection_rating'), store = new DomainStore(database);
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  const owners = new Set();
  await fs.mkdir(validationOutputRoot(), { recursive: true });
  const root = await fs.mkdtemp(path.join(validationOutputRoot(), 'rating-xml-'));
  t.after(async () => {
    for (const owner of owners) owner.release();
    await linkedChildren.flushReleases(); await linkedChildren.close();
    await dropPostgresTestDatabase(database); await store.close(); await fs.rm(root, { recursive: true, force: true });
  });
  await linkedChildren.initialize();
  for (const sample of samples) {
    await database.client.query('DELETE FROM "BaseItems"');
    const collection = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.BoxSet');
    Object.assign(collection, { Id: collectionId, Name: sample.Name, OfficialRating: 'Original', MetadataCountryCode: sample.Country });
    const owner = acquireNativeItemLinkOwner(collection); owners.add(owner);
    const children = sample.Ratings.map((OfficialRating, index) => Object.assign(
      newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie'), { Id: childId(index), Name: 'Child ' + index, OfficialRating }));
    const byId = new Map([collection, ...children].map(item => [idKey(item.Id), item]));
    for (const item of byId.values()) await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: item.Id, Type: item.NativeType, Name: item.Name, OfficialRating: item.OfficialRating,
      IsFolder: item.IsFolder, IsMovie: item.Type === 'Movie', MediaType: item.Type === 'Movie' ? 'Video' : null,
      Data: '{}', DateCreated: '2026-10-14 00:00:00.0000000', DateModified: '2026-10-14 00:00:00.0000000',
    }));
    await store.run(async session => publishNativeItemLinks(collection, await linkedChildren.createFromSession({
      session, parentId: collection.Id, loaded: true, plan: emptyLinkedChildrenPlan(),
    })));
    const itemCreation = { linkedChildren, retainItem: acquireNativeItemLinkOwner,
      async withItem(id, operation) {
        const item = byId.get(idKey(id)) ?? null, owner = item ? this.retainItem(item) : null;
        try { return await operation(item); } finally { owner?.release(); await linkedChildren.flushReleases(); }
      } };
    const loadContext = async () => ({ item: collection });
    loadContext.withContext = async (_id, _options, operation) => operation(await loadContext());
    const commits = [], queues = [], events = [];
    const manager = new CollectionService({fileSystem: testFileSystem,  store, linkedChildren, itemCreation, loadContext, updates: {},
      library: { options: { configuration: { MetadataCountryCode: 'US' } } },
      metadata: { queue: (...args) => queues.push(args) }, host: { getCachedChildrenPage() {} },
      libraryConfiguration: { admitCollectionOperation: () => ({ release() {} }) },
      programDataPath: root, dataPath: root, updateRepository: async item => commits.push(item.OfficialRating) });
    manager.on('ItemsAddedToCollection', event => events.push({ OfficialRating: event.Collection.OfficialRating, Count: Number(event.Items.count) }));
    try { await manager.add(collection.Id, children.map(item => item.Id)); }
    finally { await manager.close(); }
    const expected = nativePair(sample).OfficialRating, changed = children.length > 0;
    assert.equal(collection.OfficialRating, expected, sample.Name);
    assert.deepEqual(commits, changed ? [expected] : [], sample.Name);
    assert.equal(queues.length, Number(changed), sample.Name);
    assert.deepEqual(events, changed ? [{ OfficialRating: expected, Count: children.length }] : [], sample.Name);
    const context = { linkedChildren, spoolRoot: root, expandPath: value => value, getPeople: async () => [],
      prepareLinkedXmlItems: async item => {
        const snapshot = await linkedChildren.xmlPaths(item.LinkedChildren, { parentId: item.Id });
        return { manualCount: snapshot.manualCount, pages: options => snapshot.paths.pages(options),
          close: () => linkedChildren.release(snapshot.paths) };
      } };
    if (expected.includes('\0')) {
      await assert.rejects(serializeLocalXml(collection, {fileSystem:testFileSystem,...context}), { name: 'XmlError' });
    } else {
      const prepared = await serializeLocalXml(collection, {fileSystem:testFileSystem,...context}), chunks = [];
      try {
        for await (const chunk of prepared.stream()) chunks.push(chunk);
        const xml = Buffer.concat(chunks).toString('utf8');
        assert.equal(/<ContentRating>(.*?)<\/ContentRating>/su.exec(xml)?.[1], expected, sample.Name);
      } finally { await prepared.close(); }
    }
    owner.release(); owners.delete(owner); await linkedChildren.flushReleases();
  }
}
