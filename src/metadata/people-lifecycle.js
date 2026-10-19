import { tableDefinition } from '../database/model.js';
import { EMPTY_ID, MIN_DATE, cleanValue } from '../library/records.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { nativeDateFromUnixNanoseconds } from '../users/native.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { MetadataImageAssets } from './image-assets.js';
import { persistMetadata, persistImageMetadata } from './persistence.js';
import { trySetProviderId } from './provider-ids.js';
import { clrTrim } from './whitespace.js';
import { ItemUpdateType, saveMetadata } from './save-manager.js';

const nativeType = 'MediaBrowser.Controller.Entities.Person';
const emptyRow = () => Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const argumentError = message => Object.assign(new TypeError(message), { nativeException: 'ArgumentException' });

export class PeopleMetadataLifecycleHost {
  constructor({ store, loaded, updates }) {
    Object.assign(this, { store, loaded, updates });
    this.assets = new MetadataImageAssets({ fileSystem:loaded.context.fileSystem, metadataPath: loaded.metadataPath });
  }

  async getPerson(name) {
    const identity = this.loaded.personIdentity(name);
    const row = await this.store.run(async db => (await db.rows('BaseItems', { where: { Id: identity.Id } }))[0]);
    if (row?.Type !== nativeType) return null;
    return this.loaded.reloadMetadataContext(identity.Id);
  }

  async createPerson(name) {
    const existing = await this.getPerson(name);
    if (existing) return existing;
    const identity = this.loaded.personIdentity(name);
    const directory = await this.assets.createDirectory(identity.Path);
    const item = { ...identity, Type: 'Person', Name: name, ProviderIds: {}, LockedFields: [], Genres: [], Tags: [], Studios: [],
      ProductionLocations: [], DateCreated: nativeDateFromUnixNanoseconds(directory.birthtimeNs),
      DateModified: nativeDateFromUnixNanoseconds(directory.mtimeNs), DateLastSaved: MIN_DATE,
      PresentationUniqueKey: `Person-${removeDiacritics(name)}`, IsFileProtocol: true, SourceType: 'Library' };
    const row = { ...emptyRow(), ...identity, Path: this.loaded.reversePath?.(identity.Path) ?? identity.Path,
      Type: nativeType, Name: name, Data: null, CleanName: cleanValue(name),
      SortName: this.loaded.sortName(item), DateCreated: item.DateCreated, DateModified: item.DateModified,
      PresentationUniqueKey: item.PresentationUniqueKey, ChannelId: EMPTY_ID, MediaType: 'Unknown', UnratedType: 'Other',
      Genres: '', Studios: '', Tags: '', ProductionLocations: '', Width: 0, Height: 0 };
    await this.store.transaction(async db => {
      const current = (await db.rows('BaseItems', { where: { Id: item.Id } }))[0];
      if (current) await db.update('BaseItems', { Id: item.Id }, row);
      else await db.insert('BaseItems', row);
    });
    this.updates.reportItemAdded(item);
    const loaded = await this.loaded.reloadMetadataContext(item.Id);
    loaded.providerIdsIgnoreCase = true;
    return loaded;
  }

  async createItems(loaded) {
    const { item } = loaded;
    await persistMetadata(this.store, loaded, { Item: item, Images: loaded.context.images });
    this.updates.reportItemAdded(item);
  }

  async runSavers(loaded, reason) {
    const savers = this.updates.registry?.discover({ ...loaded, kind: 'saver' }) ?? [];
    if (loaded.item.IsFileProtocol) await saveMetadata(loaded.item, reason, savers, { ...loaded,
      now: this.updates.now, logger: this.updates.logger, monitor: this.updates.monitor });
    const images = loaded.context.images;
    const imageLoaded = { ...loaded, onImageRemoteChange: async () => {
      // Native ConvertImageToLocal independently updates the Person before
      // image processing and the final CreateItems save.
      await this.updates.update(loaded, { Item: loaded.item, Images: images }, ItemUpdateType.ImageUpdate);
    } };
    await this.updates.images.updateImages(imageLoaded, images, { forceUpdate: reason >= ItemUpdateType.ImageUpdate,
      persistImages: current => persistImageMetadata(this.store, loaded, current) });
  }

  async savePeople(people, { signal } = {}) {
    for (const person of people) {
      signal?.throwIfAborted();
      let reason = ItemUpdateType.MetadataDownload, save = false;
      let loaded = await this.getPerson(person.Name);
      if (!loaded) {
        try { loaded = await this.createPerson(person.Name); save = true; }
        catch (error) { this.updates.logger.error(error, `Failed to create person ${person.Name}`); continue; }
      }
      try {for (const [key, value] of Object.entries(person.ProviderIds ?? {})) {
        const oldKey = Object.keys(loaded.item.ProviderIds).find(entry => loaded.providerIdsIgnoreCase ? ordinalIgnoreCaseEquals(entry, key) : entry === key);
        const oldValue = oldKey == null ? null : loaded.item.ProviderIds[oldKey];
        if (oldValue === value || ordinalIgnoreCaseEquals(oldValue, value)) continue;
        if (typeof key !== 'string' || !clrTrim(key) || key.includes('=') || typeof value !== 'string' || !clrTrim(value)) {
          throw argumentError('Provider id names and values must be nonempty and the name cannot contain equals.');
        }
        // Native SetProviderId still marks the entity for saving when a known
        // provider rejects the ID's format.
        trySetProviderId(loaded.item, key, value, { ignoreCase: loaded.providerIdsIgnoreCase === true }); save = true;
      }
      if (person.ImageUrl != null && clrTrim(person.ImageUrl) && !loaded.context.images.some(image => image.Type === 'Primary')) {
        loaded.context.images.push({ Path: person.ImageUrl, Type: 'Primary', DateModified: MIN_DATE, Width: 0, Height: 0, Blurhash: null });
        save = true; reason = ItemUpdateType.ImageUpdate;
      }
      if (!save) continue;
      await this.runSavers(loaded, reason);
      loaded.item.DateLastSaved = this.updates.now();
      await this.createItems(loaded);
      }finally{await loaded.dispose();}
    }
  }
}
