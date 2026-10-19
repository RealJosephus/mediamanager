// Frozen native oracle for Folder.ValidateChildren replacement with a persisted
// LinkedAlternateVersion whose path uses the HTTP protocol.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
using Emby.Naming.Video;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Emby.Server.Implementations.Library.Resolvers.Movies;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSegmentManager = Stub.Make<IMediaSegmentManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name switch
{
    "GetPathProtocol" => values?[0] is string path && path.StartsWith("http", StringComparison.OrdinalIgnoreCase)
        ? MediaProtocol.Http : MediaProtocol.File,
    "GetMediaStreams" => Array.Empty<MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(),
    "GetMediaAttachments" => Array.Empty<MediaAttachment>(),
    _ => Stub.Default(method.ReturnType)
});

var inputText = File.ReadAllText(args[0]);
var samples = JsonDocument.Parse(inputText).RootElement;
var results = new List<object>();
foreach (var sample in samples.EnumerateArray())
{
    var stateRoot = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!));
    if (Directory.Exists(stateRoot))
    {
        Directory.Delete(stateRoot, true);
    }

    Directory.CreateDirectory(stateRoot);
    var mediaPath = Path.Combine(stateRoot, "media");
    Directory.CreateDirectory(mediaPath);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch
    {
        "get_RootFolderPath" => Path.Combine(stateRoot, "root"),
        "get_ProgramDataPath" => stateRoot,
        "get_InternalMetadataPath" => Path.Combine(stateRoot, "metadata"),
        "get_DataPath" => Path.Combine(stateRoot, "data"),
        "get_TrickplayPath" => Path.Combine(stateRoot, "data", "trickplay"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
    {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 },
        "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
        ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(stateRoot, "native.db"));
    using (var initial = factory.CreateDbContext())
    {
        initial.Database.EnsureCreated();
    }

    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var trace = new List<object>();
    var active = false;
    var persistence = Stub.Make<IItemPersistenceService>((method, values) =>
    {
        if (active && method.Name == "SaveItems")
        {
            trace.Add(new
            {
                action = "save",
                ids = ((IReadOnlyList<BaseItem>)values![0]!).Select(item => Id(item.Id)).ToArray(),
                paths = ((IReadOnlyList<BaseItem>)values[0]!).Select(item => ProjectPath(item.Path)).ToArray()
            });
        }

        if (active && method.Name == "DeleteItem")
        {
            trace.Add(new { action = "delete", ids = ((IReadOnlyList<Guid>)values![0]!).Select(Id).ToArray() });
        }

        return Stub.Forward(realPersistence, method, values);
    });
    var provider = Stub.Make<IProviderManager>((method, values) =>
    {
        if (active && method.Name == "SaveMetadataAsync")
        {
            trace.Add(new { action = "saver", id = Id(((BaseItem)values![0]!).Id) });
        }

        return Stub.Default(method.ReturnType);
    });
    var directoryService = new DirectoryService(fileSystem);
    var externalData = Stub.Make<IExternalDataManager>((method, values) =>
    {
        if (active && method.Name == "DeleteExternalItemFiles")
        {
            trace.Add(new { action = "external-files", id = Id(((BaseItem)values![0]!).Id) });
        }

        return Stub.Default(method.ReturnType);
    });
    var pathManager = new PathManager(NullLogger<PathManager>.Instance, config, paths);
    LibraryManager? manager = null;
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        "GetContentType" => Enum.Parse<CollectionType>("movies"),
        _ => Stub.Forward(manager!, method, values)
    });
    var naming = new NamingOptions();
    var dotIgnore = new DotIgnoreIgnoreRule();
    manager = new LibraryManager(
        appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!,
        new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), naming, directoryService,
        null!, pathManager, dotIgnore, BaseItem.LocalizationManager, null!, new(() => externalData));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(manager, new UserRootFolder { Children = [] });
    var movieResolver = new MovieResolver(null!, NullLogger<MovieResolver>.Instance, naming, directoryService, new VideoListResolver(naming));
    manager.AddParts(
        [new CoreResolutionIgnoreRule(naming, paths), dotIgnore],
        [movieResolver, new FolderResolver()], [], [], []);

    var parent = new Folder
    {
        Id = Guid.Parse("98d00000-0000-0000-0000-000000000001"),
        Name = "Parent",
        Path = mediaPath
    };
    manager.CreateItem(parent, null);
    var filmDirectory = Path.Combine(mediaPath, "Film");
    Directory.CreateDirectory(filmDirectory);
    foreach (var file in sample.GetProperty("initialFiles").EnumerateArray())
    {
        WriteMedia(file.GetString()!);
    }

    await Validate(parent, directoryService);
    var oldPrimaryPath = Path.Combine(mediaPath, "Film", "Film - 2160p.mkv");
    var oldPrimaryId = manager.GetNewItemId(oldPrimaryPath, typeof(Movie));
    var oldPrimary = manager.GetItemById(oldPrimaryId) as Movie
        ?? throw new InvalidOperationException("Warm validation did not create the 2160p primary.");
    if (oldPrimary.PrimaryVersionId.HasValue || oldPrimary.OwnerId != Guid.Empty)
    {
        throw new InvalidOperationException("The 2160p control is not the warm primary.");
    }

    var remoteParent = new Folder
    {
        Id = Guid.Parse("98d00000-0000-0000-0000-000000000002"),
        Name = "Remote parent",
        Path = Path.Combine(stateRoot, "remote-parent")
    };
    manager.CreateItem(remoteParent, null);
    var remote = new Movie
    {
        Id = Guid.Parse("98d00000-0000-0000-0000-000000000003"),
        Name = "Remote linked alternate",
        Path = "https://media.invalid/film-linked.mkv",
        ParentId = remoteParent.Id,
        PrimaryVersionId = oldPrimary.Id
    };
    manager.CreateItem(remote, remoteParent);
    oldPrimary.LinkedAlternateVersions =
    [
        new LinkedChild { ItemId = remote.Id, Type = LinkedChildType.LinkedAlternateVersion }
    ];
    realPersistence.SaveItems([oldPrimary], CancellationToken.None);
    var manual = new BoxSet
    {
        Id = Guid.Parse("98d00000-0000-0000-0000-000000000004"),
        Name = "Manual incoming",
        LinkedChildren =
        [
            new LinkedChild { ItemId = oldPrimary.Id, Type = LinkedChildType.Manual }
        ]
    };
    manager.CreateItem(manual, null);
    using var before = factory.CreateDbContext();
    var beforeLinks = before.LinkedChildren.AsNoTracking().AsEnumerable()
        .Select(link => new { parentId = Id(link.ParentId), childId = Id(link.ChildId), childType = (int)link.ChildType, sortOrder = link.SortOrder })
        .OrderBy(link => link.parentId, StringComparer.Ordinal).ThenBy(link => link.sortOrder).ToArray();
    if (!beforeLinks.Any(link => link.parentId == Id(oldPrimary.Id) && link.childId == Id(remote.Id) && link.childType == 3))
    {
        throw new InvalidOperationException("The remote LinkedAlternateVersion was not persisted as ChildType=3.");
    }

    var stages = new List<object>();
    var currentPrimary = oldPrimary;
    foreach (var stage in sample.GetProperty("stages").EnumerateArray())
    {
        if (stage.TryGetProperty("add", out var additions))
        {
            foreach (var file in additions.EnumerateArray())
            {
                WriteMedia(file.GetString()!);
            }
        }

        if (stage.TryGetProperty("remove", out var removals))
        {
            foreach (var file in removals.EnumerateArray())
            {
                File.Delete(Path.Combine(mediaPath, file.GetString()!.Replace('/', Path.DirectorySeparatorChar)));
            }
        }

        parent.Children = [currentPrimary];
        parent.UserData = [];
        directoryService = new DirectoryService(fileSystem);
        trace.Clear();
        active = true;
        string? exception = null;
        try
        {
            await Validate(parent, directoryService);
        }
        catch (Exception error)
        {
            exception = error.GetType().Name;
        }
        finally
        {
            active = false;
        }

        var snapshot = Snapshot();
        stages.Add(new { exception, trace = trace.ToArray(), snapshot.rows, snapshot.links });
        var exactPath = Path.Combine(filmDirectory, "Film.mkv");
        var nextPath = File.Exists(exactPath) ? exactPath : Path.Combine(filmDirectory, "Film - 2160p.mkv");
        currentPrimary = manager.GetItemById(manager.GetNewItemId(nextPath, typeof(Movie))) as Movie ?? currentPrimary;
    }

    var final = Snapshot();
    results.Add(new
    {
        name = sample.GetProperty("name").GetString(),
        ids = new { oldPrimary = Id(oldPrimary.Id), remote = Id(remote.Id), manual = Id(manual.Id) },
        remotePath = remote.Path,
        beforeLinks,
        stages,
        final.rows,
        final.links
    });

    (object[] rows, object[] links) Snapshot()
    {
        using var db = factory.CreateDbContext();
        var rows = db.BaseItems.AsNoTracking().AsEnumerable()
            .Select(row => (object)new
            {
                id = Id(row.Id),
                type = row.Type,
                name = row.Name,
                path = ProjectPath(row.Path),
                parentId = row.ParentId.HasValue ? Id(row.ParentId.Value) : null,
                ownerId = row.OwnerId.HasValue ? Id(row.OwnerId.Value) : null,
                primaryVersionId = row.PrimaryVersionId.HasValue ? Id(row.PrimaryVersionId.Value) : null
            })
            .OrderBy(row => JsonSerializer.Serialize(row), StringComparer.Ordinal).ToArray();
        var links = db.LinkedChildren.AsNoTracking().AsEnumerable()
            .Select(link => (object)new
            {
                parentId = Id(link.ParentId), childId = Id(link.ChildId),
                childType = (int)link.ChildType, sortOrder = link.SortOrder
            })
            .OrderBy(link => JsonSerializer.Serialize(link), StringComparer.Ordinal).ToArray();
        return (rows, links);
    }

    async Task Validate(Folder folder, IDirectoryService service)
    {
        var method = typeof(Folder).GetMethod("ValidateChildrenInternal", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await (Task)method.Invoke(folder,
        [
            new InlineProgress(), false, false, false,
            new MetadataRefreshOptions(service), service, CancellationToken.None
        ])!;
    }

    void WriteMedia(string relative)
    {
        var file = Path.Combine(mediaPath, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "media control", new UTF8Encoding(false));
        File.SetCreationTimeUtc(file, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime());
        File.SetLastWriteTimeUtc(file, DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime());
    }

    string? ProjectPath(string? value) => value?.Replace(stateRoot, "$STATE", StringComparison.Ordinal);
}

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenRemoteLinkedReplacement = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }
        .Select(assembly => new
        {
            name = assembly.GetName().Name,
            sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
        }),
    scope = "Actual protected nonrecursive Folder.ValidateChildrenInternal with real warm CreateItems, EF SQLite, a persisted ChildType=3 remote linked alternate, and a manual incoming BoxSet link. Captures two- and three-version old-primary removal plus exact-primary demotion followed by exact-primary removal. Network, linked saver output, recursive validation, Web, migration, PostgreSQL native behavior and release acceptance are outside this oracle."
}, json) + "\n");

static string Id(Guid value) => value.ToString("D");

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>();
        ((Stub)(object)value).Handler = handler;
        return value;
    }

    public static object? Default(Type type) => type == typeof(void) ? null
        : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values)
    {
        try
        {
            return method.Invoke(target, values);
        }
        catch (TargetInvocationException error)
        {
            ExceptionDispatchInfo.Capture(error.InnerException!).Throw();
            throw;
        }
    }
}

public sealed class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public sealed class InlineProgress : IProgress<double>
{
    public void Report(double value)
    {
    }
}
