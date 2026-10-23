using System.Collections.Concurrent;
using Emby.Photos;
using Emby.Server.Implementations.Images;
using Jellyfin.Drawing;
using Jellyfin.Drawing.Skia;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.LocalMetadata.Images;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Books.ComicBookInfo;
using MediaBrowser.Providers.Books.ComicInfo;
using MediaBrowser.Providers.Books.OpenPackagingFormat;
using MediaBrowser.Providers.Photos;
using Microsoft.Extensions.Logging;

// Current capture retains the original provider registration and empty savers.
// Every provider and metadata service below is the real designated native type.
// Registration order of equal-priority local Book readers follows the separately
// recorded actual CoreAppHost discovery: Comic, EPUB, OPF. Output records it again.
public static class BookPhotoProviders
{
    public static readonly ProviderLog Logs = new();

    public static IImageProcessor CreateImageProcessor(IServerApplicationPaths paths,
        IServerConfigurationManager configuration, IFileSystem fileSystem)
        => new ImageProcessor(Logs.For<ImageProcessor>(), paths, fileSystem,
            new SkiaEncoder(Logs.For<SkiaEncoder>(), paths), configuration);

    public static object Install(NativeScanHost host)
    {
        var configuration = host.Configuration;
        var manager = host.Manager;
        var provider = host.Provider;
        var fileSystem = host.FileSystem;
        var externalData = host.ExternalData;
        var repository = host.Repository;

        host.MetadataServices.Add(new BookMetadataService(configuration, Logs.For<BookMetadataService>(), provider,
            fileSystem, manager, externalData, repository));
        host.MetadataServices.Add(new PhotoMetadataService(configuration, Logs.For<PhotoMetadataService>(), provider,
            fileSystem, manager, externalData, repository));
        host.MetadataServices.Add(new PhotoAlbumMetadataService(configuration, Logs.For<PhotoAlbumMetadataService>(), provider,
            fileSystem, manager, externalData, repository));

        host.MetadataProviders.Add(new ComicProvider([
            new ComicBookInfoProvider(fileSystem, Logs.For<ComicBookInfoProvider>()),
            new ExternalComicInfoProvider(fileSystem, Logs.For<ExternalComicInfoProvider>()),
            new InternalComicInfoProvider(fileSystem, Logs.For<InternalComicInfoProvider>())
        ]));
        host.MetadataProviders.Add(new EpubProvider(fileSystem, Logs.For<EpubProvider>()));
        host.MetadataProviders.Add(new OpfProvider(fileSystem, Logs.For<OpfProvider>()));
        host.MetadataProviders.Add(new PhotoProvider(Logs.For<PhotoProvider>(), host.ImageProcessor));
        host.MetadataProviders.Add(new PhotoAlbumImageProvider(fileSystem, provider, host.Paths,
            host.ImageProcessor, manager));

        if (!host.ImageProviders.Any(value => value is LocalImageProvider))
            host.ImageProviders.Add(new LocalImageProvider(fileSystem));
        host.ImageProviders.Add(new ComicImageProvider(Logs.For<ComicImageProvider>()));
        host.ImageProviders.Add(new EpubImageProvider(Logs.For<EpubImageProvider>()));
        host.ApplyProviderParts();

        return new
        {
            metadataServices = host.MetadataServices.Select(value => value.GetType().AssemblyQualifiedName).ToArray(),
            metadataProviders = host.MetadataProviders.Select(value => value.GetType().AssemblyQualifiedName).ToArray(),
            imageProviders = host.ImageProviders.Select(value => value.GetType().AssemblyQualifiedName).ToArray(),
            metadataSavers = host.MetadataSavers.Select(value => value.GetType().AssemblyQualifiedName).ToArray(),
            imageProcessor = host.ImageProcessor.GetType().AssemblyQualifiedName
        };
    }
}

public sealed class ProviderLog
{
    private readonly ConcurrentQueue<object> _events = new();
    public object[] Snapshot() => _events.ToArray();
    public ILogger<T> For<T>() => new RecordingLogger<T>(_events);

    private sealed class RecordingLogger<T>(ConcurrentQueue<object> events) : ILogger<T>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => events.Enqueue(new
            {
                component = typeof(T).FullName, level = level.ToString(), eventId = eventId.Id,
                exception = exception?.GetType().FullName, message = formatter(state, exception)
            });
    }
}
