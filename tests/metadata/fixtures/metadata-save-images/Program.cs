// Actual frozen LibraryManager saver/image/repository pipeline over EF SQLite.
using System.Net;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
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
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => new List<MediaStream>(), _ => Stub.Default(method.ReturnType)
});
var inputText = File.ReadAllText(args[0]); var input = JsonDocument.Parse(inputText).RootElement;
var picture = File.ReadAllBytes(args[3]);
var json = new JsonSerializerOptions { WriteIndented = true }; json.Converters.Add(new JsonStringEnumConverter());
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var root = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!)); Directory.CreateDirectory(root);
    var calls = new List<object>(); var active = false;
    using var cancellation = new CancellationTokenSource();
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 }, "get_ApplicationPaths" => paths,
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fileSystem;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "SaveImagesAsync") calls.Add(new { action = "images", images = ProjectImages((BaseItem)values![0]!) });
        if (active && method.Name == "SaveItems") calls.Add(new { action = "save", cancellable = ((CancellationToken)values![1]!).CanBeCanceled });
        return Stub.Forward(realPersistence, method, values);
    });
    var parent = sample.TryGetProperty("parentSource", out var parentSource) ? new Folder {
        Id = Guid.Parse("98b90000-0000-0000-0000-000000000002"), Name = "Parent", Path = Path.Combine(root, "media"),
        ChannelId = parentSource.ValueKind == JsonValueKind.String && parentSource.GetString() == "Channel" ? Guid.Parse("98b90000-0000-0000-0000-000000000003") : Guid.Empty
    } : null;
    var owner = new Movie { Id = Guid.Parse("98b90000-0000-0000-0000-000000000001"), Name = "Stored name",
        Path = Path.Combine(root, "media", "movie.mkv"), ParentId = parent?.Id ?? Guid.Empty,
        ChannelId = sample.TryGetProperty("source", out var source) && source.GetString() == "Channel" ? Guid.Parse("98b90000-0000-0000-0000-000000000003") : Guid.Empty };
    var provider = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name == "SaveMetadataAsync") {
            if (active) calls.Add(new { action = "saver", reason = (int)(ItemUpdateType)values![1]! });
            if (active && sample.TryGetProperty("cancelInSaver", out var cancelInSaver) && cancelInSaver.GetBoolean()) cancellation.Cancel();
            return Task.CompletedTask;
        }
        if (method.Name == "SaveImage") {
            var item = (BaseItem)values![0]!; var url = (string)values[1]!; var type = (ImageType)values[2]!; var index = (int)values[3]!;
            calls.Add(new { action = "fetch", url, cancellable = ((CancellationToken)values[4]!).CanBeCanceled });
            if (url.EndsWith("404", StringComparison.Ordinal)) throw new HttpRequestException("Missing image", null, HttpStatusCode.NotFound);
            if (url.EndsWith("500", StringComparison.Ordinal)) throw new HttpRequestException("Retryable image", null, HttpStatusCode.InternalServerError);
            var target = Path.Combine(root, "metadata", "library", "98", item.Id.ToString("N"), type == ImageType.Primary ? "poster.png" : "backdrop.png");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.WriteAllBytes(target, picture); File.SetLastWriteTimeUtc(target, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime());
            item.SetImage(new ItemImageInfo { Path = target, Type = type, Width = 0, Height = 0, DateModified = DateTime.MinValue }, index);
            return Task.CompletedTask;
        }
        return Stub.Default(method.ReturnType);
    });
    var processor = Stub.Make<IImageProcessor>((method, values) => {
        if (method.Name == "GetImageDimensions") {
            calls.Add(new { action = "dimensions", path = ProjectPath(((ItemImageInfo)values![1]!).Path) });
            if (sample.TryGetProperty("dimensionFailure", out var failure) && failure.GetBoolean()) throw new IOException("Injected dimensions failure");
            return new ImageDimensions(1, 1);
        }
        if (method.Name == "GetImageBlurHash") {
            calls.Add(new { action = "blurhash", path = ProjectPath((string)values![0]!) });
            if (sample.TryGetProperty("blurFailure", out var failure) && failure.GetBoolean()) throw new IOException("Injected BlurHash failure");
            return "controlled";
        }
        return Stub.Default(method.ReturnType);
    });
    LibraryManager? manager = null;
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        "GetItemById" => values![0] is Guid id && parent?.Id == id ? parent : values![0] is Guid child && owner.Id == child ? owner : null,
        _ => Stub.Forward(manager!, method, values)
    });
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        processor, new NamingOptions(), new DirectoryService(fileSystem), null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, new UserRootFolder { Children = [] });
    if (parent is not null) manager.CreateItem(parent, null);
    Directory.CreateDirectory(Path.Combine(root, "media")); File.WriteAllText(owner.Path, "media control");
    foreach (var image in sample.GetProperty("images").EnumerateArray()) {
        var value = new ItemImageInfo { Type = Enum.Parse<ImageType>(image.GetProperty("type").GetString()!),
            Path = image.GetProperty("path").GetString()!, Width = image.TryGetProperty("ready", out var ready) && ready.GetBoolean() ? 1 : 0,
            Height = ready.ValueKind == JsonValueKind.True ? 1 : 0, BlurHash = ready.ValueKind == JsonValueKind.True ? "controlled" : null,
            DateModified = image.TryGetProperty("date", out var date) ? DateTime.Parse(date.GetString()!).ToUniversalTime() : DateTime.MinValue };
        if (!value.Path.StartsWith("http", StringComparison.Ordinal)) {
            value.Path = Path.Combine(root, value.Path);
            if (!image.TryGetProperty("missing", out var missing) || !missing.GetBoolean()) {
                Directory.CreateDirectory(Path.GetDirectoryName(value.Path)!); File.WriteAllBytes(value.Path, picture); File.SetLastWriteTimeUtc(value.Path, DateTime.Parse("2025-01-02T03:04:05Z").ToUniversalTime());
            }
        }
        owner.SetImage(value, 0);
    }
    manager.CreateItem(owner, parent);
    if (sample.TryGetProperty("clearImages", out var clear) && clear.GetBoolean()) owner.ImageInfos = [];
    if (sample.TryGetProperty("failure", out var failureKind)) using (var fault = factory.CreateDbContext()) {
        fault.Database.ExecuteSqlRaw(failureKind.GetString() == "images"
            ? "CREATE TRIGGER injected_image_failure BEFORE INSERT ON BaseItemImageInfos BEGIN SELECT RAISE(ABORT, 'Injected image insertion failure'); END"
            : "CREATE TRIGGER injected_item_failure BEFORE UPDATE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Injected metadata update failure'); END");
    }
    manager.ItemUpdated += (_, args) => calls.Add(new { action = "event", reason = (int)args.UpdateReason });
    owner.Name = "Updated name"; active = true;
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    string? exception = null;
    try { await manager.UpdateItemAsync(owner, parent!, (ItemUpdateType)sample.GetProperty("reason").GetInt32(), cancellation.Token); }
    catch (Exception error) {
        exception = error.GetType().Name;
        if (exception != (sample.TryGetProperty("expectException", out var expectedError) ? expectedError.GetString() : null)) Console.Error.WriteLine(error);
    }
    if (exception != (sample.TryGetProperty("expectException", out var expected) ? expected.GetString() : null)) throw new InvalidOperationException("Unexpected exception for " + sample.GetProperty("name").GetString() + ": " + exception);
    using var final = factory.CreateDbContext();
    var stored = final.BaseItems.AsNoTracking().Single(row => row.Id == owner.Id);
    var images = final.BaseItemImageInfos.AsNoTracking().Where(row => row.ItemId == owner.Id).AsEnumerable().Select(row => new {
        path = ProjectPath(row.Path), type = row.ImageType, width = row.Width, height = row.Height,
        blurhash = row.Blurhash is null ? null : Encoding.UTF8.GetString(row.Blurhash), date = row.DateModified?.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'")
    }).OrderBy(row => row.type).ToArray();
    var files = Directory.GetFiles(root, "*.png", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
        .Select(file => new { path = ProjectPath(file), sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant() }).ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, calls, storedName = stored.Name, images, liveImages = ProjectImages(owner), files });
    string? ProjectPath(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
    object[] ProjectImages(BaseItem item) => item.ImageInfos.Select(image => (object)new { path = ProjectPath(image.Path), type = image.Type,
        width = image.Width, height = image.Height, blurhash = image.BlurHash, date = image.DateModified.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'") }).ToArray();
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualFrozenMetadataSaveImages = true, inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    imageSha256 = Convert.ToHexString(SHA256.HashData(picture)).ToLowerInvariant(), results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    }),
    scope = "Actual frozen LibraryManager.UpdateItemAsync/RunMetadataSavers/UpdateImagesAsync/ConvertImageToLocal and ItemPersistenceService over EF SQLite. Tests unconditional images, independent conversion commits/events, local freshness/live-TV gates, cancellation and real SQL failures. Metadata saver, SaveImage HTTP/file destination and image dimensions/BlurHash are controls. Real files and exact image projections are compared; no complete providers, real network/NFO, full scalar mapper, version creation or release acceptance."
}, json) + "\n");

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
