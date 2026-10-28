import { PluginHost } from './plugins/host.js';
import { IntroProviderManager } from './library/intro-providers.js';
import { initializeLiveTvState } from './database/live-tv-state-import.js';
import { LiveTvService } from './library/live-tv-service.js';
import { LiveTvTimersService } from './library/live-tv-timers-service.js';
import { LiveTvRecordingsService } from './library/live-tv-recordings-service.js';
import { LiveTvRecordingFolders } from './library/live-tv-recording-folders.js';
import { LiveTvSourcesService } from './library/live-tv-sources-service.js';
import { LiveTvTunerService } from './library/live-tv-tuner-service.js';
import { LiveTvGuideService } from './library/live-tv-guide-service.js';
import { LiveTvGuideImages } from './library/live-tv-guide-images.js';
import { LiveTvCountriesClient } from './core/live-tv-countries.js';
import { LiveTvMediaSources } from './library/live-tv-media-sources.js';
import { createIntroPathResolver } from './library/intro-path-resolver.js';
import { guid, nonemptyId, libraryError, sameId } from './library/records.js';
import { LibraryTaskScheduler } from './library/library-task-scheduler.js';
import { createConfiguredStorage } from './storage-bootstrap.js';
import { DomainStore } from './database/domain-store.js';
import { ActivityLogManager } from './activity/manager.js';
import { UserService, AuthenticationService, ApiKeyService, DeviceService, QuickConnectService, PasswordResetService } from './users/index.js';
import { createAudioBookItemResolver, createAudioItemResolver, createBookItemResolver, createBoxSetItemResolver, createPhotoAlbumResolver, createPhotoItemResolver, createPlaylistItemResolver, createTvItemResolver, createVideoFileResolver, DirectoryItemResolverPipeline, FolderValidationService, LibraryDirectoryMonitor, LibraryMonitorHost, ItemCreationService, ItemDeletionService, LibraryMetadataScanService, LibraryScanHost, LibraryScanLifecycle, LibraryScanService, LibraryService, LinkedChildReferenceService, MusicGenresPostScanTask, PlaylistService, ResolvedItemLifecycleHost, SimilarItemsManager, TopLevelFolderValidationService } from './library/index.js';
import { SessionService, UserDataService } from './sessions/index.js';
import { createApplication } from './http/application.js';
import { createCoreLocalization } from './core/i18n.js';
import { loadLibraryOptions, createVirtualPathExpander } from './library/options.js';
import { PlaybackService } from './playback/service.js';
import { LiveStreamsService } from './playback/live-streams.js';
import { LiveStreamProbe } from './playback/live-stream-probe.js';
import { probeRaw } from './storage/ffprobe.js';
import { normalizeProbe } from './storage/probe-normalizer.js';
import { localizeMediaStream } from './library/media-streams.js';
import { ProbeService } from './library/probe-service.js';
import { detectUdfDiscType } from './storage/udf-disc-type.js';
import { ExternalDataManager } from './library/external-data.js';
import { UnsafeItemDeletionService } from './library/unsafe-item-deletion-service.js';
import { GenresPostScanTask, StudiosPostScanTask } from './library/by-name-post-scan-task.js';
import { ArtistsPostScanTask } from './library/artists-post-scan-task.js';
import { CollectionPosterVerifyPostScanTask } from './library/collection-poster-post-scan-task.js';
import { createCollectionRuntimeServices } from './library/collection-runtime-services.js';
import { PostgresLinkedChildrenStore } from './library/postgres-linked-children.js';
import { copyNativeItemRepositoryFrame, publishNativeItemLinks } from './library/native-item-entity.js';
import { CleanDatabasePostScanTask } from './library/clean-database-post-scan-task.js';
import { SplashscreenPostScanTask } from './library/splashscreen-post-scan-task.js';
import { ExtractionService } from './playback/extraction.js';
import { SubtitleCache } from './playback/subtitle-cache.js';
import { RemuxService } from './playback/remux.js';
import { MediaEncoder } from './playback/media-encoder.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { HlsService } from './playback/hls.js';
import { ImageProcessor } from './images/processor.js';
import { ImageService } from './images/service.js';
import { SplashscreenImageGenerator } from './images/splashscreen.js';
import { MetadataImageAssets } from './metadata/image-assets.js';
import { MetadataImages } from './metadata/images.js';
import { MetadataUpdateHost } from './metadata/update-host.js';
import { MetadataRegistry, MetadataSaveHost, MetadataRefreshHost, ProviderRefreshService, SeriesMetadataLifecycleHost, createLocalXmlPlugin, createMetadataContextLoader, createPlaylistItemsPlugin } from './metadata/index.js';
import { loadExternalUrlConfiguration } from './library/external-urls.js';
import { serverFriendlyName } from './configuration.js';
import { createBuiltinExternalUrlPlugin } from './metadata/external-url-providers.js';
import { createPhotoMetadataPlugin } from './metadata/photo-provider.js';
import { createPhotoAlbumImagePlugin } from './metadata/photo-album-provider.js';
import { createCollectionFolderImagePlugin } from './metadata/collection-folder-image-provider.js';
import { createChannelDynamicImagePlugin } from './metadata/channel-dynamic-image-provider.js';
import { createBookOpfPlugin } from './metadata/book-opf-provider.js';
import { createBookEpubPlugin } from './metadata/book-epub-provider.js';
import { createBookComicPlugin } from './metadata/book-comic-provider.js';
import { BookArchiveService } from './storage/archive-reader.js';
import { SyncPlayService } from './syncplay/service.js';
import { UserViewService } from './library/user-view-service.js';
import { ChannelService } from './library/channel-service.js';
import { initializeLibraryRoot } from './library/root-initialization.js';
import { ScheduledTaskManager } from './tasks/index.js';
import { AutoDiscoveryService } from './network/auto-discovery.js';
import { MetadataEditorService } from './metadata/editor-service.js';
import { MetadataEditService } from './metadata/edit-service.js';
import { ServerConfigurationStore } from './core/server-configuration-store.js';
import { NamedConfigurationStore } from './core/named-configuration-store.js';
import { EncodingPaths } from './core/encoding-paths.js';
import { FallbackFonts } from './playback/fallback-fonts.js';
import { defaultConfiguration } from './core/configuration-xml.js';
import { DotIgnoreRule } from './library/dot-ignore-rule.js';
import { BrandingConfigurationStore } from './branding/configuration.js';
import { BrandingService } from './branding/service.js';
import { LibraryOptionsStore } from './library/library-options-store.js';
import { LibraryConfigurationService } from './library/library-configuration-service.js';
import { refreshLibraryTaskId } from './tasks/refresh-library-task.js';
import { RefreshGuideTaskWorker, refreshGuideTaskId } from './tasks/refresh-guide-task.js';
import { DisplayPreferencesService } from './users/display-preferences-service.js';
import { StartupService } from './users/startup-service.js';
import { clrTrim } from './metadata/whitespace.js';
import { createConfigurationBinding, namedConfigurationCodec } from '../packages/plugin-sdk/configuration.js';
import { networkConfigurationBaseUrl } from './core/network-configuration.js';
import { NetworkService } from './network/network-service.js';
import { NetworkHost } from './network/host.js';

function absoluteApplicationPath(value, name) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

export async function createRuntime({ database, configuration, serverId, serverName = configuration?.ServerName || 'MediaManager', serverVersion = '13.0.0',
  networkConfiguration, publicAddress,
  programDataPath, configurationDirectoryPath, dataPath, metadataPath, cachePath, logDirectoryPath, libraryOptions, directoryItemResolvers,
  pluginOptions = {}, storageConfiguration, environment, portableMountContract,
  vfs, identityMap, ignoreIdentityMap = identityMap, mediaEncoderOptions = {}, probeOptions, extractionOptions, remuxOptions, hlsOptions, imageOptions = {}, metadataOptions = {}, onError,
  autoDiscoveryOptions, onDatabaseOwnershipTransferred, systemLifecycle } = {}) {
  programDataPath = absoluteApplicationPath(programDataPath, 'programDataPath');
  configurationDirectoryPath = absoluteApplicationPath(configurationDirectoryPath, 'configurationDirectoryPath');
  dataPath = absoluteApplicationPath(dataPath, 'dataPath');
  metadataPath = absoluteApplicationPath(metadataPath, 'metadataPath');
  cachePath = absoluteApplicationPath(cachePath, 'cachePath');
  logDirectoryPath = absoluteApplicationPath(logDirectoryPath, 'logDirectoryPath');
  const rollback = [];
  let splashscreen;
  let cancelMetadata = () => {};
  let plugins, configuredStorage, fileSystem;
  try {
  const store = new DomainStore(database);
  rollback.push(() => store.close());
  onDatabaseOwnershipTransferred?.();
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  rollback.push(() => linkedChildren.close());
  await linkedChildren.initialize();
  const logger = { error: error => onError?.(error), warn: error => onError?.(error) };
  configurationDirectoryPath ??= programDataPath && path.resolve(programDataPath, '..', 'config');
  dataPath ??= programDataPath && path.join(programDataPath, 'data');
  metadataPath ??= programDataPath && path.join(programDataPath, 'metadata');
  cachePath ??= programDataPath && path.join(programDataPath, 'cache');
  logDirectoryPath ??= programDataPath && path.resolve(programDataPath, '..', 'log');
  const applicationPaths = { programDataPath, dataPath, configurationDirectoryPath, logDirectoryPath,
    defaultMetadataPath: programDataPath ? path.join(programDataPath, 'metadata') : metadataPath,
    metadataPath: clrTrim(configuration.MetadataPath ?? '') ? configuration.MetadataPath : (programDataPath ? path.join(programDataPath, 'metadata') : metadataPath),
    cachePath: clrTrim(configuration.CachePath ?? '') ? configuration.CachePath : cachePath };
  if (logDirectoryPath) await mkdir(logDirectoryPath, { recursive: true });
  await store.transaction(database => initializeLiveTvState(database, { dataPath, logger }));
  const namedConfiguration = configurationDirectoryPath ? new NamedConfigurationStore({ configurationDirectoryPath, onError,
    loadedConfigurations: networkConfiguration === undefined ? [] : [['network', networkConfiguration]] }) : undefined;
  if (namedConfiguration) {
    rollback.push(() => namedConfiguration.close());
    await namedConfiguration.getConfiguration('network');
    await namedConfiguration.getConfiguration('xbmcmetadata');
  }
  const componentNetworkConfiguration = namedConfiguration ? undefined : networkConfigurationBaseUrl(networkConfiguration ?? defaultConfiguration('network'));
  const getNetworkConfiguration = () => namedConfiguration ? namedConfiguration.getCurrentConfiguration('network') : componentNetworkConfiguration;
  const baseUrl = getNetworkConfiguration().BaseUrl;
  let application, networkHost;
  const network = new NetworkService({ getNetworkConfiguration, namedConfiguration,
    getApplicationHost: () => networkHost, publishedUrl: publicAddress ?? autoDiscoveryOptions?.publishedUrl, logger });
  rollback.push(() => network.close());
  await network.initialize();
  const getSmartApiUrl = request => network.getSmartApiUrl(request);
  let componentNfoConfiguration = defaultConfiguration('xbmcmetadata');
  const nfoBinding = createConfigurationBinding({
    getCurrent: () => namedConfiguration ? namedConfiguration.getCurrentConfiguration('xbmcmetadata') : componentNfoConfiguration,
    save: value => namedConfiguration ? namedConfiguration.saveConfiguration('xbmcmetadata', value) : Promise.resolve(componentNfoConfiguration = value),
    fields: namedConfigurationCodec('xbmcmetadata').fields,
  });
  plugins = await PluginHost.open({ programDataPath, configurationDirectoryPath, dataPath,
    get metadataPath() { return applicationPaths.metadataPath; }, get cachePath() { return applicationPaths.cachePath; },
    imageCachePath: imageOptions.cachePath, onError, ...pluginOptions,
    configurationBindings: new Map([...(pluginOptions.configurationBindings ?? []), ['xbmcmetadata', nfoBinding]]) });
  rollback.push(() => plugins.close());
  configuredStorage = await createConfiguredStorage(storageConfiguration, { plugins, environment, portableMountContract });
  fileSystem = configuredStorage.fileSystem;
  const usesConfiguredStorage=Boolean(storageConfiguration || !vfs);
  if (usesConfiguredStorage) ({ vfs, identityMap, ignoreIdentityMap } = configuredStorage);
  const metadataVfs=usesConfiguredStorage?configuredStorage.metadataVfs:vfs;
  const metadataIdentityMap=usesConfiguredStorage?configuredStorage.metadataIdentityMap:identityMap;
  rollback.push(() => configuredStorage.close());
  const storageReadiness = { ready: false, error: null };
  const unavailableStorage = error => ['ENOTSUP','not-supported','unmapped-path'].includes(error?.code);
  const deferUnavailable = async operation => {
    try { await operation(); return true; }
    catch (error) { if (!unavailableStorage(error)) throw error; storageReadiness.error=error.message; onError?.(error); return false; }
  };
  const configurationStore = configurationDirectoryPath ? new ServerConfigurationStore({ configuration, configurationDirectoryPath,
    applicationPaths, metadataFileSystem: fileSystem, onError }) : undefined;
  const configurationSource = configurationStore ?? { configuration };
  const currentConfiguration = () => configurationSource.configuration;
  if (configurationStore) {
    rollback.push(() => configurationStore.close());
    await deferUnavailable(() => configurationStore.initialize());
  }
  networkHost = new NetworkHost({ network, getNetworkConfiguration, getSystemConfiguration: currentConfiguration,
    configurationStore, namedConfiguration, onError });
  rollback.push(() => networkHost.close());
  await networkHost.initialize();
  const localization = await createCoreLocalization({ serverCulture: configuration.UICulture || 'en-US' });
  const activities = new ActivityLogManager({ store, localization, onError });
  rollback.push(() => activities.close());
  const isLocalNetwork = address => network.isInLocalNetwork(address);
  const users = new UserService({ store, serverId, activities, isLocalNetwork,
    get castReceiverApplications() { return currentConfiguration().CastReceiverApplications ?? []; } });
  const liveTv = new LiveTvService({ users, configurationDirectoryPath, onError });
  rollback.push(() => liveTv.close());
  const startup = new StartupService({ users, get configuration() { return currentConfiguration(); }, configurationStore, namedConfiguration });
  rollback.push(() => startup.close());
  const displayPreferences = new DisplayPreferencesService({ store, onError });
  rollback.push(() => displayPreferences.close());
  // A VFS-only runtime can explicitly own metadata state without a data path.
  const spoolStateRoot = dataPath ?? applicationPaths.metadataPath;
  const spoolRoot = spoolStateRoot && path.join(spoolStateRoot, 'metadata-spool');
  fileSystem.spoolRoot = spoolRoot;
  const bookArchives = new BookArchiveService({ vfs, identityMap,
    spoolPath: programDataPath && path.join(programDataPath, 'cache', 'book-archives') });
  rollback.push(() => bookArchives.close());
  let rootInitialization, libraryScanHost;
  const mergeCommittedRoot = (current, committed, currentFresh, committedFresh) => {
    if (!current || current.NativeType !== committed.NativeType || !sameId(current.Id, committed.Id)) {
      return { item: committed, fresh: Boolean(committedFresh) };
    }
    current.ParentId = committed.ParentId;
    current.DateLastSaved = committed.DateLastSaved;
    current.Path = committed.Path;
    copyNativeItemRepositoryFrame(current, committed);
    return { item: current, fresh: Boolean(currentFresh || committedFresh) };
  };
  const adoptRootInitialization = initialized => {
    if (!initialized?.aggregateFolder && !initialized?.playlistsFolder) return;
    if (libraryScanHost) {
      libraryScanHost.adoptRootInitialization(initialized);
      return;
    }
    const aggregate = initialized.aggregateFolder
      ? mergeCommittedRoot(rootInitialization?.aggregateFolder, initialized.aggregateFolder,
        rootInitialization?.freshAggregateFolder, initialized.freshAggregateFolder)
      : { item: rootInitialization?.aggregateFolder ?? null, fresh: Boolean(rootInitialization?.freshAggregateFolder) };
    const playlists = initialized.playlistsFolder
      ? mergeCommittedRoot(rootInitialization?.playlistsFolder, initialized.playlistsFolder,
        rootInitialization?.freshPlaylistsFolder, initialized.freshPlaylistsFolder)
      : { item: rootInitialization?.playlistsFolder ?? null, fresh: Boolean(rootInitialization?.freshPlaylistsFolder) };
    rootInitialization = Object.freeze({ aggregateFolder: aggregate.item, playlistsFolder: playlists.item,
      freshAggregateFolder: aggregate.fresh, freshPlaylistsFolder: playlists.fresh });
  };
  const initializeStorageRoots = async () => {
    await initializeLibraryRoot({ fileSystem, store, programDataPath, dataPath, metadataPath: applicationPaths.metadataPath, configuration: currentConfiguration(),
      onCommitted: adoptRootInitialization });
    if (!spoolRoot) return;
    const directory = spoolRoot;
    await fileSystem.mkdir(directory, { recursive: true });
    const info = await fileSystem.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Metadata spool storage requires an owned state directory.');
    const root = await fileSystem.realpath(spoolStateRoot), actual = await fileSystem.realpath(directory), relative = path.relative(root, actual);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new TypeError('Metadata spool storage must remain within its owned state root.');
    }
  };
  storageReadiness.ready = await deferUnavailable(initializeStorageRoots);
  const libraryOptionsStore = programDataPath ? new LibraryOptionsStore({ fileSystem, programDataPath, dataPath,
    get metadataPath() { return applicationPaths.metadataPath; },
    ...(libraryOptions && { optionsById: libraryOptions }), onError }) : undefined;
  if (libraryOptionsStore) rollback.push(() => libraryOptionsStore.close());
  if (!libraryOptions) {
    await deferUnavailable(async () => { libraryOptions = await loadLibraryOptions(database, { fileSystem, programDataPath, dataPath, metadataPath: applicationPaths.metadataPath, onError, optionsStore: libraryOptionsStore }); });
    libraryOptions ??= libraryOptionsStore?.optionsById ?? new Map();
  }
  const expandPath = programDataPath ? createVirtualPathExpander({ programDataPath, dataPath,
    get metadataPath() { return applicationPaths.metadataPath; } }) : undefined;
  const externalUrlConfiguration = await loadExternalUrlConfiguration({ programDataPath, onError });
  const library = new LibraryService({ fileSystem, store, linkedChildren, serverId, programDataPath, dataPath,
    get metadataPath() { return applicationPaths.metadataPath; }, get configuration() { return currentConfiguration(); }, libraryOptions, localization, liveTv, expandPath, logger, onError, ...externalUrlConfiguration });
  rollback.push(() => library.close());
  const channels = new ChannelService({ plugins, library, users, getMetadata: () => metadata,
    get cachePath() { return applicationPaths.cachePath; }, onError });
  library.channels = channels;
  rollback.push(() => channels.close());
  const playlists = programDataPath && dataPath
    ? new PlaylistService({ fileSystem, store, library, linkedChildren, spoolRoot, programDataPath, dataPath, get configuration() { return currentConfiguration(); }, vfs, identityMap, onError,
      preflightExternalSave: async playlist => {
        if (loadContext && metadataUpdates) await loadContext.withContext(playlist.Id, {},
          loaded => metadataUpdates.preflightMetadataSavers(loaded, 16));
      },
      updateExternalRepository: (playlist, changes) => loadContext.withContext(playlist.Id, { includeChildren: false }, async loaded => {
        const item = loaded.item;
        if (item.Path !== playlist.Path) throw Object.assign(new Error('The playlist path changed before saving.'), { status: 409 });
        if (changes.name !== undefined) item.Name = changes.name;
        if (changes.shares !== undefined) item.Shares = changes.shares;
        if (changes.openAccess !== undefined) item.OpenAccess = changes.openAccess;
        if (changes.ownerUserId !== undefined) item.OwnerUserId = changes.ownerUserId;
        if (changes.links !== undefined) {
          publishNativeItemLinks(item, linkedChildren.retain(changes.links));
          await linkedChildren.flushReleases();
        }
        if (changes.mediaAdded) item.DateLastMediaAdded = new Date().toISOString();
        await metadataUpdates.update(loaded, { Item: item }, 16);
      }),
      queueExternalRefresh: playlist => {
        const ready = store.currentOperationCompletion();
        return store.runDetached(() => metadata?.queue(playlist.Id, { ForceSave: true }, 0, { ready }));
      } })
    : undefined;
  if (playlists) rollback.push(() => playlists.close());
  const userData = new UserDataService({ store, library, users, get configuration() { return currentConfiguration(); } });
  const sessions = new SessionService({ store, library, userData, users, activities, serverId, get configuration() { return currentConfiguration(); }, onError });
  rollback.push(() => sessions.close());
  const liveTvTimers = new LiveTvTimersService({ store, serverId, liveTv, users, sessions, dataPath, onError,
    loadProgramDtos: (_database, ids) => library.loadLiveTvTimerProgramDtos(ids),
    loadProgram: id => library.loadLiveTvTimerProgram(id) });
  rollback.push(() => liveTvTimers.close());
  const syncPlay = new SyncPlayService({ sessions, users, library, onError });
  rollback.push(() => syncPlay.close());
  const devices = new DeviceService({ store, users, sessions });
  const refreshes = new ProviderRefreshService({ onError });
  const classifyIso = (candidate, { signal } = {}) => detectUdfDiscType(vfs, candidate.accessPath,
    { signal, version: candidate.entry.version });
  const resolverPipeline = vfs && identityMap && programDataPath ? new DirectoryItemResolverPipeline({
    resolvers: directoryItemResolvers ?? [createPlaylistItemResolver(), createBoxSetItemResolver(),
      createBookItemResolver(), createPhotoItemResolver(), createPhotoAlbumResolver(),
      createTvItemResolver({ localization, classifyIso, logger }), createAudioItemResolver(),
      createVideoFileResolver({ localization, classifyIso, logger }),
      createAudioBookItemResolver()],
    programDataPath,
    get configuration() { return currentConfiguration(); },
    onError
  }) : undefined;
  const authentication = new AuthenticationService({ store, users, sessions, activities, serverId, serverName, serverVersion,
    // Both supported client protocols remain available independently of the
    // source server's switch for its older authorization transports.
    isLocalNetwork, enableLegacyAuthorization: true });
  Object.defineProperty(authentication, 'serverName', { get: () => serverFriendlyName(currentConfiguration(), serverName) });
  const apiKeys = new ApiKeyService({ store });
  rollback.push(() => apiKeys.close());
  authentication.syncPlay = syncPlay;
  const quickConnect = new QuickConnectService({ get configuration() { return currentConfiguration(); }, authentication });
  rollback.push(() => quickConnect.close());
  const passwordResets = new PasswordResetService({ users, programDataPath });
  rollback.push(() => passwordResets.close());
  if (namedConfiguration) {
    await namedConfiguration.getConfiguration('encoding');
    await namedConfiguration.getConfiguration('metadata');
  }
  const encodingDefaults = defaultConfiguration('encoding'), metadataDefaults = defaultConfiguration('metadata');
  const getEncodingOptions = () => namedConfiguration ? namedConfiguration.getCurrentConfiguration('encoding') : encodingDefaults;
  const getMetadataConfiguration = () => namedConfiguration ? namedConfiguration.getCurrentConfiguration('metadata') : metadataDefaults;
  const mediaEncoder = new MediaEncoder({ ...mediaEncoderOptions, environment, getEncodingOptions,
    saveEncodingOptions: async options => { if (namedConfiguration) await namedConfiguration.saveConfiguration('encoding', options); }, onError });
  rollback.push(() => mediaEncoder.close());
  const encodingPaths = new EncodingPaths({ applicationPaths, getEncodingOptions });
  const fallbackFonts = new FallbackFonts({ fileSystem, getEncodingOptions, localization });
  rollback.push(() => fallbackFonts.close());
  const externalData = new ExternalDataManager({ fileSystem, store, vfs, identityMap:metadataIdentityMap, dataPath,
    get metadataPath() { return applicationPaths.metadataPath; }, logger });
  const probe = vfs && identityMap ? new ProbeService({ store, vfs, identityMap, mediaEncoder, probeOptions, localization, library, externalData }) : undefined;
  if (probe) rollback.push(() => probe.close());
  const extraction = probe ? new ExtractionService({ vfs, bridge:probe.bridge, ...extractionOptions, mediaEncoder, getEncodingOptions,
    subtitleCache: new SubtitleCache({ fileSystem, dataPath, onError }) }) : undefined;
  if (extraction) rollback.push(() => extraction.close());
  const remux = probe ? new RemuxService({ vfs, bridge:probe.bridge, ...remuxOptions, mediaEncoder }) : undefined;
  if (remux) rollback.push(() => remux.close());
  const hls = probe ? new HlsService({ vfs, bridge: probe.bridge, remux, onError, ...hlsOptions,
    mediaEncoder, getEncodingOptions, getCacheDirectory: () => encodingPaths.getTranscodePath() }) : undefined;
  if (hls) rollback.push(() => hls.close());
  sessions.hls = hls;
  let liveTvMediaSources, liveStreams, liveStreamProbe;
  const playback = new PlaybackService({ library, vfs, identityMap, sessions, activities, get configuration() { return currentConfiguration(); }, getEncodingOptions, getNetworkConfiguration, getSmartApiUrl, serverVersion, isLocalNetwork, probe, extraction, remux, hls,
    getLiveTvMediaSources: () => liveTvMediaSources, getLiveStreams: () => liveStreams });
  rollback.push(() => { playback.beginClose(); return playback.drainSubtitlePreparations(); });
  const { cachePath: imageCachePath, ...imageProcessorOptions } = imageOptions;
  const imageProcessor = new ImageProcessor({ fileSystem,
    get cachePath() { return imageCachePath ?? (applicationPaths.cachePath && path.join(applicationPaths.cachePath, 'images')); },
    logger, ...imageProcessorOptions });
  rollback.push(() => imageProcessor.close());
  splashscreen = dataPath ? new SplashscreenImageGenerator({ dataPath, logger,
    assets: new MetadataImageAssets({ fileSystem, vfs, identityMap:metadataIdentityMap, get metadataPath() { return applicationPaths.metadataPath; },
      stateRoots: [dataPath, ...(programDataPath ? [path.join(programDataPath, 'cache')] : [])] }) }) : undefined;
  if (splashscreen) rollback.push(() => splashscreen.close());
  const metadataImages = new MetadataImages({ processor: imageProcessor, logger });
  const similarItems = new SimilarItemsManager({ fileSystem, extensions: () => plugins.entries('similar'),
    get cachePath() { return metadataOptions.similarCachePath ?? applicationPaths.cachePath; },
    logger, now: metadataOptions.similarNow });
  library.similarItems = similarItems;
  const ignoreRule = vfs && identityMap ? new DotIgnoreRule({ vfs, identityMap: ignoreIdentityMap }) : undefined;
  let loadContext;
  let metadata;
  let metadataUpdates;
  let resolvedItemLifecycle;
  let itemCreation;
  let seriesLifecycle;
  // Native instance items (including managed playlists) still have metadata
  // and deletion lifecycles before any media storage is configured. The
  // context loader separately requires VFS mappings for media-side items.
  if (programDataPath || vfs && identityMap) {
    const registry = new MetadataRegistry();
    await plugins.bind('metadata',extension=>{registry.register(extension);return()=>registry.unregister(extension.id);});
    registry.register(createLocalXmlPlugin({ fileSystem, vfs:metadataVfs, linkedChildren, spoolRoot, externalIdInfos: item => registry.discover({ item, kind: 'externalId' })
      .map(provider => provider.getExternalIdInfo()) }));
    registry.register(createPlaylistItemsPlugin({ fileSystem, vfs, linkedChildren, spoolRoot }));
    registry.register(createBuiltinExternalUrlPlugin());
    registry.register(createPhotoMetadataPlugin({ imageProcessor, logger }));
    registry.register(createPhotoAlbumImagePlugin({ store, fileSystem, vfs, identityMap, metadataIdentityMap,
      get metadataPath() { return applicationPaths.metadataPath; },
      tempPath: programDataPath && path.join(programDataPath, 'cache', 'temp'), images: metadataImages,
      get configuration() { return currentConfiguration(); }, expandPath: library.options.expandPath, logger }));
    registry.register(createCollectionFolderImagePlugin({ library, images: metadataImages }));
    registry.register(createChannelDynamicImagePlugin({ channels }));
    registry.register(createBookComicPlugin({ fileSystem, openArchive: bookArchives.openArchive, logger,
      culture: () => currentConfiguration().UICulture || 'en-US' }));
    registry.register(createBookEpubPlugin({ openArchive: bookArchives.openArchive, logger }));
    registry.register(createBookOpfPlugin({ fileSystem, logger }));
    library.options.externalUrlRegistry = registry;
    loadContext = createMetadataContextLoader({ fileSystem, store, library, linkedChildren, spoolRoot, vfs, identityMap, metadataIdentityMap, get configuration() { return currentConfiguration(); }, contextExtensions: () => plugins.entries('context'),
      get metadataConfiguration() { return metadataOptions.metadataConfiguration ?? getMetadataConfiguration(); }, ignoreRule, externalData, logger });
    if (probe) probe.loadContext = loadContext;
    itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren });
    library.itemCreation = itemCreation;
    rollback.push(() => itemCreation.close());
    const saver = new MetadataSaveHost({ registry, loadContext, logger });
    saver.start(userData);
    rollback.push(() => saver.dispose());
    rollback.push(() => saver.stop());
    metadataUpdates = new MetadataUpdateHost({ registry, store, images: metadataImages, library, logger });
    resolvedItemLifecycle = new ResolvedItemLifecycleHost({ store, loadContext, updates: metadataUpdates, images: metadataImages });
    if (probe) probe.updates = metadataUpdates;
    const metadataNow = () => new Date().toISOString();
    seriesLifecycle = new SeriesMetadataLifecycleHost({ store, loadContext, updates: metadataUpdates, externalData,
      itemCreation, refresh: (reference, options) => metadata.refresh(reference, options), logger, now: metadataNow });
    metadata = new MetadataRefreshHost({ registry, loadContext, store, linkedChildren, vfs, logger, userData, probe, externalData,
      images: metadataImages, updates: metadataUpdates, seriesLifecycle, now: metadataNow });
    cancelMetadata = () => metadata.cancel();
    rollback.push(async () => { await bookArchives.close(); await metadata.close(); });
    Object.assign(metadata, { saver });
  }
  library.itemCreation = itemCreation;
  const introProviders = new IntroProviderManager({ extensions: () => plugins.entries('intro'), logger,
    getItem: async id => {
      const normalized = guid(id);
      if (!nonemptyId(normalized)) throw libraryError(400, "Guid can't be empty (Parameter 'id')");
      if (itemCreation) return itemCreation.getItemById(normalized);
      try { return await library.getItemRecord(normalized); }
      catch (error) { if (error.status === 404) return null; throw error; }
    },
    resolvePath: resolverPipeline ? createIntroPathResolver({ vfs, identityMap, ignoreRule, resolverPipeline,
      applicationRootPath: path.join(programDataPath, 'root') }) : async () => null,
  });
  library.introProviders = introProviders;
  rollback.push(() => introProviders.close());
  const linkedChildReferences = itemCreation && metadataUpdates
    ? new LinkedChildReferenceService({ store, linkedChildren, itemCreation, loadContext, updates: metadataUpdates })
    : undefined;
  const libraryTaskScheduler = loadContext ? new LibraryTaskScheduler({ get configuration() { return currentConfiguration(); },
    captureWorker: operation => metadata.bindShutdownDrain(operation),
    runWorker: operation => store.runDetached(() => loadContext.withDetachedScope(operation)), onError }) : undefined;
  if (libraryTaskScheduler) rollback.push(() => libraryTaskScheduler.close());
  const metadataScanner = metadata ? new LibraryMetadataScanService({ library, metadata, logger, scheduler: libraryTaskScheduler }) : undefined;
  const folderValidation = itemCreation && resolverPipeline ? new FolderValidationService({ store, library, itemCreation,
    resolvedItemLifecycle, vfs, identityMap, ignoreRule, resolverPipeline, loadContext, programDataPath, configurationDirectoryPath,
    get metadataConfiguration() { return metadataOptions.metadataConfiguration ?? getMetadataConfiguration(); }, get configuration() { return currentConfiguration(); }, refreshes,
    linkedChildReferences, metadataScanner, scheduler: libraryTaskScheduler, onError }) : undefined;
  library.folderValidation = folderValidation;
  const itemDeletion = itemCreation ? new ItemDeletionService({ store, library, loadContext, itemCreation,
    updates: metadataUpdates, externalData, linkedChildReferences, vfs, metadataVfs, channelManager: channels, logger }) : undefined;
  library.itemDeletion = itemDeletion;
  const unsafeItemDeletion = itemCreation ? new UnsafeItemDeletionService({ store, library, itemCreation,
    externalData, vfs, identityMap, metadataIdentityMap, logger }) : undefined;
  library.unsafeItemDeletion = unsafeItemDeletion;
  const topLevelValidation = itemCreation && loadContext ? new TopLevelFolderValidationService({ library, itemCreation, loadContext,
    metadataScanner, get metadataConfiguration() { return metadataOptions.metadataConfiguration ?? getMetadataConfiguration(); },
    get configuration() { return currentConfiguration(); }, optionsStore: libraryOptionsStore }) : undefined;
  libraryScanHost = topLevelValidation ? new LibraryScanHost({ store, library, itemCreation, metadataScanner,
    topLevelValidation, ignoreRule, rootInitialization }) : undefined;
  rootInitialization = undefined;
  library.rootHost = libraryScanHost;
  if (libraryScanHost) rollback.push(() => libraryScanHost.close());
  const musicGenresPostScanTask = itemCreation && metadataScanner
    ? new MusicGenresPostScanTask({ store, library, metadataScanner, logger }) : undefined;
  const artistsPostScanTask = itemCreation && metadataScanner
    ? new ArtistsPostScanTask({ store, library, linkedChildren, metadataScanner, logger }) : undefined;
  const genresPostScanTask = itemCreation && metadataScanner
    ? new GenresPostScanTask({ store, library, metadataScanner, logger }) : undefined;
  const studiosPostScanTask = itemCreation && metadataScanner
    ? new StudiosPostScanTask({ store, library, metadataScanner, logger }) : undefined;
  const collectionPosterVerifyPostScanTask = libraryScanHost && metadataScanner
    ? new CollectionPosterVerifyPostScanTask({ host: libraryScanHost, metadataScanner, logger }) : undefined;
  const cleanDatabasePostScanTask = itemCreation && itemDeletion
    ? new CleanDatabasePostScanTask({ store, library, itemCreation, itemDeletion, externalData, vfs, identityMap, logger }) : undefined;
  const splashscreenPostScanTask = splashscreen ? new SplashscreenPostScanTask({ library, imageGenerator: splashscreen, logger }) : undefined;
  // Runtimes without application paths have no persistent AggregateFolder.
  // Their query/session services remain usable without directory monitoring.
  const libraryMonitorHost = programDataPath && libraryScanHost && ignoreRule ? new LibraryMonitorHost({ store, library, itemCreation,
    scanHost: libraryScanHost, metadata, metadataScanner, fileSystem, vfs, identityMap,
    scheduler: libraryTaskScheduler, logger }) : undefined;
  const libraryMonitor = libraryMonitorHost ? new LibraryDirectoryMonitor({ host: libraryMonitorHost,
    get configuration() { return currentConfiguration(); }, ignoreRule, logger, runBackground: operation => store.runDetached(() => loadContext.withDetachedScope(operation)) }) : undefined;
  if (libraryMonitor) {
    rollback.push(() => libraryMonitor.close());
    metadata.queuedRefresh = (reference, options) => store.runDetached(() => loadContext.withDetachedScope(
      () => libraryMonitorHost.refreshQueuedItem(reference, options)));
    metadata.runQueuedBatch = (operation, options) => store.runDetached(() => loadContext.withDetachedScope(
      () => libraryMonitorHost.runQueuedBatch(operation, options)));
    metadata.saver.monitor = libraryMonitor;
    metadataUpdates.monitor = libraryMonitor;
    metadataImages.monitor = libraryMonitor;
  }
  const libraryScanLifecycle = libraryMonitor ? new LibraryScanLifecycle({ host: libraryScanHost,
    monitor: libraryMonitor, postScanTasks: [splashscreenPostScanTask, artistsPostScanTask, collectionPosterVerifyPostScanTask, genresPostScanTask, musicGenresPostScanTask, studiosPostScanTask, cleanDatabasePostScanTask], logger }) : undefined;
  const libraryScanner = libraryScanLifecycle ? new LibraryScanService({ lifecycle: libraryScanLifecycle, onError }) : undefined;
  if (libraryScanner) rollback.push(() => libraryScanner.close());
  const tasks = new ScheduledTaskManager({ scanner: libraryScanner, localization, onError, programDataPath, configurationDirectoryPath, dataPath });
  await plugins.bind('task', extension => tasks.register(extension));
  rollback.push(() => tasks.close());
  const libraryConfiguration = libraryScanLifecycle && libraryOptionsStore ? new LibraryConfigurationService({ fileSystem,
    programDataPath, optionsStore: libraryOptionsStore, get configuration() { return currentConfiguration(); }, configurationStore,
    mediaAssets: new MetadataImageAssets({ fileSystem, vfs, identityMap, get metadataPath() { return applicationPaths.metadataPath; }, stateRoots: [dataPath].filter(Boolean) }),
    lifecycle: libraryScanLifecycle, monitor: libraryMonitor, host: libraryScanHost, refreshes,
    refreshQueue: () => metadata.getRefreshQueue(),
    admitMetadataDrain: () => metadata.admitShutdownDrain(),
    runBackground: operation => store.runDetached(() => loadContext.withDetachedScope(operation)),
    queueLibraryScan: () => { void tasks.queueScheduled(refreshLibraryTaskId).catch(onError); }, onError
  }) : undefined;
  if (libraryConfiguration) { rollback.push(() => libraryConfiguration.close()); await deferUnavailable(()=>libraryConfiguration.initialize()); }
  library.configuration = libraryConfiguration;
  const liveTvRecordingFolders = libraryConfiguration && dataPath ? new LiveTvRecordingFolders({ liveTv, libraryConfiguration,
    mediaAssets: libraryConfiguration.mediaAssets, dataPath,
    runBackground: operation => store.runDetached(() => loadContext.withDetachedScope(operation)),
    queueLibraryScan: () => { void tasks.queueScheduled(refreshLibraryTaskId).catch(onError); }, onError
  }) : undefined;
  const liveTvRecordings = dataPath ? new LiveTvRecordingsService({ liveTv, library, dataPath,
    mediaAssets: libraryConfiguration?.mediaAssets
      ?? new MetadataImageAssets({ fileSystem, vfs, identityMap, get metadataPath() { return applicationPaths.metadataPath; }, stateRoots: [dataPath] }) }) : undefined;
  liveTvRecordingFolders?.start();
  if (liveTvRecordingFolders) rollback.push(() => liveTvRecordingFolders.close());
  let liveTvSources, liveTvTuners, liveTvGuideImages, liveTvGuide, liveTvCountries, guideTaskConfiguration;
  if (liveTvRecordingFolders && applicationPaths.cachePath && loadContext && itemCreation && itemDeletion && metadataScanner) {
    liveTvCountries = new LiveTvCountriesClient({ get cachePath() { return applicationPaths.cachePath; }, userAgent: `MediaManager/${serverVersion}` });
    rollback.push(() => liveTvCountries.close());
    await liveTvCountries.initialize();
    liveTvSources = new LiveTvSourcesService({ liveTv, plugins, fileSystem, get cachePath() { return applicationPaths.cachePath; }, onError,
      getCulture: () => localization.context.culture,
      getSchedulesDirectCountries: () => liveTvCountries.getCountries(),
      refreshGuide: () => { void tasks.cancelIfRunningAndQueue(refreshGuideTaskId).catch(error => {
        if (error.code !== 'cancelled') onError?.(error);
      }); } });
    rollback.push(() => liveTvSources.close());
    liveTvTuners = new LiveTvTunerService({ plugins, sources: liveTvSources, onError });
    rollback.push(() => liveTvTuners.close());
    liveTvMediaSources = new LiveTvMediaSources({ tuners: liveTvTuners, library, onError,
      getLocalApiUrl: () => network.getLocalApiUrl('127.0.0.1') });
    rollback.push(() => liveTvMediaSources.close());
    liveStreamProbe = new LiveStreamProbe({ get cachePath() { return applicationPaths.cachePath; }, mediaEncoder, probeOptions, onError,
      probeFile: async (source, options) => {
        if (!probe) throw libraryError(503, 'Mapped live media probing is unavailable.');
        const location = playback.accessPath({ Id: source.Id, Path: source.Path }, source.Path, false);
        const result = await probeRaw(probe.bridge, location, options);
        const information = normalizeProbe(result.raw, { path: source.Path, protocol: source.Protocol, videoType: source.VideoType ?? null, isAudio: false });
        for (const stream of information.MediaStreams) localizeMediaStream(stream, { culture: 'en-US' });
        return information;
      } });
    rollback.push(() => liveStreamProbe.close());
    liveStreams = new LiveStreamsService({ tuners: liveTvTuners, library, probe: liveStreamProbe, onError,
      getLocalApiUrl: () => {
        const scheme = networkHost.listenWithHttps ? 'https' : 'http';
        const address = network.getBindAddress(null, { skipOverrides: true }).address;
        const host = address.replace(/^\[|\]$/gu, '');
        const listeners = networkHost.listeners.filter(entry => entry.scheme === scheme && entry.server.listening);
        const listener = listeners.find(entry => entry.address === host)
          ?? listeners.find(entry => entry.address === '::' || entry.address === '0.0.0.0' && !host.includes(':'))
          ?? listeners[0];
        const target = listener && !['0.0.0.0', '::'].includes(listener.address) ? listener.address : address;
        return network.getLocalApiUrl(target, { scheme, port: listener?.port });
      } });
    rollback.push(() => liveStreams.close());
    sessions.liveStreams = liveStreams;
    liveTvGuideImages = new LiveTvGuideImages({ store, linkedChildren, loadContext, itemCreation, updates: metadataUpdates,
      images: metadataImages, isImageDailyLimitActive: () => liveTvCountries.isImageDailyLimitActive(), onError,
      runWorker: operation => store.runChild(() => loadContext.withDetachedScope(operation)) });
    rollback.push(() => liveTvGuideImages.close());
    const guideServices = () => [liveTvTuners];
    liveTvGuide = new LiveTvGuideService({ liveTv, services: guideServices, recordingFolders: liveTvRecordingFolders,
      sources: liveTvSources, library, store, itemCreation, itemDeletion, linkedChildren, loadContext,
      updates: metadataUpdates, metadataScanner, images: liveTvGuideImages,
      metadataAssets: new MetadataImageAssets({ fileSystem, vfs: metadataVfs, identityMap: metadataIdentityMap,
        get metadataPath() { return applicationPaths.metadataPath; } }), onError });
    rollback.push(() => liveTvGuide.close());
    // Task DTOs and ordered event publication may read configuration after
    // shutdown freezes new configuration admission. The task owner retains a
    // live read capability, with no second cache, until all task work drains.
    guideTaskConfiguration = liveTv.admitRead();
    rollback.push(async () => { try { await tasks.close(); } finally { guideTaskConfiguration.release(); } });
    await tasks.register({ create: options => new RefreshGuideTaskWorker({ ...options,
      getGuideServiceCount: () => guideServices().length,
      getGuideConfiguration: () => guideTaskConfiguration.getConfiguration(),
      refreshGuide: options => liveTvGuide.refresh(options) }) });
  }
  const collectionServices = libraryConfiguration && itemCreation && metadataUpdates ? createCollectionRuntimeServices({ fileSystem,
    store, library, itemCreation, loadContext, updates: metadataUpdates, metadata, host: libraryScanHost,
    libraryConfiguration, monitor: libraryMonitor, programDataPath, dataPath, localization, linkedChildren, logger, onError
  }) : {};
  const { collections, collectionPostScanTask } = collectionServices;
  if (collectionPostScanTask) libraryScanLifecycle.postScanTasks.splice(
    libraryScanLifecycle.postScanTasks.indexOf(collectionPosterVerifyPostScanTask) + 1, 0, collectionPostScanTask);
  if (collections) rollback.push(() => collections.close());
  const images = new ImageService({ fileSystem, store, library, vfs, identityMap:metadataIdentityMap, mediaIdentityMap:identityMap, processor: imageProcessor, metadataImages, metadataUpdates, loadContext,
    get metadataPath() { return applicationPaths.metadataPath; }, logger,
    userImagePath: imageOptions.userImagePath ?? (configurationDirectoryPath && path.join(configurationDirectoryPath, 'users')) });
  library.options.getImageDimensions = (item, image) => images.getImageDimensions(item, image);
  rollback.push(() => images.close());
  const brandingStore = new BrandingConfigurationStore({ configurationDirectoryPath, onError });
  rollback.push(() => brandingStore.close());
  await brandingStore.initialize();
  const branding = new BrandingService({ configurationStore: brandingStore, images, dataPath,
    assets: new MetadataImageAssets({ fileSystem, vfs, identityMap:metadataIdentityMap, get metadataPath() { return applicationPaths.metadataPath; },
      stateRoots: [dataPath, programDataPath && path.join(programDataPath, 'cache')].filter(Boolean) }) });
  rollback.push(() => branding.close());
  metadataUpdates ??= images.metadataUpdates;
  const userViews = new UserViewService({ fileSystem, library, users, updates: metadataUpdates, metadata, images: metadataImages, refreshes });
  library.userViews = userViews;
  const metadataEditor = new MetadataEditorService({ library, get configuration() { return currentConfiguration(); }, configurationStore, localization });
  rollback.push(() => metadataEditor.close());
  const itemUpdates = new MetadataEditService({ library, loadContext, updates: metadataUpdates, refreshes: metadata });
  rollback.push(() => itemUpdates.close());
  const stopBeforeStorageObserver = configuredStorage.subscribeBeforeChange(() => libraryMonitor?.stop());
  const stopAfterStorageObserver = configuredStorage.subscribe(async () => {
    storageReadiness.ready = false; storageReadiness.error = null;
    await deferUnavailable(() => configurationStore?.initialize());
    storageReadiness.ready = await deferUnavailable(async () => {
      await initializeStorageRoots();
      if (libraryOptionsStore) await loadLibraryOptions(database, { fileSystem, programDataPath, dataPath, metadataPath: applicationPaths.metadataPath, onError, optionsStore: libraryOptionsStore });
      await libraryOptionsStore?.clear();
      await libraryConfiguration?.initialize();
    });
    if (storageReadiness.ready) await libraryMonitor?.start();
  });
  const stopStorageObserver = () => { stopBeforeStorageObserver(); stopAfterStorageObserver(); };
  rollback.push(stopStorageObserver);
  const services = { storage: configuredStorage, storageReadiness, fileSystem, get configuration() { return currentConfiguration(); }, get networkConfiguration() { return getNetworkConfiguration(); }, getNetworkConfiguration, getSmartApiUrl, network, baseUrl, publicAddress, store, activities, users, devices, library, itemCreation, itemDeletion, unsafeItemDeletion, folderValidation, linkedChildReferences, playlists, topLevelValidation, libraryScanHost, libraryScanLifecycle, libraryScanner, metadataScanner, artistsPostScanTask, genresPostScanTask, musicGenresPostScanTask, studiosPostScanTask, tasks, userData, sessions, syncPlay, refreshes, authentication, localization, playback, probe, externalData, extraction, remux, hls, images, imageProcessor, metadata, metadataUpdates, resolvedItemLifecycle, metadataEditor, itemUpdates, plugins, similarItems, ignoreRule, serverId, serverName, serverVersion };
  services.collectionPosterVerifyPostScanTask = collectionPosterVerifyPostScanTask;
  services.channels = channels;
  services.liveTv = liveTv;
  services.liveTvTimers = liveTvTimers;
  services.liveTvRecordings = liveTvRecordings;
  services.liveTvRecordingFolders = liveTvRecordingFolders;
  services.liveTvSources = liveTvSources;
  services.liveTvTuners = liveTvTuners;
  services.liveTvMediaSources = liveTvMediaSources;
  services.liveStreams = liveStreams;
  services.liveStreamProbe = liveStreamProbe;
  services.liveTvGuide = liveTvGuide;
  services.liveTvGuideImages = liveTvGuideImages;
  services.liveTvCountries = liveTvCountries;
  services.cleanDatabasePostScanTask = cleanDatabasePostScanTask;
  services.splashscreen = splashscreen;
  services.branding = branding;
  services.libraryOptionsStore = libraryOptionsStore;
  services.libraryConfiguration = libraryConfiguration;
  services.collections = collections;
  services.collectionPostScanTask = collectionPostScanTask;
  services.linkedChildren = linkedChildren;
  services.runWithContext = loadContext && (operation => loadContext.withScope(operation));
  // Event delivery outlives its producer. Give notifier SQL and metadata work
  // their own scopes before timers or immediate batch sends can inherit a
  // request's read-only transaction, writer connection or release boundary.
  services.runBackground = operation => store.runDetached(() => loadContext
    ? loadContext.withDetachedScope(operation) : operation());
  services.libraryMonitor = libraryMonitor;
  services.libraryMonitorHost = libraryMonitorHost;
  services.libraryTaskScheduler = libraryTaskScheduler;
  services.quickConnect = quickConnect;
  services.passwordResets = passwordResets;
  services.displayPreferences = displayPreferences;
  services.startup = startup;
  services.apiKeys = apiKeys;
  services.splashscreenPostScanTask = splashscreenPostScanTask;
  services.configurationStore = configurationStore;
  services.namedConfiguration = namedConfiguration;
  services.mediaEncoder = mediaEncoder;
  services.encodingPaths = encodingPaths;
  services.fallbackFonts = fallbackFonts;
  services.applicationPaths = applicationPaths;
  services.networkHost = networkHost;
  services.systemLifecycle = systemLifecycle;
  await plugins.connect({ ...services, get configuration() { return currentConfiguration(); }, vfs, identityMap, metadataVfs, metadataIdentityMap, loadContext, seriesLifecycle, metadataImages, spoolRoot, fileSystem });
  application = await createApplication({ ...services, get configuration() { return currentConfiguration(); }, onError });
  rollback.push(async () => { application.beginClose(); await application.drainRequests(); });
  if (application.webSockets) rollback.push(() => application.webSockets.close());
  let autoDiscovery;
  if (autoDiscoveryOptions !== undefined) {
    if (!autoDiscoveryOptions || typeof autoDiscoveryOptions !== 'object' || Array.isArray(autoDiscoveryOptions)) {
      throw new TypeError('autoDiscoveryOptions must be an object.');
    }
    const { resolveAddress, publishedUrl, ...serviceOptions } = autoDiscoveryOptions;
    autoDiscovery = new AutoDiscoveryService({
      ...serviceOptions,
      enabled: serviceOptions.enabled ?? getNetworkConfiguration().AutoDiscovery,
      serverId,
      serverName,
      resolveAddress: resolveAddress ?? (remote => network.getApiUrlForAddress(remote.address)),
      onError
    });
    services.autoDiscovery = autoDiscovery;
    Object.defineProperty(autoDiscovery, 'serverName', { get: () => serverFriendlyName(currentConfiguration(), serverName) });
    rollback.push(() => autoDiscovery.close());
  }
  let discoveryStart;
  const startAutoDiscovery = async () => {
    if (!networkHost.listeners.some(entry => entry.server.listening)) {
      const error = new Error('HTTP server must be listening before UDP auto-discovery starts.');
      error.code = 'ERR_HTTP_SERVER_NOT_LISTENING';
      throw error;
    }
    if (!autoDiscovery) return null;
    return discoveryStart ??= (() => {
      autoDiscovery.enabled = autoDiscoveryOptions.enabled ?? getNetworkConfiguration().AutoDiscovery;
      return autoDiscovery.start();
    })();
  };
  let closing, starting, startupReady;
  const startupPrepared = Promise.withResolvers();
  let wizardCompleted = Boolean(currentConfiguration().IsStartupWizardCompleted);
  const configurationUpdateWork = new Set();
  const configurationUpdated = () => {
    const next = Boolean(currentConfiguration().IsStartupWizardCompleted), changed = next !== wizardCompleted;
    wizardCompleted = next;
    if (changed) {
      const work = services.runBackground(() => tasks.queueScheduled(refreshLibraryTaskId)).catch(error => {
        if (error.code === 'cancelled') return;
        onError?.(error);
      });
      configurationUpdateWork.add(work);
      void work.finally(() => configurationUpdateWork.delete(work)).catch(() => {});
    }
  };
  configurationStore?.on('updated', configurationUpdated);
  rollback.push(() => configurationStore?.off('updated', configurationUpdated));
  const close = () => closing ??= (async () => {
      const errors = [];
      const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
      application.beginClose();
      playback.beginClose();
      // Keep the listeners available for shutdown responses until admitted
      // requests drain. Only an unfinished startup needs cancellation now.
      if (!startupReady) networkHost.beginClose();
      // Release a held FFmpeg version process before waiting for startup.
      // A save already handed to configuration still drains below.
      const mediaEncoderClosing = attempt(() => mediaEncoder.close());
      if (starting && !startupReady) await startupPrepared.promise;
      const pluginMutationsClosing = attempt(() => plugins.beginClose());
      const fallbackFontsClosing = attempt(() => fallbackFonts.close());
      application.webSockets?.beginClose();
      sessions.beginClose();
      const channelsClosing = channels.close();
      const guideClosing = liveTvGuide?.close();
      // An admitted guide can still reach its token-independent image phase
      // after a program COMMIT. Keep that dependency admitted until guide drain.
      const guideImagesClosing = Promise.allSettled([guideClosing]).then(() => liveTvGuideImages?.close());
      const publicStreamsClosing = liveStreams?.close();
      const liveProbeClosing = Promise.allSettled([publicStreamsClosing]).then(() => liveStreamProbe?.close());
      const mediaSourcesClosing = Promise.allSettled([publicStreamsClosing]).then(() => liveTvMediaSources?.close());
      const tunerClosing = Promise.allSettled([mediaSourcesClosing]).then(() => liveTvTuners?.close());
      const sourcesClosing = liveTvSources?.close();
      // A poisoned mutation owner can reject immediately. Attach the aggregate
      // handler before another close phase yields so the fatal remains part of
      // this runtime close instead of becoming an unhandled rejection.
      const timerMutationsClosing = attempt(() => liveTvTimers.close());
      // Freeze save admission before cancelling metadata. Each already queued
      // save synchronously reserved its recording-folder dependencies; those
      // reservations can finish their own reads and follow-up saves.
      const liveTvClosing = attempt(() => liveTv.close());
      // Reject new Collection/configuration calls synchronously. Admitted
      // mutations and recording-folder updates already own configuration and
      // metadata permits, which remain valid while their dependencies drain.
      const collectionsClosing = collections?.close();
      const libraryConfigurationClosing = libraryConfiguration?.close();
      // Reject new key operations in the synchronous admission phase. An
      // admitted writer can still be awaiting its caller while recording
      // folders drain; accepting another writer here can form a wait cycle.
      const apiKeysClosing = attempt(() => apiKeys.close());
      // Reject new setup work before the first asynchronous drain while
      // admitted user/password changes keep their database dependencies.
      const startupClosing = attempt(() => startup.close());
      const metadataEditorClosing = attempt(() => metadataEditor.close());
      // Stop authentication/reset admission before any asynchronous drain.
      // Already admitted operations retain their user and database dependencies
      // until these promises settle in the owner drain below.
      const quickConnectClosing = attempt(() => quickConnect.close());
      const passwordResetsClosing = attempt(() => passwordResets.close());
      introProviders.close();
      stopStorageObserver();
      // A scheduler worker can be awaiting a metadata provider's cancellation.
      // Signal it before waiting for any scan owner; savers and SQL ownership
      // remain available until those operations have completed their cleanup.
      cancelMetadata();
      // Cancel scan execution before waiting for any admitted producer. The
      // library task keeps its queue handoff open until the last configuration
      // save and updated callback have completed; new generations are owned
      // shutdown cancellations, with their real task history still persisted.
      const taskCancellation = attempt(() => tasks.cancelForShutdown());
      const scannerCancellation = attempt(() => libraryScanner?.beginClose());
      // Each admitted recording-folder update retains its configuration and
      // metadata permit. Drain it before closing the owners it still uses.
      await attempt(() => liveTvRecordingFolders?.close());
      // Signal every scan owner before awaiting any of them. A scheduled task
      // may wait behind a library generation which itself waits behind an
      // older folder scan; each owner must receive cancellation to release the
      // next layer of that dependency chain.
      await Promise.all([
        quickConnectClosing,
        passwordResetsClosing,
        attempt(() => displayPreferences.close()),
        startupClosing,
        apiKeysClosing,
        attempt(() => splashscreen?.close()),
        attempt(() => branding.close()),
        attempt(() => collectionsClosing),
        attempt(() => libraryConfigurationClosing),
        attempt(() => libraryMonitor?.close()),
        taskCancellation,
        scannerCancellation,
        attempt(() => guideClosing),
        attempt(() => guideImagesClosing),
        attempt(() => tunerClosing),
        attempt(() => mediaSourcesClosing),
        attempt(() => publicStreamsClosing),
        attempt(() => liveProbeClosing),
        attempt(() => sourcesClosing),
        timerMutationsClosing,
        attempt(() => channelsClosing),
        attempt(async () => {
          await Promise.allSettled([guideClosing, guideImagesClosing, sourcesClosing]);
          await liveTvCountries?.close();
        }),
        attempt(() => playlists?.close()),
        metadataEditorClosing,
        attempt(() => itemUpdates.close()),
        attempt(() => bookArchives.close())
      ]);
      await fallbackFontsClosing;
      await attempt(() => application.drainRequests());
      await attempt(() => playback.drainSubtitlePreparations());
      await pluginMutationsClosing;
      // Every admitted HTTP/setup/library/editor producer has now reached its
      // final configuration write. Keep the scheduler and its SQL/metadata
      // dependencies available until all saved updated events have handed off.
      await attempt(() => namedConfiguration?.close());
      await attempt(() => configurationStore?.close());
      networkHost.detachConfiguration();
      await attempt(() => network.close());
      configurationStore?.off('updated', configurationUpdated);
      await attempt(() => tasks.drainShutdown());
      await attempt(async () => {
        while (configurationUpdateWork.size) await Promise.all([...configurationUpdateWork]);
      });
      await attempt(() => application.webSockets?.close());
      await Promise.all([
        attempt(async () => { try { await tasks.close(); } finally { guideTaskConfiguration?.release(); } }),
        attempt(() => libraryScanner?.close())
      ]);
      // The Guide task's admitted configuration reader is released only after
      // its final DTO/event publication, allowing named configuration to drain.
      await liveTvClosing;
      await attempt(() => libraryTaskScheduler?.close());
      await attempt(() => metadata?.saver.stop());
      await attempt(() => metadata?.close());
      await attempt(() => metadata?.saver.dispose());
      await attempt(() => libraryOptionsStore?.close());
      await attempt(() => libraryScanHost?.close());
      await attempt(() => itemCreation?.close());
      await attempt(() => library.close());
      await attempt(() => syncPlay.close());
      await attempt(() => autoDiscovery?.close());

      await attempt(() => hls?.close());
      await attempt(() => images.close());
      await attempt(() => imageProcessor.close());
      await attempt(() => extraction?.close());
      await attempt(() => remux?.close());
      await attempt(() => networkHost.close());
      await attempt(() => probe?.close());
      await mediaEncoderClosing;
      await attempt(() => sessions.close());
      await attempt(() => plugins.close());
      await attempt(() => activities.close());
      await attempt(() => configuredStorage.close());
      await attempt(() => linkedChildren.flushReleases());
      await attempt(() => linkedChildren.close());
      await attempt(() => store.close());
      if (errors.length) throw new AggregateError(errors, 'The runtime could not close every resource.');
    })();
  const start = () => {
    if (closing) return Promise.reject(Object.assign(new Error('The runtime is closing.'), { code: 'closed', status: 503 }));
    return starting ??= (async () => {
      let failure;
      try {
        // FindParts authorizes the captured ports before Kestrel starts. AppHost
        // configuration consumers are registered by NetworkHost after bind.
        if (!currentConfiguration().IsPortAuthorized) {
          currentConfiguration().IsPortAuthorized = true;
          await configurationStore?.saveConfiguration();
        }
        await networkHost.start(application);
        await startAutoDiscovery();
        if (!await mediaEncoder.initialize()) throw new Error('Failed to find valid ffmpeg.');
        networkHost.signal.throwIfAborted();
        if (storageReadiness.ready) await libraryMonitor?.start();
        await tasks.initialize();
        if (storageReadiness.ready) await liveTvRecordingFolders?.reconcile();
        networkHost.completeStartup();
        startupReady = true;
        return networkHost.listeners;
      } catch (error) { failure = error; }
      finally { startupPrepared.resolve(); }
      try { await close(); }
      catch (cleanup) { throw new AggregateError([failure, cleanup], 'Runtime startup and cleanup failed.', { cause: failure }); }
      throw failure;
    })();
  };
  rollback.length = 0;
  return { ...application, ...services, get configuration() { return currentConfiguration(); }, get networkConfiguration() { return getNetworkConfiguration(); }, get implementedRoutes() { return application.implementedRoutes; }, start, startAutoDiscovery, close };
  } catch (error) {
    const errors = [error];
    // Late initialization may already have admitted a provider through the
    // shared scheduler. Cancel before any rollback owner waits for that work.
    try { cancelMetadata(); } catch (cancelError) { errors.push(cancelError); }
    try { await splashscreen?.close(); } catch (closeError) { errors.push(closeError); }
    for (const dispose of rollback.reverse()) {
      try { await dispose(); }
      catch (closeError) { errors.push(closeError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Runtime construction and cleanup failed.');
    throw error;
  }
}
