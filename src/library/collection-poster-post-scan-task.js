const collectionTypes = Object.freeze(['MediaBrowser.Controller.Entities.CollectionFolder']);
const primaryImage = image => image.Type === 'Primary' || image.Type === 0 || image.ImageType === 0;

export class CollectionPosterVerifyPostScanTask {
  constructor({ host, metadataScanner, logger = {} }) {
    if (typeof host?.getUserRootFolder !== 'function' || typeof host?.withChildSnapshot !== 'function'
      || typeof metadataScanner?.refreshLiveItem !== 'function') {
      throw new TypeError('Library poster maintenance requires user-root children and live metadata refresh.');
    }
    Object.assign(this, { host, metadataScanner, logger, name: 'CollectionPosterVerify' });
  }

  async run({ signal, reportProgress = () => {} } = {}) {
    const root = await this.host.getUserRootFolder();
    // SQL owns the complete captured membership and exact entity slots.
    // Read each captured slot after the preceding refresh: a provider can
    // mutate the next sibling even when both belong to the same capture page.
    await this.host.withChildSnapshot(root, async libraries => {
      const count = await libraries.count();
      for (let ordinal = 1n; ordinal <= count; ordinal++) {
        await libraries.withItemAtOrdinal(ordinal, async library => {
          signal?.throwIfAborted();
          // HasImage observes the relationship even for an absent file or path.
          if (!library.ImageInfos.some(primaryImage)) {
            this.logger.debug?.(`Library ${library.Name ?? ''} is missing a primary image. Refreshing metadata.`);
            await this.metadataScanner.refreshLiveItem(library, { signal });
          }
          reportProgress(Number(ordinal) / Number(count) * 100);
        });
      }
      reportProgress(100);
    }, { includeItemTypes: collectionTypes });
  }
}
