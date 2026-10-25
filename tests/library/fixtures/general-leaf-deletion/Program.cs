// Actual pinned LibraryManager/DeleteItem lifecycle for isolated BaseItem media items.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.IO;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File,
    "GetMediaStreams" => Array.Empty<MediaBrowser.Model.Entities.MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(),
    "GetMediaAttachments" => Array.Empty<MediaBrowser.Model.Entities.MediaAttachment>(),
    _ => Stub.Default(method.ReturnType)
});

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
var results = new List<object>();

foreach (var sample in input.EnumerateArray()) {
    var root = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!));
    Directory.CreateDirectory(root);
    var calls = new List<object>();
    var active = false;
    LibraryManager? manager = null;
    BaseItem? target = null;
    string? internalMarker = null;
    string? externalMarker = null;
    var sourceName = sample.TryGetProperty("sourceName", out var sourceNameValue) ? sourceNameValue.GetString()!
        : sample.GetProperty("type").GetString() == "Book" ? "book.epub" : "track.flac";
    var type = sample.GetProperty("type").GetString()!;
    var internalItem = Bool("internalItem");
    var stateSource = Bool("stateSource");
    var sourceDirectory = internalItem || Bool("sourceDirectory");
    var source = internalItem ? type switch {
        "Person" => Path.Combine(root, "metadata", "People", "T", "Target"),
        "MusicArtist" => Path.Combine(root, "metadata", "artists", "Target"),
        _ => Path.Combine(root, "metadata", type, "Target")
    } : stateSource ? Path.Combine(root, "data", "collections", sourceName)
        : Path.Combine(root, "media", sourceName);
    var sibling = Path.Combine(root, "media", "sibling.keep");
    Directory.CreateDirectory(Path.Combine(root, "media"));
    Directory.CreateDirectory(Path.GetDirectoryName(source)!);
    if (!Bool("virtual")) {
        if (sourceDirectory) {
            Directory.CreateDirectory(source);
            File.WriteAllText(Path.Combine(source, "source.txt"), "source", Encoding.UTF8);
        } else File.WriteAllText(source, "source", Encoding.UTF8);
    }
    File.WriteAllText(sibling, "sibling", Encoding.UTF8);
    File.WriteAllText(Path.Combine(root, "media", "track.nfo"), "nfo", Encoding.UTF8);
    File.WriteAllText(Path.Combine(root, "media", "track-cover.jpg"), "image", Encoding.UTF8);
    if (sample.TryGetProperty("sidecars", out var sidecars)) foreach (var sidecar in sidecars.EnumerateArray())
        File.WriteAllText(Path.Combine(root, "media", sidecar.GetString()!), "sidecar", Encoding.UTF8);
    if (sample.TryGetProperty("sidecarDirectories", out var sidecarDirectories)) foreach (var sidecar in sidecarDirectories.EnumerateArray()) {
        var directory = Path.Combine(root, "media", sidecar.GetString()!);
        Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, "track.nfo"), "nested", Encoding.UTF8);
    }

    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_RootFolderPath" => Path.Combine(root, "root"),
        "get_ProgramDataPath" => root,
        "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        "get_DataPath" => Path.Combine(root, "data"),
        "get_TrickplayPath" => Path.Combine(root, "data", "trickplay"),
        "get_PeoplePath" => Path.Combine(root, "metadata", "People"),
        "get_ArtistsPath" => Path.Combine(root, "metadata", "artists"),
        "get_GenrePath" => Path.Combine(root, "metadata", "Genre"),
        "get_MusicGenrePath" => Path.Combine(root, "metadata", "MusicGenre"),
        "get_StudioPath" => Path.Combine(root, "metadata", "Studio"),
        "get_YearPath" => Path.Combine(root, "metadata", "Year"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 },
        "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new EnumerationFileSystem(paths, () => active && Bool("enumerationFailure"), () => active && Bool("partialEnumerationFailure"));
    BaseItem.FileSystem = fileSystem;
    var directoryService = new DirectoryService(fileSystem);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
        ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "DeleteItem") calls.Add(new {
            action = "delete", ids = ((IReadOnlyList<Guid>)values![0]!).Select(Id).ToArray(), state = State()
        });
        return Stub.Forward(realPersistence, method, values);
    });
    var provider = Stub.Make<IProviderManager>((method, _) => Stub.Default(method.ReturnType));
    var pathManager = new PathManager(NullLogger<PathManager>.Instance, config, paths);
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            var item = (BaseItem)values![0]!;
            if (active) calls.Add(new { action = "external", id = Id(item.Id), state = State() });
            if (active && Bool("externalFailure") && item.Id == target!.Id) throw new IOException("Controlled external cleanup failure.");
            if (item.Id == target?.Id && externalMarker is not null && Directory.Exists(Path.GetDirectoryName(externalMarker)!))
                Directory.Delete(Path.GetDirectoryName(externalMarker)!, true);
        }
        return Stub.Default(method.ReturnType);
    });
    BaseItem.ChannelManager = Stub.Make<MediaBrowser.Controller.Channels.IChannelManager>((method, values) => {
        if (method.Name == "GetStaticMediaSources") return Array.Empty<MediaSourceInfo>();
        if (method.Name == "DeleteItem") {
            calls.Add(new { action = "channel", id = Id(((BaseItem)values![0]!).Id), state = State() });
            return sample.GetProperty("channel").GetString() switch {
                "argument" => Task.FromException(new ArgumentException("Missing channel")),
                "failure" => Task.FromException(new InvalidOperationException("Controlled channel failure")),
                _ => Task.CompletedTask
            };
        }
        return Stub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Forward(manager!, method, values)
    });
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), new Emby.Naming.Common.NamingOptions(), directoryService,
        null!, pathManager, new DotIgnoreIgnoreRule(), BaseItem.LocalizationManager,
        null!, new(() => externalData));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(manager, new UserRootFolder { Children = [] });

    var parent = new Folder { Id = Guid.Parse("a1100000-0000-0000-0000-000000000002"), Name = "Parent", Path = Path.Combine(root, "media") };
    manager.CreateItem(parent, null);
    var owner = new Audio { Id = Guid.Parse("a1100000-0000-0000-0000-000000000003"), Name = "Owner", Path = Path.Combine(root, "media", "owner.flac"), ParentId = parent.Id };
    if (Bool("ownedItem") || Bool("primaryVersion")) { File.WriteAllText(owner.Path, "owner"); manager.CreateItem(owner, parent); }
    target = sample.GetProperty("type").GetString() switch {
        "Book" => new Book(), "AudioBook" => new AudioBook(), "Audio" => new Audio(),
        "Movie" => new Movie(), "MusicVideo" => new MusicVideo(), "Video" => new Video(),
        "Episode" => new Episode(), "Trailer" => new Trailer(),
        "Series" => new Series(), "Season" => new Season(), "BoxSet" => new BoxSet(),
        "LiveTvProgram" => new LiveTvProgram(), "MusicAlbum" => new MusicAlbum(),
        "Photo" => new Photo(), "PhotoAlbum" => new PhotoAlbum(),
        "Person" => new Person(), "Genre" => new Genre(), "MusicGenre" => new MusicGenre(),
        "Studio" => new Studio(), "Year" => new Year(), "MusicArtist" => new MusicArtist(),
        _ => throw new InvalidOperationException("Unsupported oracle item type.")
    };
    target.Id = Guid.Parse("a1100000-0000-0000-0000-000000000001");
    target.Name = "Target";
    target.Path = Bool("virtual") ? null : source;
    target.ParentId = internalItem ? Guid.Empty : parent.Id;
    target.IsInMixedFolder = Bool("mixed");
    target.IsVirtualItem = Bool("virtual");
    target.IsShortcut = Bool("shortcut");
    target.ShortcutPath = Bool("shortcut") ? "https://example.invalid/source" : null;
    if (sample.TryGetProperty("channel", out _)) target.ChannelId = Guid.Parse("a1100000-0000-0000-0000-000000000009");
    if (Bool("ownedItem")) target.OwnerId = owner.Id;
    manager.CreateItem(target, internalItem ? null : parent);
    if (Bool("primaryVersion")) using (var mutation = factory.CreateDbContext()) {
        var row = mutation.BaseItems.Single(row => row.Id == target.Id); row.PrimaryVersionId = owner.Id; mutation.SaveChanges();
    }
    if (Bool("liveVirtualDrift")) target.IsVirtualItem = true;

    BaseItem? closure = null;
    if (Bool("ownedChild") || Bool("parentChild")) {
        closure = sample.TryGetProperty("childType", out var childType) && childType.GetString() == "Photo" ? new Photo() : new Audio();
        closure.Id = Guid.Parse("a1100000-0000-0000-0000-000000000004");
        closure.Name = "Closure";
        closure.Path = Path.Combine(root, "media", closure is Photo ? "closure.jpg" : "closure.flac");
        closure.ParentId = Bool("parentChild") ? target.Id : parent.Id;
        closure.OwnerId = Bool("ownedChild") ? target.Id : Guid.Empty;
        File.WriteAllText(closure.Path, "closure"); realPersistence.SaveItems([closure], CancellationToken.None);
    }
    parent.Children = [target]; parent.UserData = [];
    internalMarker = Path.Combine(target.GetInternalMetadataPath(), "marker.txt");
    Directory.CreateDirectory(Path.GetDirectoryName(internalMarker)!); File.WriteAllText(internalMarker, "internal");
    externalMarker = Path.Combine(root, "external", Id(target.Id), "marker.txt");
    Directory.CreateDirectory(Path.GetDirectoryName(externalMarker)!); File.WriteAllText(externalMarker, "external");
    if (closure is not null) {
        var marker = Path.Combine(closure.GetInternalMetadataPath(), "marker.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(marker)!); File.WriteAllText(marker, "closure-internal");
    }
    if (Bool("missingSource")) {
        if (Directory.Exists(source)) Directory.Delete(source, true);
        else if (File.Exists(source)) File.Delete(source);
    }
    if (Bool("sqlFailure")) using (var fault = factory.CreateDbContext())
        fault.Database.ExecuteSqlRaw("CREATE TRIGGER deletion_failure BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Controlled deletion failure'); END");
    manager.ItemRemoved += (_, change) => calls.Add(new { action = "event", id = Id(change.Item.Id), parentId = change.Parent is null ? null : Id(change.Parent.Id), state = State() });
    calls.Add(new {
        action = "plan",
        paths = target.Path is null ? Array.Empty<object>() : target.GetDeletePaths().Select(entry => new { path = Project(entry.FullName), directory = entry.IsDirectory }).Cast<object>().ToArray(),
        cancellable = false
    });
    active = true;
    string? exception = null;
    FileStream? sourceLock = null;
    FileStream? sidecarLock = null;
    try {
        if (Bool("sourceFailure") && File.Exists(source)) sourceLock = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.None);
        if (sample.TryGetProperty("sidecarFailure", out var sidecarFailure))
            sidecarLock = new FileStream(Path.Combine(root, "media", sidecarFailure.GetString()!), FileMode.Open, FileAccess.Read, FileShare.None);
        var deleteOptions = new DeleteOptions {
            DeleteFileLocation = Bool("deleteSource"),
            DeleteFromExternalProvider = !sample.TryGetProperty("deleteFromExternalProvider", out var externalProvider) || externalProvider.GetBoolean()
        };
        if (Bool("defaultParent")) manager.DeleteItem(target, deleteOptions);
        else manager.DeleteItem(target, deleteOptions, parent, !Bool("noNotify"));
    } catch (Exception error) {
        exception = error.GetType().Name;
        if (exception != Expected()) Console.Error.WriteLine(sample.GetProperty("name").GetString() + ": " + error);
    } finally { sourceLock?.Dispose(); sidecarLock?.Dispose(); }
    if (exception != Expected()) throw new InvalidOperationException("Unexpected exception for " + sample.GetProperty("name").GetString() + ": " + exception);

    using var final = factory.CreateDbContext();
    var rows = final.BaseItems.AsNoTracking().Where(row => row.Type != "PLACEHOLDER").AsEnumerable().Select(row => new {
        id = Id(row.Id), type = row.Type, parentId = row.ParentId.HasValue ? Id(row.ParentId.Value) : null,
        ownerId = row.OwnerId.HasValue ? Id(row.OwnerId.Value) : null, primaryVersionId = row.PrimaryVersionId.HasValue ? Id(row.PrimaryVersionId.Value) : null
    }).OrderBy(row => row.id, StringComparer.Ordinal).ToArray();
    var files = Directory.GetFiles(root, "*", SearchOption.AllDirectories).Where(file => !file.EndsWith(".db", StringComparison.Ordinal))
        .Select(Project).Order(StringComparer.Ordinal).ToArray();
    results.Add(new {
        name = sample.GetProperty("name").GetString(), exception, calls, rows, files,
        targetParentId = Id(target.ParentId), targetLookup = manager.GetItemById(target.Id) is not null,
        closureLookup = closure is null ? (bool?)null : manager.GetItemById(closure.Id) is not null,
        parentChildrenCleared = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null,
        parentUserDataCleared = parent.UserData is null
    });

    bool Bool(string name) => sample.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    string? Expected() => sample.TryGetProperty("expectException", out var value) ? value.GetString() : null;
    string Project(string value) => value.Replace(root, "$STATE", StringComparison.Ordinal);
    object State() {
        using var phase = factory.CreateDbContext();
        return new {
            sourceExists = File.Exists(source) || Directory.Exists(source), internalExists = internalMarker is not null && File.Exists(internalMarker),
            externalExists = externalMarker is not null && File.Exists(externalMarker),
            databaseExists = target is not null && phase.BaseItems.AsNoTracking().Any(row => row.Id == target.Id),
            parentId = target is null ? null : Id(target.ParentId)
        };
    }
}

File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualFrozenGeneralLeafDeletion = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    }),
    scope = "Actual pinned LibraryManager.DeleteItem for Audio, AudioBook, Book, LiveTvProgram and Photo file leaves; Movie, MusicVideo, Video, Episode and Trailer file videos; Series, Season, BoxSet, MusicAlbum and PhotoAlbum directories; internal Person, Genre, MusicGenre, Studio, Year and by-name MusicArtist directories; and physical MusicArtist directories, including DB-only and requested source deletion, managed BoxSet state, Series, MusicAlbum, PhotoAlbum and physical MusicArtist child closure, containing-directory and exact-file mixed source deletion, missing files, shortcut and virtual shapes, channel provider suppression/errors, all 21 mixed-folder sidecar extensions, ordinal-ignore-case filename prefixes, empty stems, nonrecursive enumeration, optional I/O failure and complete/partial enumeration failures, owned/parent persistence closure, non-video PrimaryVersionId storage, persisted/live drift, non-cancellable API, and source/external/SQL failure prefixes."
}, json) + "\n");

static string Id(Guid value) => value.ToString("D");

public class EnumerationFileSystem(IServerApplicationPaths paths, Func<bool> fail, Func<bool> partial)
    : ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []) {
    public override IEnumerable<FileSystemMetadata> GetFiles(string path, IReadOnlyList<string>? extensions, bool caseSensitive, bool recursive) {
        if (fail()) throw new IOException("Controlled enumeration failure.");
        var files = base.GetFiles(path, extensions, caseSensitive, recursive);
        return partial() ? Partial(files) : files;
    }
    private static IEnumerable<FileSystemMetadata> Partial(IEnumerable<FileSystemMetadata> files) {
        foreach (var file in files.Take(1)) yield return file;
        throw new IOException("Controlled partial enumeration failure.");
    }
}

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}

public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
