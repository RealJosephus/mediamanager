import { EventEmitter } from 'node:events';
import { ItemUpdateType, saveMetadata, validateMetadataSaves } from './save-manager.js';
import { persistMetadata, persistPeopleCredits, persistImageMetadata, reattachUserData } from './persistence.js';
import { peopleItemTypes } from './item-update.js';
import { PeopleMetadataLifecycleHost } from './people-lifecycle.js';
import { assertVideoRepositoryPath, copyLocalAlternateMetadata, localAlternateVersionIds, loadLocalAlternateContext } from './video-repository.js';
import { invalidateVideoParent } from '../library/video-version-discovery.js';
import { publishNativeImageInfos } from './images.js';

const repositoryAncestors = Symbol('video repository ancestors');

export class MetadataUpdateHost extends EventEmitter {
  constructor({ registry, store, images, library, monitor, logger = { error() {} }, now = () => new Date().toISOString(), reattach = reattachUserData }) {
    super();
    Object.assign(this, { registry, store, images, library, monitor, logger, now, reattach });
  }

  #report(name, event) {
    try { this.emit(name, event); }
    catch (error) { this.logger.error(error, `Error in ${name} event handler`); }
    try {
      const method = { ItemAdded: 'reportItemAdded', ItemUpdated: 'reportItemUpdated', ItemRemoved: 'reportItemRemoved' }[name];
      this.library?.[method]?.(event.Item, event.Parent, event.UpdateReason);
    } catch (error) { this.logger.error(error, `Error forwarding ${name} event`); }
  }

  reportItemAdded(Item, Parent = null) { this.#report('ItemAdded', { Item, Parent }); }
  reportItemUpdated(Item, Parent = null, UpdateReason = ItemUpdateType.None) { this.#report('ItemUpdated', { Item, Parent, UpdateReason }); }
  reportItemRemoved(Item, Parent = null) { this.#report('ItemRemoved', { Item, Parent }); }

  async updatePeople(loaded, people, { signal } = {}) {
    if (!peopleItemTypes.has(loaded.item.Type) || people == null) return;
    const filtered = people.filter(person => person != null);
    // Cancellation is checked by SavePeopleMetadataAsync after credits commit.
    await persistPeopleCredits(this.store, loaded, filtered);
    await new PeopleMetadataLifecycleHost({ store: this.store, loaded, updates: this }).savePeople(filtered, { signal });
    if (loaded.reloadMetadataContext) {const refreshed=await loaded.reloadMetadataContext(loaded.item.Id);
      try {loaded.context.people=refreshed.context.people;} finally {await refreshed.dispose();}}
  }

  /** Validate every metadata saver before the owning lifecycle crosses its
   * first side-effect boundary. Callers that split validation from execution
   * must keep the item type, path and saver configuration stable in between. */
  async preflightMetadataSavers(loaded, updateReason, ancestors = []) {
    await validateMetadataSaves(loaded, updateReason, this.registry, ancestors);
  }

  /** Native RunMetadataSavers: run file savers without a request token, then
   * refresh and persist image rows. This deliberately does not save BaseItems
   * or publish ItemUpdated; those are separate repository responsibilities. */
  async runMetadataSavers(loaded, updateReason, {
    saverOperation = saveMetadata,
    persistImages,
    persistenceContext = loaded
  } = {}) {
    const item = loaded.item, images = loaded.context?.images ?? [];
    const savers = this.registry?.discover({ ...loaded, kind: 'saver' }) ?? [];
    const saves = item.IsFileProtocol ? await saverOperation(item, updateReason, savers,
      { ...loaded, now: this.now, logger: this.logger, monitor: this.monitor }) : [];
    await this.images.updateImages(loaded, images, {
      forceUpdate: updateReason >= ItemUpdateType.ImageUpdate,
      persistImages: values => persistImages ? persistImages(loaded, values) : persistImageMetadata(this.store, persistenceContext, values)
    });
    publishNativeImageInfos(item, images);
    this.library?.itemCreation?.registerItem(item);
    return saves;
  }

  async updateRepository(loaded, result, updateReason, options = {}) {
    const { signal, persist, persistImages, saverOperation = saveMetadata } = options;
    const item = result.Item;
    const context = { ...loaded.context, images: result.Images ?? loaded.context?.images ?? [] };
    const updated = { ...loaded, item, context };
    // ConvertImageToLocal saves each successful conversion/removal with no
    // request token before the outer repository call resumes. Reuse the same
    // committed conflict baseline rather than a stale copied context.
    updated.onImageRemoteChange ??= () => this.update(loaded, { Item: item, Images: context.images }, ItemUpdateType.ImageUpdate,
      { [repositoryAncestors]: options[repositoryAncestors] });
    const ancestors = assertVideoRepositoryPath(item, options[repositoryAncestors]);
    await this.preflightMetadataSavers(updated, updateReason, options[repositoryAncestors]);
    item.DateLastSaved = this.now();
    const saves = await this.runMetadataSavers(updated, updateReason, { saverOperation, persistImages, persistenceContext: loaded });
    // The stored timestamp must follow external metadata and image writes, even with no enabled saver.
    item.DateLastSaved = this.now();
    const newVersions = await updated.videoVersionDiscovery?.prepare(updated,
      { baseline: loaded, reportRemoved: (item, parent) => this.reportItemRemoved(item, parent) }) ?? [];
    await (persist ? persist(updated, result, { signal, newVersions })
      : persistMetadata(this.store, loaded, result, { signal, newVersions }));
    if (loaded.snapshot) this.library?.itemCreation?.recordRepositorySnapshot(item, loaded.snapshot);
    for (const version of newVersions) {
      updated.versionItemCache.set(version.Id.replaceAll('-', '').toLowerCase(), version);
      const snapshot = loaded.newVersionSnapshots?.find(row => row.Id.replaceAll('-', '').toLowerCase() === version.Id.replaceAll('-', '').toLowerCase());
      if (snapshot) this.library?.itemCreation?.recordRepositorySnapshot(version, snapshot);
      this.library?.itemCreation?.registerItem(version);
    }
    invalidateVideoParent(loaded.parent);
    if (item.SourceType == null || item.SourceType === 'Library' || item.SourceType === 0) {
      this.reportItemUpdated(item, loaded.parent, updateReason);
    }
    return { saves, updated, ancestors };
  }

  async update(loaded, result, updateReason, options = {}) {
    const { signal, reattachUserData: shouldReattach = false } = options;
    const { saves, updated, ancestors } = await this.updateRepository(loaded, result, updateReason, options);
    const item = result.Item, context = updated.context;
    // Native Video.UpdateToRepositoryAsync saves local versions serially after
    // the parent's repository/event boundary but before SaveItem reattachment.
    // Select after that boundary so new/dropped links are observed. Child saves
    // never inherit a parent's persistence closure, reattachment or credits.
    for (const reference of await localAlternateVersionIds(updated)) {
      const child = await loadLocalAlternateContext(updated, reference);
      if (!child) continue;
      try {const childResult = copyLocalAlternateMetadata(updated, child, context.images);
      await this.update(child, childResult, ItemUpdateType.MetadataDownload, {
        // Native RunMetadataSavers has no request token; cancellation reaches
        // the child's repository only after its saver/image effects.
        signal, [repositoryAncestors]: ancestors
      });}finally{await child.dispose();}
    }
    if (shouldReattach) {
      const UserData = await this.reattach(this.store, item, { signal });
      try { this.emit('UserDataReattached', { Item: item, UserData }); }
      catch (error) { this.logger.error(error, 'Error in UserDataReattached event handler'); }
    }
    return saves;
  }
}
