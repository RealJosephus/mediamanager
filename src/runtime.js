import { PluginHost } from './plugins/host.js';
import { LibraryTaskScheduler } from './library/library-task-scheduler.js';
import { createConfiguredStorage } from './storage-bootstrap.js';
import { DomainStore } from './database/domain-store.js';
import { UserService, AuthenticationService, ApiKeyService, DeviceService, QuickConnectService, PasswordResetService, createNetworkClassifier } from './users/index.js';
import { createAudioBookItemResolver, createAudioItemResolver, createBookItemResolver, createBoxSetItemResolver, createPhotoAlbumResolver, createPhotoItemResolver, createPlaylistItemResolver, createTvItemResolver, createVideoFileResolver, DirectoryItemResolverPipeline, FolderScanService, FolderValidationService, InertLibraryDirectoryMonitor, ItemCreationService, ItemDeletionService, LibraryMetadataScanService, LibraryScanHost, LibraryScanLifecycle, LibraryScanService, LibraryService, LinkedChildReferenceService, MusicGenresPostScanTask, PlaylistService, ResolvedItemLifecycleHost, SimilarItemsManager, TopLevelFolderValidationService } from './library/index.js';
import { SessionService, UserDataService } from './sessions/index.js';
import { createApplication } from './http/application.js';
import { createCoreLocalization } from './core/i18n.js';
import { loadLibraryOptions, createVirtualPathExpander } from './library/options.js';
import { PlaybackService } from './playback/service.js';
import { ProbeService } from './library/probe-service.js';
import { ExternalDataManager } from './library/external-data.js';
import { UnsafeItemDeletionService } from './library/unsafe-item-deletion-service.js';
import { GenresPostScanTask, StudiosPostScanTask } from './library/by-name-post-scan-task.js';
import { ArtistsPostScanTask } from './library/artists-post-scan-task.js';
import { CollectionPosterVerifyPostScanTask } from './library/collection-poster-post-scan-task.js';
import { createCollectionRuntimeServices } from './library/collection-runtime-services.js';
import { PostgresLinkedChildrenStore } from './library/postgres-linked-children.js';
import { publishNativeItemLinks } from './library/native-item-entity.js';
import { CleanDatabasePostScanTask } from './library/clean-database-post-scan-task.js';
import { SplashscreenPostScanTask } from './library/splashscreen-post-scan-task.js';
import { ExtractionService } from './playback/extraction.js';
import { RemuxService } from './playback/remux.js';
import path from 'node:path';
import { HlsService } from './playback/hls.js';
import { ImageProcessor } from './images/processor.js';
import { ImageService } from './images/service.js';
import { SplashscreenImageGenerator } from './images/splashscreen.js';
import { MetadataImageAssets } from './metadata/image-assets.js';
import { MetadataImages } from './metadata/images.js';
import { MetadataUpdateHost } from './metadata/update-host.js';
import { MetadataRegistry, MetadataSaveHost, MetadataRefreshHost, ProviderRefreshService, SeriesMetadataLifecycleHost, createLocalXmlPlugin, createMetadataContextLoader, createPlaylistItemsPlugin } from './metadata/index.js';
import { loadMetadataConfiguration } from './metadata/configuration-loader.js';
import { loadExternalUrlConfiguration } from './library/external-urls.js';
import { loadEncodingConfiguration, serverFriendlyName } from './configuration.js';
import { createBuiltinExternalUrlPlugin } from './metadata/external-url-providers.js';
import { SyncPlayService } from './syncplay/service.js';
import { UserViewService } from './library/user-view-service.js';
import { initializeLibraryRoot } from './library/root-initialization.js';
import { ScheduledTaskManager } from './tasks/index.js';
import { AutoDiscoveryService, createDiscoveryAddressResolver } from './network/auto-discovery.js';
import { MetadataEditorService } from './metadata/editor-service.js';
import { MetadataEditService } from './metadata/edit-service.js';
import { ServerConfigurationStore } from './core/server-configuration-store.js';
import { DotIgnoreRule } from './library/dot-ignore-rule.js';
import { BrandingConfigurationStore } from './branding/configuration.js';
import { BrandingService } from './branding/service.js';
import { LibraryOptionsStore } from './library/library-options-store.js';
import { LibraryConfigurationService } from './library/library-configuration-service.js';
import { refreshLibraryTaskId } from './tasks/refresh-library-task.js';
import { DisplayPreferencesService } from './users/display-preferences-service.js';
import { StartupService } from './users/startup-service.js';

function absoluteApplicationPath(value, name) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

export async function createRuntime({ database, configuration, serverId, serverName = configuration?.ServerName || 'MediaManager', serverVersion = '13.0.0',
  programDataPath, configurationDirectoryPath, dataPath, metadataPath, libraryOptions, directoryItemResolvers,
  pluginOptions = {}, storageConfiguration, environment, portableMountContract,
  vfs, identityMap, ignoreIdentityMap = identityMap, probeOptions, extractionOptions, remuxOptions, hlsOptions, imageOptions = {}, metadataOptions = {}, onError,
  autoDiscoveryOptions, onDatabaseOwnershipTransferred } = {}) {
  programDataPath = absoluteApplicationPath(programDataPath, 'programDataPath');
  configurationDirectoryPath = absoluteApplicationPath(configurationDirectoryPath, 'configurationDirectoryPath');
  dataPath = absoluteApplicationPath(dataPath, 'dataPath');
  metadataPath = absoluteApplicationPath(metadataPath, 'metadataPath');
  const rollback = [];
  let splashscreen;
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
  plugins = await PluginHost.open({ programDataPath, configurationDirectoryPath, dataPath, metadataPath, cachePath: imageOptions.cachePath, onError, ...pluginOptions });
  rollback.push(() => plugins.close());
  configuredStorage = await createConfiguredStorage(storageConfiguration, { plugins, environment, portableMountContract });
  fileSystem = configuredStorage.fileSystem;
  const usesConfiguredStorage=Boolean(storageConfiguration || !vfs);
  if (usesConfiguredStorage) ({ vfs, identityMap, ignoreIdentityMap } = configuredStorage);
  const metadataVfs=usesConfiguredStorage?configuredStorage.metadataVfs:vfs;
  const metadataIdentityMap=usesConfiguredStorage?configuredStorage.metadataIdentityMap:identityMap;
  rollback.push(() => configuredStorage.close());
  metadataPath ??= programDataPath && path.join(programDataPath, 'metadata');
  const configurationStore = configurationDirectoryPath ? new ServerConfigurationStore({ configuration, configurationDirectoryPath }) : undefined;
  if (configurationStore) rollback.push(() => configurationStore.close());
  const localization = await createCoreLocalization({ serverCulture: configuration.UICulture || 'en-US' });
  const isLocalNetwork = createNetworkClassifier(configuration.NetworkConfiguration ?? {});
  const users = new UserService({ store, serverId, isLocalNetwork, castReceiverApplications: configuration.CastReceiverApplications ?? [] });
  const startup = new StartupService({ users, configuration, configurationStore });
  rollback.push(() => startup.close());
  const displayPreferences = new DisplayPreferencesService({ store, onError });
  rollback.push(() => displayPreferences.close());
  const storageReadiness = { ready: false, error: null };
  const unavailableStorage = error => ['ENOTSUP','not-supported','unmapped-path'].includes(error?.code);
  const deferUnavailable = async operation => {
    try { await operation(); return true; }
    catch (error) { if (!unavailableStorage(error)) throw error; storageReadiness.error=error.message; onError?.(error); return false; }
  };
  // A VFS-only runtime can explicitly own metadata state without a data path.
  const spoolStateRoot = dataPath ?? metadataPath;
  const spoolRoot = spoolStateRoot && path.join(spoolStateRoot, 'metadata-spool');
  fileSystem.spoolRoot = spoolRoot;
  const initializeStorageRoots = async () => {
    await initializeLibraryRoot({ fileSystem, store, programDataPath, dataPath, metadataPath, configuration });
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
  const libraryOptionsStore = programDataPath ? new LibraryOptionsStore({ fileSystem, programDataPath, dataPath, metadataPath,
    ...(libraryOptions && { optionsById: libraryOptions }), onError }) : undefined;
  if (libraryOptionsStore) rollback.push(() => libraryOptionsStore.close());
  if (!libraryOptions) {
    await deferUnavailable(async () => { libraryOptions = await loadLibraryOptions(database, { fileSystem, programDataPath, dataPath, metadataPath, onError, optionsStore: libraryOptionsStore }); });
    libraryOptions ??= libraryOptionsStore?.optionsById ?? new Map();
  }
  const expandPath = programDataPath ? createVirtualPathExpander({ programDataPath, dataPath, metadataPath }) : undefined;
  const externalUrlConfiguration = await loadExternalUrlConfiguration({ programDataPath, onError });
  const library = new LibraryService({ fileSystem, store, linkedChildren, serverId, programDataPath, dataPath, metadataPath, configuration, libraryOptions, localization, expandPath, logger, onError, ...externalUrlConfiguration });
  rollback.push(() => library.close());
  const playlists = programDataPath && dataPath
    ? new PlaylistService({ fileSystem, store, library, linkedChildren, spoolRoot, programDataPath, dataPath, configuration, vfs, identityMap, onError,
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
      queueExternalRefresh: playlist => store.enqueue(() => metadata?.queue(playlist.Id, { ForceSave: true }, 0)) })
    : undefined;
  if (playlists) rollback.push(() => playlists.close());
  const userData = new UserDataService({ store, library, users, configuration });
  const sessions = new SessionService({ store, library, userData, users, serverId, configuration, onError });
  rollback.push(() => sessions.close());
  const syncPlay = new SyncPlayService({ sessions, users, library, onError });
  rollback.push(() => syncPlay.close());
  const devices = new DeviceService({ store, users, sessions });
  const refreshes = new ProviderRefreshService({ onError });
  const resolverPipeline = vfs && identityMap && programDataPath ? new DirectoryItemResolverPipeline({
    resolvers: directoryItemResolvers ?? [createPlaylistItemResolver(), createBoxSetItemResolver(),
      createBookItemResolver(), createPhotoItemResolver(), createPhotoAlbumResolver(),
      createTvItemResolver(), createAudioItemResolver(), createVideoFileResolver({ localization }),
      createAudioBookItemResolver()],
    programDataPath,
    configuration,
    onError
  }) : undefined;
  const authentication = new AuthenticationService({ store, users, sessions, serverId, serverName, serverVersion,
    isLocalNetwork, enableLegacyAuthorization: configuration.EnableLegacyAuthorization ?? false });
  Object.defineProperty(authentication, 'serverName', { get: () => serverFriendlyName(configuration, serverName) });
  const apiKeys = new ApiKeyService({ store });
  rollback.push(() => apiKeys.close());
  authentication.syncPlay = syncPlay;
  const quickConnect = new QuickConnectService({ configuration, authentication });
  rollback.push(() => quickConnect.close());
  const passwordResets = new PasswordResetService({ users, programDataPath });
  rollback.push(() => passwordResets.close());
  const externalData = new ExternalDataManager({ fileSystem, store, vfs, identityMap:metadataIdentityMap, dataPath, metadataPath, logger });
  const probe = vfs && identityMap ? new ProbeService({ store, vfs, identityMap, probeOptions, localization, library, externalData }) : undefined;
  if (probe) rollback.push(() => probe.close());
  const extraction = probe ? new ExtractionService({ vfs, bridge:probe.bridge, ...extractionOptions }) : undefined;
  if (extraction) rollback.push(() => extraction.close());
  const remux = probe ? new RemuxService({ vfs, bridge:probe.bridge, ...remuxOptions }) : undefined;
  if (remux) rollback.push(() => remux.close());
  const componentConfigurationPath = metadataOptions.configurationDirectoryPath ?? configurationDirectoryPath;
  const encodingOptions = await loadEncodingConfiguration({ programDataPath, configurationDirectoryPath: componentConfigurationPath, onError });
  const hls = probe ? new HlsService({ vfs, bridge: probe.bridge, remux, encodingOptions, onError, ...hlsOptions }) : undefined;
  if (hls) rollback.push(() => hls.close());
  sessions.hls = hls;
  const playback = new PlaybackService({ library, vfs, identityMap, sessions, configuration, serverVersion, isLocalNetwork, probe, extraction, remux, hls });
  const imageProcessor = new ImageProcessor({ fileSystem, cachePath: programDataPath && path.join(programDataPath, 'cache', 'images'), logger, ...imageOptions });
  rollback.push(() => imageProcessor.close());
  splashscreen = dataPath ? new SplashscreenImageGenerator({ dataPath, logger,
    assets: new MetadataImageAssets({ fileSystem, vfs, identityMap:metadataIdentityMap, metadataPath,
      stateRoots: [dataPath, ...(programDataPath ? [path.join(programDataPath, 'cache')] : [])] }) }) : undefined;
  if (splashscreen) rollback.push(() => splashscreen.close());
  const metadataImages = new MetadataImages({ processor: imageProcessor, logger });
  const metadataSettings = await loadMetadataConfiguration({ programDataPath, configurationDirectoryPath: componentConfigurationPath, onError });
  const similarItems = new SimilarItemsManager({ fileSystem, extensions: () => plugins.entries('similar'),
    cachePath: metadataOptions.similarCachePath ?? (programDataPath && path.join(programDataPath, 'cache')),
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
    library.options.externalUrlRegistry = registry;
    loadContext = createMetadataContextLoader({ fileSystem, store, library, linkedChildren, spoolRoot, vfs, identityMap, metadataIdentityMap, configuration, contextExtensions: () => plugins.entries('context'),
      metadataConfiguration: metadataOptions.metadataConfiguration ?? metadataSettings.metadata, ignoreRule, externalData, logger });
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
    rollback.push(() => metadata.close());
    Object.assign(metadata, { saver });
  }
  library.itemCreation = itemCreation;
  const linkedChildReferences = itemCreation && metadataUpdates
    ? new LinkedChildReferenceService({ store, linkedChildren, itemCreation, loadContext, updates: metadataUpdates })
    : undefined;
  const libraryTaskScheduler = loadContext ? new LibraryTaskScheduler({ configuration,
    runWorker: operation => store.runDetached(() => loadContext.withDetachedScope(operation)), onError }) : undefined;
  if (libraryTaskScheduler) rollback.push(() => libraryTaskScheduler.close());
  const metadataScanner = metadata ? new LibraryMetadataScanService({ library, metadata, configuration, logger, scheduler: libraryTaskScheduler }) : undefined;
  const folderValidation = itemCreation && resolverPipeline ? new FolderValidationService({ store, library, itemCreation,
    resolvedItemLifecycle, vfs, identityMap, ignoreRule, resolverPipeline, loadContext, programDataPath, configurationDirectoryPath,
    metadataConfiguration: metadataOptions.metadataConfiguration ?? metadataSettings.metadata, configuration, refreshes,
    linkedChildReferences, metadataScanner, scheduler: libraryTaskScheduler, onError }) : undefined;
  library.folderValidation = folderValidation;
  const itemDeletion = itemCreation ? new ItemDeletionService({ store, library, loadContext, itemCreation,
    updates: metadataUpdates, externalData, linkedChildReferences, vfs, metadataVfs, logger }) : undefined;
  library.itemDeletion = itemDeletion;
  const unsafeItemDeletion = itemCreation ? new UnsafeItemDeletionService({ store, library, itemCreation,
    externalData, vfs, identityMap, metadataIdentityMap, logger }) : undefined;
  library.unsafeItemDeletion = unsafeItemDeletion;
  const folderScanner = vfs && identityMap && programDataPath
    ? new FolderScanService({ store, library, vfs, identityMap, ignoreRule, refreshes, programDataPath, configuration, resolverPipeline, metadataScanner, resolvedItemLifecycle,
      linkedChildReferences,
      metadataConfiguration: metadataOptions.metadataConfiguration ?? metadataSettings.metadata, onError })
    : undefined;
  if (folderScanner) rollback.push(() => folderScanner.close());
  const topLevelValidation = itemCreation && loadContext ? new TopLevelFolderValidationService({ library, itemCreation, loadContext,
    metadataScanner, metadataConfiguration: metadataOptions.metadataConfiguration ?? metadataSettings.metadata,
    configuration, optionsStore: libraryOptionsStore }) : undefined;
  const libraryScanHost = topLevelValidation ? new LibraryScanHost({ store, library, itemCreation, metadataScanner,
    topLevelValidation, ignoreRule }) : undefined;
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
  const libraryMonitor = new InertLibraryDirectoryMonitor();
  const libraryScanLifecycle = libraryScanHost ? new LibraryScanLifecycle({ host: libraryScanHost,
    monitor: libraryMonitor, postScanTasks: [splashscreenPostScanTask, artistsPostScanTask, collectionPosterVerifyPostScanTask, genresPostScanTask, musicGenresPostScanTask, studiosPostScanTask, cleanDatabasePostScanTask], logger }) : undefined;
  const libraryScanner = folderScanner ? new LibraryScanService({ library, folderScanner,
    lifecycle: libraryScanLifecycle, onError }) : undefined;
  if (libraryScanner) rollback.push(() => libraryScanner.close());
  const tasks = new ScheduledTaskManager({ scanner: libraryScanner, localization, onError, programDataPath, configurationDirectoryPath, dataPath });
  await plugins.bind('task', extension => tasks.register(extension));
  rollback.push(() => tasks.close());
  const libraryConfiguration = libraryScanLifecycle && libraryOptionsStore ? new LibraryConfigurationService({ fileSystem,
    programDataPath, optionsStore: libraryOptionsStore, configuration, configurationStore,
    mediaAssets: new MetadataImageAssets({ fileSystem, vfs, identityMap, metadataPath, stateRoots: [dataPath].filter(Boolean) }),
    lifecycle: libraryScanLifecycle, monitor: libraryMonitor, host: libraryScanHost, refreshes,
    refreshQueue: () => metadata.getRefreshQueue(),
    runBackground: operation => store.runDetached(() => loadContext.withDetachedScope(operation)),
    queueLibraryScan: () => { void tasks.queueScheduled(refreshLibraryTaskId).catch(onError); }, onError
  }) : undefined;
  if (libraryConfiguration) { rollback.push(() => libraryConfiguration.close()); await deferUnavailable(()=>libraryConfiguration.initialize()); }
  library.configuration = libraryConfiguration;
  const collectionServices = libraryConfiguration && itemCreation && metadataUpdates ? createCollectionRuntimeServices({ fileSystem,
    store, library, itemCreation, loadContext, updates: metadataUpdates, metadata, host: libraryScanHost,
    libraryConfiguration, monitor: libraryMonitor, programDataPath, dataPath, localization, linkedChildren, logger, onError
  }) : {};
  const { collections, collectionPostScanTask } = collectionServices;
  if (collectionPostScanTask) libraryScanLifecycle.postScanTasks.splice(
    libraryScanLifecycle.postScanTasks.indexOf(collectionPosterVerifyPostScanTask) + 1, 0, collectionPostScanTask);
  if (collections) rollback.push(() => collections.close());
  const images = new ImageService({ fileSystem, store, library, vfs, identityMap:metadataIdentityMap, mediaIdentityMap:identityMap, processor: imageProcessor, metadataImages, metadataUpdates, loadContext, metadataPath, logger,
    userImagePath: imageOptions.userImagePath ?? (programDataPath && path.join(componentConfigurationPath, 'users')) });
  rollback.push(() => images.close());
  const brandingStore = new BrandingConfigurationStore({ configurationDirectoryPath, onError });
  rollback.push(() => brandingStore.close());
  await brandingStore.initialize();
  const branding = new BrandingService({ configurationStore: brandingStore, images, dataPath,
    assets: new MetadataImageAssets({ fileSystem, vfs, identityMap:metadataIdentityMap, metadataPath,
      stateRoots: [dataPath, programDataPath && path.join(programDataPath, 'cache')].filter(Boolean) }) });
  rollback.push(() => branding.close());
  metadataUpdates ??= images.metadataUpdates;
  const userViews = new UserViewService({ fileSystem, library, users, updates: metadataUpdates, metadata, images: metadataImages, refreshes });
  library.userViews = userViews;
  const metadataEditor = new MetadataEditorService({ library, configuration, configurationStore, localization });
  rollback.push(() => metadataEditor.close());
  const itemUpdates = new MetadataEditService({ library, loadContext, updates: metadataUpdates, refreshes: metadata });
  rollback.push(() => itemUpdates.close());
  const stopStorageObserver = configuredStorage.subscribe(async () => {
    storageReadiness.ready = false; storageReadiness.error = null;
    storageReadiness.ready = await deferUnavailable(async () => {
      await initializeStorageRoots();
      if (libraryOptionsStore) await loadLibraryOptions(database, { fileSystem, programDataPath, dataPath, metadataPath, onError, optionsStore: libraryOptionsStore });
      await libraryOptionsStore?.clear();
      await libraryConfiguration?.initialize();
    });
  });
  rollback.push(stopStorageObserver);
  const services = { storage: configuredStorage, storageReadiness, fileSystem, configuration, store, users, devices, library, itemCreation, itemDeletion, unsafeItemDeletion, folderValidation, linkedChildReferences, playlists, folderScanner, topLevelValidation, libraryScanHost, libraryScanLifecycle, libraryScanner, metadataScanner, artistsPostScanTask, genresPostScanTask, musicGenresPostScanTask, studiosPostScanTask, tasks, userData, sessions, syncPlay, refreshes, authentication, localization, playback, probe, externalData, extraction, remux, hls, images, imageProcessor, metadata, metadataUpdates, resolvedItemLifecycle, metadataEditor, itemUpdates, plugins, similarItems, ignoreRule, serverId, serverName, serverVersion };
  services.collectionPosterVerifyPostScanTask = collectionPosterVerifyPostScanTask;
  services.cleanDatabasePostScanTask = cleanDatabasePostScanTask;
  services.splashscreen = splashscreen;
  services.branding = branding;
  services.libraryOptionsStore = libraryOptionsStore;
  services.libraryConfiguration = libraryConfiguration;
  services.collections = collections;
  services.collectionPostScanTask = collectionPostScanTask;
  services.linkedChildren = linkedChildren;
  services.runWithContext = loadContext && (operation => loadContext.withScope(operation));
  services.libraryMonitor = libraryMonitor;
  services.libraryTaskScheduler = libraryTaskScheduler;
  services.quickConnect = quickConnect;
  services.passwordResets = passwordResets;
  services.displayPreferences = displayPreferences;
  services.startup = startup;
  services.apiKeys = apiKeys;
  services.splashscreenPostScanTask = splashscreenPostScanTask;
  await plugins.connect({ ...services, vfs, identityMap, metadataVfs, metadataIdentityMap, loadContext, seriesLifecycle, metadataImages, spoolRoot, fileSystem });
  const application = await createApplication({ ...services, onError });
  rollback.push(async () => { application.beginClose(); await application.drainRequests();
    if (application.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())); });
  if (application.webSockets) rollback.push(() => application.webSockets.close());
  let autoDiscovery;
  if (autoDiscoveryOptions !== undefined) {
    if (!autoDiscoveryOptions || typeof autoDiscoveryOptions !== 'object' || Array.isArray(autoDiscoveryOptions)) {
      throw new TypeError('autoDiscoveryOptions must be an object.');
    }
    const { resolveAddress, publishedUrl, resolveRouteAddress, ...serviceOptions } = autoDiscoveryOptions;
    autoDiscovery = new AutoDiscoveryService({
      ...serviceOptions,
      serverId,
      serverName,
      resolveAddress: resolveAddress ?? createDiscoveryAddressResolver({
        server: application.server,
        baseUrl: configuration.BaseUrl ?? '',
        // The current runtime creates an HTTP server only. Native HTTPS flags
        // cannot make an HTTPS endpoint reachable and therefore must not be advertised.
        scheme: 'http',
        publishedUrl,
        resolveRouteAddress
      }),
      onError
    });
    services.autoDiscovery = autoDiscovery;
    Object.defineProperty(autoDiscovery, 'serverName', { get: () => serverFriendlyName(configuration, serverName) });
    rollback.push(() => autoDiscovery.close());
  }
  const startAutoDiscovery = async () => {
    if (!application.server.listening) {
      const error = new Error('HTTP server must be listening before UDP auto-discovery starts.');
      error.code = 'ERR_HTTP_SERVER_NOT_LISTENING';
      throw error;
    }
    return autoDiscovery?.start() ?? null;
  };
  let closing;
  const close = () => closing ??= (async () => {
      const errors = [];
      const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
      application.beginClose();
      stopStorageObserver();
      // Signal every scan owner before awaiting any of them. A scheduled task
      // may wait behind a library generation which itself waits behind an
      // older folder scan; each owner must receive cancellation to release the
      // next layer of that dependency chain.
      await Promise.all([
        attempt(() => quickConnect.close()),
        attempt(() => passwordResets.close()),
        attempt(() => displayPreferences.close()),
        attempt(() => startup.close()),
        attempt(() => apiKeys.close()),
        attempt(() => splashscreen?.close()),
        attempt(() => branding.close()),
        attempt(() => collections?.close()),
        attempt(() => libraryConfiguration?.close()),
        attempt(() => tasks.close()),
        attempt(() => libraryScanner?.close()),
        attempt(() => folderScanner?.close()),
        attempt(() => playlists?.close()),
        attempt(() => metadataEditor.close()),
        attempt(() => itemUpdates.close())
      ]);
      await attempt(() => application.drainRequests());
      await attempt(() => libraryTaskScheduler?.close());
      await attempt(() => metadata?.saver.stop());
      await attempt(() => metadata?.close());
      await attempt(() => metadata?.saver.dispose());
      await attempt(() => libraryOptionsStore?.close());
      await attempt(() => libraryScanHost?.close());
      await attempt(() => itemCreation?.close());
      await attempt(() => library.close());
      await attempt(() => configurationStore?.close());
      await attempt(() => syncPlay.close());
      await attempt(() => autoDiscovery?.close());
      await attempt(() => application.webSockets?.close());

      await attempt(() => hls?.close());
      await attempt(() => images.close());
      await attempt(() => imageProcessor.close());
      await attempt(() => extraction?.close());
      await attempt(() => remux?.close());
      await attempt(() => application.server.listening && new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())));
      await attempt(() => probe?.close());
      await attempt(() => sessions.close());
      await attempt(() => plugins.close());
      await attempt(() => configuredStorage.close());
      await attempt(() => linkedChildren.flushReleases());
      await attempt(() => linkedChildren.close());
      await attempt(() => store.close());
      if (errors.length) throw new AggregateError(errors, 'The runtime could not close every resource.');
    })();
  // Start persisted task triggers only after every runtime service and its
  // shutdown path exist. A startup trigger can otherwise outlive a later
  // constructor failure and keep using a database the caller never received.
  await tasks.initialize();
  rollback.length = 0;
  return { ...application, ...services, get implementedRoutes() { return application.implementedRoutes; }, startAutoDiscovery, close };
  } catch (error) {
    const errors = [error];
    try { await splashscreen?.close(); } catch (closeError) { errors.push(closeError); }
    for (const dispose of rollback.reverse()) {
      try { await dispose(); }
      catch (closeError) { errors.push(closeError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Runtime construction and cleanup failed.');
    throw error;
  }
}
