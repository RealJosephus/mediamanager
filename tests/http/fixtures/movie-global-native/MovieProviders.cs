using System.Net.Http;
using Emby.Naming.Common;
using Emby.Server.Implementations.Chapters;
using Emby.Server.Implementations.Collections;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Validators;
using Jellyfin.Drawing;
using Jellyfin.Drawing.Skia;
using Jellyfin.LiveTv.Configuration;
using Jellyfin.LiveTv.IO;
using Jellyfin.LiveTv.Recordings;
using Jellyfin.LiveTv.Timers;
using Jellyfin.Server.Implementations.Item;
using Jellyfin.Server.Implementations.MediaSegments;
using Jellyfin.Server.Implementations.Trickplay;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Lyrics;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.LocalMetadata.Parsers;
using MediaBrowser.LocalMetadata.Providers;
using MediaBrowser.LocalMetadata.Savers;
using MediaBrowser.MediaEncoding.Encoder;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Genres;
using MediaBrowser.Providers.MediaInfo;
using MediaBrowser.Providers.Movies;
using MediaBrowser.Providers.MusicGenres;
using MediaBrowser.Providers.Studios;
using MediaBrowser.XbmcMetadata.Providers;
using MediaBrowser.XbmcMetadata.Savers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

// Only absent external content, authenticated users, discs, subtitles and lyrics
// use fail-closed dependencies. Movie/BoxSet metadata, NFO/XML, ffprobe, links,
// persistence, CollectionManager and every post-scan task execute native code.
public static class MovieProviders
{
    private static IImageEncoder _imageEncoder = null!;

    public static IImageProcessor CreateImageProcessor(IServerApplicationPaths paths,
        IServerConfigurationManager configuration, IFileSystem fileSystem)
    {
        _imageEncoder = new SkiaEncoder(Microsoft.Extensions.Logging.Abstractions.NullLogger<SkiaEncoder>.Instance, paths);
        return new ImageProcessor(Microsoft.Extensions.Logging.Abstractions.NullLogger<ImageProcessor>.Instance,
            paths, fileSystem, _imageEncoder, configuration);
    }

    public static object Install(NativeScanHost host, string ffmpeg)
    {
        var logs = host.LoggerFactory;
        var manager = host.Manager;
        var provider = host.ObservedProvider;
        var configuration = host.Configuration;
        var files = host.FileSystem;
        var unusedUsers = ForwardProxy.Make<IUserManager>((method, values) => ForwardProxy.Unused(method));
        var unusedUserData = ForwardProxy.Make<IUserDataManager>((method, values) => ForwardProxy.Unused(method));
        var unusedBluray = ForwardProxy.Make<IBlurayExaminer>((method, values) => ForwardProxy.Unused(method));
        var unusedSubtitles = ForwardProxy.Make<ISubtitleManager>((method, values) => ForwardProxy.Unused(method));
        var unusedSubtitleEncoder = ForwardProxy.Make<ISubtitleEncoder>((method, values) => ForwardProxy.Unused(method));
        var unusedLyrics = ForwardProxy.Make<ILyricManager>((method, values) => ForwardProxy.Unused(method));
        var attachments = new MediaAttachmentRepository(host.Factory);
        var encoderConfiguration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { [MediaBrowser.Controller.Extensions.ConfigurationExtensions.FfmpegPathKey] = ffmpeg }).Build();
        var encoder = new MediaEncoder(logs.CreateLogger<MediaEncoder>(), configuration, files, unusedBluray,
            host.Localization, encoderConfiguration, configuration);
        host.Own("media-encoder", encoder);
        host.Own("image-processor", (IDisposable)host.ImageProcessor);
        if (!encoder.SetFFmpegPath()) throw new IOException("The supplied ffmpeg failed actual native validation.");
        var observedEncoder = ForwardProxy.Make<IMediaEncoder>((method, values) => method.Name == "GetMediaInfo"
            ? Probe((MediaInfoRequest)values![0]!, (CancellationToken)values[1]!)
            : ForwardProxy.Forward(encoder, method, values));
        var mediaSources = new MediaSourceManager(host.AppHost, host.Repository, host.Paths, host.Localization,
            unusedUsers, manager, logs.CreateLogger<MediaSourceManager>(), files, unusedUserData,
            observedEncoder, host.DirectoryService, host.Streams, attachments);
        mediaSources.AddParts([]);
        host.Own("media-source-manager", mediaSources);
        MediaBrowser.Controller.Entities.BaseItem.MediaSourceManager = mediaSources;
        // ApplicationHost.SetStaticProperties installs this service for every
        // Video. Real persistence asks SourceType/GetUserDataKeys even before
        // the Movie's metadata providers run. Use the actual recording manager;
        // an empty recording state must be its result, never a proxy constant.
        var liveTv = configuration.GetLiveTvConfiguration();
        var liveTvData = Path.Combine(host.Paths.DataPath, "livetv");
        if (Directory.Exists(liveTvData) || File.Exists(liveTvData)
            || liveTv.TunerHosts.Length != 0 || liveTv.ListingProviders.Length != 0
            || liveTv.MediaLocationsCreated.Length != 0
            || !string.IsNullOrEmpty(liveTv.RecordingPath)
            || !string.IsNullOrEmpty(liveTv.MovieRecordingPath)
            || !string.IsNullOrEmpty(liveTv.SeriesRecordingPath))
            throw new IOException("The Movie fixture requires fresh, unconfigured Live TV recording state.");
        var timers = new TimerManager(logs.CreateLogger<TimerManager>(), configuration);
        var seriesTimers = new SeriesTimerManager(logs.CreateLogger<SeriesTimerManager>(), configuration);
        var recordingMetadata = new RecordingsMetadataManager(logs.CreateLogger<RecordingsMetadataManager>(), configuration, manager);
        var recordingStreams = new StreamHelper();
        var unusedRecordingHttp = ForwardProxy.Make<IHttpClientFactory>((method, values) => ForwardProxy.Unused(method));
        var recordings = new RecordingsManager(logs.CreateLogger<RecordingsManager>(), configuration,
            unusedRecordingHttp, files, manager, host.Monitor, provider, observedEncoder, mediaSources,
            recordingStreams, timers, seriesTimers, recordingMetadata);
        host.Own("recordings-manager", recordings);
        var recordingInitialState = new
        {
            liveTvData, dataDirectoryExists = Directory.Exists(liveTvData), configuration = liveTv,
            timers = timers.GetAll().Count, seriesTimers = seriesTimers.GetAll().Count,
            recordingFolders = recordings.GetRecordingFolders().ToArray(),
            activeRecordings = "Fresh actual RecordingsManager; no recording stream or timer is started."
        };
        if (recordingInitialState.timers != 0 || recordingInitialState.seriesTimers != 0
            || recordingInitialState.recordingFolders.Length != 0)
            throw new IOException("The actual recording services did not load empty initial state.");
        var observedRecordings = new ObservedRecordingsManager(host, recordings);
        Video.RecordingsManager = observedRecordings;
        host.Add("recordings-installed", new { type = recordings.GetType().FullName,
            observer = observedRecordings.GetType().FullName, initialState = recordingInitialState });
        async Task<MediaInfo> Probe(MediaInfoRequest request, CancellationToken token)
        {
            host.Add("probe-begin", new { request, encoder.EncoderPath, encoder.ProbePath, startedAt = DateTime.UtcNow });
            try
            {
                var result = await encoder.GetMediaInfo(request, token);
                host.Add("probe-completed", new { request, result, endedAt = DateTime.UtcNow });
                return result;
            }
            catch (Exception error)
            {
                host.Add("probe-failed", new { request, error = error.ToString() });
                throw;
            }
        }
        var chapters = new ChapterManager(logs.CreateLogger<ChapterManager>(), files, observedEncoder,
            new ChapterRepository(host.Factory, host.ImageProcessor), manager, host.PathManager);
        var keyframes = new KeyframeManager(new KeyframeRepository(host.Factory));
        var segments = new MediaSegmentManager(logs.CreateLogger<MediaSegmentManager>(), host.Factory, []);
        var encodingHelper = new EncodingHelper(host.Paths, observedEncoder, unusedSubtitleEncoder,
            encoderConfiguration, configuration, host.PathManager);
        var trickplay = new TrickplayManager(logs.CreateLogger<TrickplayManager>(), observedEncoder, files,
            encodingHelper, configuration, _imageEncoder, host.Factory, host.Paths, host.PathManager);
        var externalData = new ExternalDataManager(keyframes, segments, host.PathManager, trickplay, chapters,
            logs.CreateLogger<ExternalDataManager>());
        host.InstallExternalDataManager(externalData);
        BaseItem.MediaSegmentManager = segments;
        host.MetadataServices.Add(new MovieMetadataService(configuration, logs.CreateLogger<MovieMetadataService>(), provider,
            files, manager, host.ExternalData, host.Repository));
        host.MetadataServices.Add(new BoxSetMetadataService(configuration, logs.CreateLogger<BoxSetMetadataService>(), provider,
            files, manager, host.ExternalData, host.Repository));
        host.MetadataServices.Add(new GenreMetadataService(configuration, logs.CreateLogger<GenreMetadataService>(), provider,
            files, manager, host.ExternalData, host.Repository));
        host.MetadataServices.Add(new MusicGenreMetadataService(configuration, logs.CreateLogger<MusicGenreMetadataService>(), provider,
            files, manager, host.ExternalData, host.Repository));
        host.MetadataServices.Add(new StudioMetadataService(configuration, logs.CreateLogger<StudioMetadataService>(), provider,
            files, manager, host.ExternalData, host.Repository));
        var nfoReader = new MovieNfoProvider(logs.CreateLogger<MovieNfoProvider>(), files, configuration,
            provider, unusedUsers, unusedUserData, host.DirectoryService);
        var xmlReader = new BoxSetXmlProvider(files, logs.CreateLogger<BoxSetXmlParser>(), provider);
        host.MetadataProviders.Add(new ObservedLocal<MediaBrowser.Controller.Entities.Movies.Movie>(host, nfoReader));
        host.MetadataProviders.Add(new ObservedOrderedLocal<MediaBrowser.Controller.Entities.Movies.BoxSet>(host, xmlReader));
        host.MetadataProviders.Add(new ProbeProvider(mediaSources, observedEncoder, unusedBluray, host.Localization, chapters,
            configuration, unusedSubtitles, manager, files, logs, new NamingOptions(), unusedLyrics, attachments, host.Streams));
        var nfoSaver = new MovieNfoSaver(files, configuration, manager, unusedUsers, unusedUserData, logs.CreateLogger<MovieNfoSaver>());
        var xmlSaver = new BoxSetXmlSaver(files, configuration, manager, logs.CreateLogger<BoxSetXmlSaver>());
        host.MetadataSavers.Add(new ObservedSaver(host, nfoSaver));
        host.MetadataSavers.Add(new ObservedSaver(host, xmlSaver));
        host.ApplyProviderParts();

        var collections = new CollectionManager(manager, host.Paths, host.Localization, files, host.Monitor,
            logs, provider, host.Links);
        collections.CollectionCreated += (_, value) => host.Add("collection-created", new { value.Collection.Id, value.Collection.Name });
        var availableTasks = new ILibraryPostScanTask[]
        {
            new SplashscreenPostScanTask(host.Repository, _imageEncoder, logs.CreateLogger<SplashscreenPostScanTask>()),
            new ArtistsPostScanTask(manager, logs.CreateLogger<ArtistsValidator>(), host.Repository),
            new CollectionPosterVerifyPostScanTask(manager, logs.CreateLogger<CollectionPosterVerifyPostScanTask>()),
            new CollectionPostScanTask(manager, collections, logs.CreateLogger<CollectionPostScanTask>()),
            new GenresPostScanTask(manager, logs.CreateLogger<GenresValidator>(), host.Repository),
            new MusicGenresPostScanTask(manager, logs.CreateLogger<MusicGenresValidator>(), host.Repository),
            new StudiosPostScanTask(manager, logs.CreateLogger<StudiosValidator>(), host.Repository),
            new CleanDatabaseScheduledTask(manager, logs.CreateLogger<CleanDatabaseScheduledTask>(), host.Factory, host.PathManager)
        };
        // Use the designated CoreAppHost's actual export order. In particular,
        // never reorder native tasks to match the candidate registration list.
        if (host.PostScanTaskTypes.Length != availableTasks.Length) throw new IOException("Unexpected native post-scan export set.");
        var tasks = host.PostScanTaskTypes.Select(type => availableTasks.Single(task => task.GetType() == type)).ToArray();
        host.SetPostScanTasks(tasks);
        return new
        {
            metadataServices = host.MetadataServices.Select(value => value.GetType().FullName).ToArray(),
            metadataProviders = host.MetadataProviders.Select(value => value.GetType().FullName).ToArray(),
            metadataSavers = host.MetadataSavers.Select(value => value.GetType().FullName).ToArray(),
            readerImplementations = new[] { nfoReader.GetType().FullName, xmlReader.GetType().FullName },
            saverImplementations = new[] { nfoSaver.GetType().FullName, xmlSaver.GetType().FullName },
            postScanTasks = tasks.Select(value => value.GetType().FullName).ToArray(),
            discoveredPostScanTypes = host.PostScanTaskTypes.Select(type => type.AssemblyQualifiedName).ToArray(),
            collectionManager = collections.GetType().FullName, encoder = encoder.GetType().FullName,
            mediaSourceManager = mediaSources.GetType().FullName,
            recordingsManager = recordings.GetType().FullName, recordingInitialState,
            recordingDependencies = new[] { timers.GetType().FullName, seriesTimers.GetType().FullName,
                recordingMetadata.GetType().FullName, recordingStreams.GetType().FullName },
            externalDataManager = externalData.GetType().FullName,
            externalDataDependencies = new[] { keyframes.GetType().FullName, segments.GetType().FullName,
                host.PathManager.GetType().FullName, trickplay.GetType().FullName, chapters.GetType().FullName },
            encoder.EncoderPath, encoder.ProbePath
        };
    }

    private sealed class ObservedRecordingsManager(NativeScanHost host, IRecordingsManager actual) : IRecordingsManager
    {
        public string? GetActiveRecordingPath(string id) => actual.GetActiveRecordingPath(id);
        public ActiveRecordingInfo? GetActiveRecordingInfo(string path)
        {
            host.Add("recording-active-query-begin", new { path, type = actual.GetType().FullName });
            try
            {
                var result = actual.GetActiveRecordingInfo(path);
                host.Add("recording-active-query-completed", new { path, hasActiveRecording = result is not null,
                    recording = result is null ? null : new { result.Id, result.Path, result.Timer,
                        cancellationRequested = result.CancellationTokenSource.IsCancellationRequested } });
                return result;
            }
            catch (Exception error)
            {
                host.Add("recording-active-query-failed", new { path, error = error.ToString() });
                throw;
            }
        }
        public IEnumerable<VirtualFolderInfo> GetRecordingFolders() => actual.GetRecordingFolders();
        public Task CreateRecordingFolders() => actual.CreateRecordingFolders();
        public void CancelRecording(string timerId, TimerInfo? timer) => actual.CancelRecording(timerId, timer);
        public Task RecordStream(ActiveRecordingInfo info, BaseItem channel, DateTime end)
            => actual.RecordStream(info, channel, end);
    }

    private class ObservedLocal<T>(NativeScanHost host, ILocalMetadataProvider<T> actual) : ILocalMetadataProvider<T>, IHasItemChangeMonitor
        where T : BaseItem
    {
        public string Name => actual.Name;
        public bool HasChanged(BaseItem item, IDirectoryService directory)
        {
            var changed = ((IHasItemChangeMonitor)actual).HasChanged(item, directory);
            host.Add("local-reader-change-check", new { provider = actual.GetType().FullName, itemId = item.Id,
                item.Path, item.DateLastSaved, changed });
            return changed;
        }
        public async Task<MetadataResult<T>> GetMetadata(ItemInfo info, IDirectoryService directory, CancellationToken token)
        {
            host.Add("local-reader-begin", new { provider = actual.GetType().FullName, info.Path });
            var result = await actual.GetMetadata(info, directory, token);
            var item = result.Item;
            host.Add("local-reader-completed", new { provider = actual.GetType().FullName, info.Path, result.HasMetadata,
                Name = item?.Name, DateCreated = item?.DateCreated, DateCreatedKind = item?.DateCreated.Kind.ToString(),
                Genres = item?.Genres.ToArray(), Studios = item?.Studios.ToArray(),
                tmdbCollectionName = (item as MediaBrowser.Controller.Entities.Movies.Movie)?.TmdbCollectionName });
            return result;
        }
    }
    private sealed class ObservedOrderedLocal<T>(NativeScanHost host, ILocalMetadataProvider<T> actual)
        : ObservedLocal<T>(host, actual), IHasOrder where T : BaseItem
    { public int Order => ((IHasOrder)actual).Order; }
    private sealed class ObservedSaver(NativeScanHost host, IMetadataFileSaver actual) : IMetadataFileSaver
    {
        public string Name => actual.Name;
        public string GetSavePath(BaseItem item) => actual.GetSavePath(item);
        public bool IsEnabledFor(BaseItem item, ItemUpdateType reason) => actual.IsEnabledFor(item, reason);
        public async Task SaveAsync(BaseItem item, CancellationToken token)
        {
            var filename = actual.GetSavePath(item);
            host.Add("local-saver-begin", new { saver = actual.GetType().FullName, itemId = item.Id, item.Path, filename });
            await actual.SaveAsync(item, token);
            var bytes = File.ReadAllBytes(filename);
            host.Add("local-saver-completed", new { saver = actual.GetType().FullName, itemId = item.Id, item.Path, filename,
                bytes = bytes.Length, sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
                text = System.Text.Encoding.UTF8.GetString(bytes) });
        }
    }
}
