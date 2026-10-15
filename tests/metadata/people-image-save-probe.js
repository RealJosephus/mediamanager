/** Trace the native SaveImages boundary, not every internal image-row rewrite. */
export function installPeopleImageSaveProbe(fixture, sample, calls, projection) {
  const images = fixture.host.images;
  const updateImages = images.updateImages.bind(images);
  const query = fixture.database.client.query.bind(fixture.database.client);
  let saves = 0, failInsert = false;
  images.updateImages = (loaded, values, options = {}) => updateImages(loaded, values, {
    ...options,
    ...(options.persistImages ? {
      persistImages: async current => {
        calls.push({ action: 'images', item: projection(loaded.item, current) });
        failInsert = ++saves === sample.imageFailureAt;
        try { return await options.persistImages(current); }
        finally { failInsert = false; }
      },
    } : {}),
  });
  fixture.database.client.query = (...args) => {
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (failInsert && /\bINSERT INTO\s+(?:"[^"]+"\.)?"BaseItemImageInfos"(?:\s|$)/u.test(statement)) {
      throw Object.assign(new Error('Injected image insert failure'), { nativeException: 'DbUpdateException' });
    }
    return query(...args);
  };
}
