export function validateMetadataExtension(plugin) {
    if (!plugin?.id || !plugin.name || !Array.isArray(plugin.providers)) throw new TypeError('A metadata plugin must declare its identity and providers.');
    const ids = new Set();
    for (const provider of plugin.providers) {
      if (!provider.id || !provider.name || !provider.kind || !Array.isArray(provider.itemTypes)) throw new TypeError('Invalid metadata provider declaration.');
      if (ids.has(provider.id)) throw new Error(`Duplicate metadata provider: ${provider.id}`);
      ids.add(provider.id);
    }
}

export class MetadataRegistry {
  #plugins = new Map();

  constructor({ extensions = () => [] } = {}) { this.extensions = extensions; }

  register(plugin) {
    validateMetadataExtension(plugin);
    if (this.#plugins.has(plugin.id)) throw new Error(`Metadata plugin already registered: ${plugin.id}`);
    this.#plugins.set(plugin.id, plugin);
    return plugin;
  }

  unregister(id) { this.#plugins.delete(id); }

  plugins() { return [...this.#plugins.values(), ...this.extensions()]; }

  discover({ item, kind, libraryOptions = {}, globalOptions = {}, includeDisabled = false, forceEnableInternetMetadata = false,
    imageRefreshMode = 'Default', isMetadataFetcherEnabled, isImageFetcherEnabled } = {}) {
    const typeOptions = libraryOptions.TypeOptions?.find((options) => options.Type === item.Type);
    const providers = this.plugins().flatMap((plugin) => plugin.enabled === false ? [] : plugin.providers)
      .filter((provider) => (!kind || provider.kind === kind) && (provider.itemTypes.includes(item.Type) || provider.itemTypes.includes('*')) && (!provider.supports || provider.supports(item)));
    const orderFor = (provider) => provider.kind === 'local' ? libraryOptions.LocalMetadataReaderOrder ?? globalOptions.LocalMetadataReaderOrder ?? []
      : provider.kind === 'image' ? typeOptions?.ImageFetcherOrder ?? globalOptions.ImageFetcherOrder ?? []
        : provider.kind === 'remote' ? typeOptions?.MetadataFetcherOrder ?? globalOptions.MetadataFetcherOrder ?? [] : [];
    const enabled = (capability, name) => {
      if (item.Type === 'Channel') return true;
      if (item.SourceType === 'Channel') return !item.EnableMediaSourceDisplay;
      const names = typeOptions?.[capability + 'Fetchers'];
      if (typeOptions) return (names ?? []).some((entry) => entry.toLowerCase() === name.toLowerCase());
      return !(globalOptions['Disabled' + capability + 'Fetchers'] ?? []).some((entry) => entry.toLowerCase() === name.toLowerCase());
    };
    return providers.filter((provider) => {
      if (provider.kind === 'local' && item.SupportsLocalMetadata === false) return false;
      if (includeDisabled) return true;
      if (provider.kind === 'externalId' || provider.kind === 'externalUrl' || provider.kind === 'saver') return true;
      if (provider.kind === 'image') {
        if (item.IsLocked && imageRefreshMode !== 'FullRefresh' || item.ExtraType != null) return false;
        return isImageFetcherEnabled ? isImageFetcherEnabled(item, typeOptions, provider.name) : enabled('Image', provider.name);
      }
      if (item.IsLocked && provider.kind !== 'local' && !provider.forced) return false;
      if (forceEnableInternetMetadata || provider.kind !== 'remote') return true;
      if (item.ExtraType != null) return false;
      if (typeOptions?.MetadataFetchers?.length && !typeOptions.MetadataFetchers.some((name) => name.toLowerCase() === provider.name.toLowerCase())) return false;
      if (item.Type === 'MusicArtist' && !typeOptions) return true;
      return isMetadataFetcherEnabled ? isMetadataFetcherEnabled(item, typeOptions, provider.name) : enabled('Metadata', provider.name);
    }).sort((a, b) => {
      const ai = orderFor(a).indexOf(a.name); const bi = orderFor(b).indexOf(b.name);
      return (ai < 0 ? 2147483647 : ai) - (bi < 0 ? 2147483647 : bi) || (a.order ?? 50) - (b.order ?? 50);
    });
  }
}
