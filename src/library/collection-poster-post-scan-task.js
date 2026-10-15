const collectionFolder = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1) === 'CollectionFolder';
const primaryImage = image => image.Type === 'Primary' || image.Type === 0 || image.ImageType === 0;

export class CollectionPosterVerifyPostScanTask {
  constructor({ host, metadataScanner, logger = {} }) {
    if (typeof host?.getUserRootFolder !== 'function' || typeof host?.getCachedChildren !== 'function'
      || typeof metadataScanner?.refreshLiveItem !== 'function') {
      throw new TypeError('Library poster maintenance requires user-root children and live metadata refresh.');
    }
    Object.assign(this, { host, metadataScanner, logger, name: 'CollectionPosterVerify' });
  }

  async run({ signal, reportProgress = () => {} } = {}) {
    const root = await this.host.getUserRootFolder();
    // Keep the captured objects: refreshing one library may change a sibling,
    // while adding or removing root children must not change this iteration.
    const libraries = (await this.host.getCachedChildren(root)).filter(collectionFolder);
    let completed = 0;
    for (const library of libraries) {
      signal?.throwIfAborted();
      // HasImage observes the image relationship even for an absent file or
      // null path. Filesystem checks belong to the metadata provider lifecycle.
      if (!library.ImageInfos.some(primaryImage)) {
        this.logger.debug?.(`Library ${library.Name ?? ''} is missing a primary image. Refreshing metadata.`);
        await this.metadataScanner.refreshLiveItem(library, { signal });
      }
      reportProgress(++completed / libraries.length * 100);
    }
    reportProgress(100);
  }
}
