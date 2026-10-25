using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Manager;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteObserved = false;
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => {
    if (name != "e_sqlite3") return IntPtr.Zero;
    sqliteObserved = true; return sqliteHandle;
});
SQLitePCL.Batteries_V2.Init();
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var picture = File.ReadAllBytes(args[3]);
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var root = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!)); Directory.CreateDirectory(root);
    var calls = new List<object>(); var saves = new List<object>(); var active = false;
    var operation = sample.GetProperty("operation").GetString()!;
    var failure = sample.TryGetProperty("failure", out var failed) ? failed.GetString() : null;
    var first = sample.GetProperty("first").GetBoolean();
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => Path.Combine(root, "metadata"), _ => Stub.Default(method.ReturnType) });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64, PreferredMetadataLanguage = "en", MetadataCountryCode = "US" },
        "get_ApplicationPaths" => paths, _ => Stub.Default(method.ReturnType) });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fileSystem;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    LibraryManager? manager = null;
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Forward(manager!, method, values) });
    BaseItem.LibraryManager = library;
    var baseManager = Stub.Make<IBaseItemManager>((method, _) => method.Name == "IsMetadataFetcherEnabled" ? true : Stub.Default(method.ReturnType));
    using var providers = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance,
        fileSystem, null!, library, baseManager, null!, null!, null!, null!);
    var processor = Stub.Make<IImageProcessor>((method, _) => method.Name switch {
        "GetImageDimensions" => new ImageDimensions(8, 6), "GetImageBlurHash" => "controlled", _ => Stub.Default(method.ReturnType) });
    var directory = new DirectoryService(fileSystem);
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => providers), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        processor, new NamingOptions(), directory, null!, null!, null!, BaseItem.LocalizationManager, null!, new(() => null!));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, new UserRootFolder { Children = [] });
    var book = new Book { Id = Guid.Parse("c1700000-0000-0000-0000-000000000001"), Name = "Stored book",
        DateLastRefreshed = first ? DateTime.MinValue : new DateTime(2026, 10, 1) };
    foreach (var filename in new[] { "old.png", "new.png", "second.png", "probe.png" }) {
        var target = Path.Combine(root, filename); File.WriteAllBytes(target, picture);
        File.SetLastWriteTimeUtc(target, new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Utc));
    }
    book.SetImage(Image("old.png", ImageType.Primary, true), 0);
    manager.CreateItem(book, null);
    DateTime? initialStamp;
    using (var before = factory.CreateDbContext()) initialStamp = before.BaseItems.AsNoTracking().Single(item => item.Id == book.Id).DateLastRefreshed;
    manager.ItemUpdated += (_, update) => { if (active) saves.Add(new { reason = (int)update.UpdateReason, update.Item.Overview, images = ProjectImages(update.Item) }); };
    var custom = new CustomProvider { Order = 0, Fetch = item => {
        calls.Add(new { provider = "first", images = Paths(item) });
        if (operation == "replace") item.SetImage(Image("new.png", ImageType.Primary), 0);
        else if (operation == "remove") item.ImageInfos = [];
        else item.SetImage(Image("new.png", ImageType.Backdrop), 0);
        item.Overview = "Custom overview";
        if (failure == "provider") throw new IOException("Controlled custom image failure.");
        if (failure == "cancel") throw new OperationCanceledException("Controlled custom image cancellation.");
        return Task.FromResult(ItemUpdateType.MetadataImport | ItemUpdateType.ImageUpdate);
    } };
    var observer = new CustomProvider { Order = 1, Fetch = item => {
        calls.Add(new { provider = "second", images = Paths(item) });
        if (operation == "sequential") item.SetImage(Image("second.png", ImageType.Primary), 0);
        return Task.FromResult(ItemUpdateType.None);
    } };
    var parts = new List<IMetadataProvider> { custom, observer };
    if (sample.TryGetProperty("probe", out var probe) && probe.GetBoolean()) parts.Add(new PreProvider { Fetch = async item => {
        calls.Add(new { provider = "probe", images = Paths(item) });
        item.SetImage(Image("probe.png", ImageType.Primary), 0);
        await manager.UpdateItemAsync(item, null!, ItemUpdateType.ImageUpdate, CancellationToken.None);
        return ItemUpdateType.ImageUpdate;
    } });
    providers.AddParts([], [], parts, [], [], []);
    if (failure == "images") using (var fault = factory.CreateDbContext()) fault.Database.ExecuteSqlRaw(
        "CREATE TRIGGER controlled_image_failure BEFORE INSERT ON BaseItemImageInfos WHEN NEW.Path LIKE '%new.png' BEGIN SELECT RAISE(ABORT, 'Controlled image SQL failure'); END");
    var service = new BookMetadataService(config, NullLogger<BookMetadataService>.Instance, providers, fileSystem, library, null!, repository);
    var options = new MetadataRefreshOptions(directory) { MetadataRefreshMode = MetadataRefreshMode.FullRefresh, ImageRefreshMode = MetadataRefreshMode.None };
    active = true; string? exception = null; int? updateType = null;
    try { updateType = (int)await service.RefreshMetadata(book, options, CancellationToken.None); }
    catch (Exception error) { exception = error.GetType().Name; if (failure is not ("cancel" or "images")) throw; }
    using var final = factory.CreateDbContext();
    var row = final.BaseItems.AsNoTracking().Single(item => item.Id == book.Id);
    var storedImages = final.BaseItemImageInfos.AsNoTracking().Where(item => item.ItemId == book.Id).AsEnumerable()
        .Select(image => new { path = Path.GetFileName(image.Path), type = image.ImageType.ToString(), width = image.Width, height = image.Height,
            blurhash = image.Blurhash is null ? null : Encoding.UTF8.GetString(image.Blurhash) }).OrderBy(image => image.type).ToArray();
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, errorOccurred = exception is not null, updateType, calls, saves, row.Overview, storedImages,
        stampChanged = row.DateLastRefreshed != initialStamp, liveImages = ProjectImages(book) });
    ItemImageInfo Image(string filename, ImageType type, bool ready = false) => new() { Path = Path.Combine(root, filename), Type = type,
        Width = ready ? 8 : 0, Height = ready ? 6 : 0, BlurHash = ready ? "controlled" : null,
        DateModified = new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Utc) };
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Hash(inputBytes), imageSha256 = Hash(picture), results, sqlite = new { runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, filename = sqliteFilename, sha256 = Hash(File.ReadAllBytes(sqliteFilename)), resolverObserved = sqliteObserved, version = SQLitePCL.raw.sqlite3_libversion().utf8_to_string() },
    scope = "Actual BookMetadataService.RefreshMetadata, ProviderManager selection and sequential custom mutation, LibraryManager saver/image/repository lifecycle, ItemPersistenceService and EF SQLite. Real local image files and real SQL insertion failure. Custom metadata actions, pre-refresh probe stand-in and image dimensions/BlurHash are controlled. No production photo decoding, native full server or external network is claimed.",
    assemblies = new[] { typeof(Book).Assembly, typeof(BookMetadataService).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly, typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly, typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static string[] Paths(BaseItem item) => item.ImageInfos.Select(image => Path.GetFileName(image.Path)).ToArray();
static object[] ProjectImages(BaseItem item) => item.ImageInfos.Select(image => (object)new { path = Path.GetFileName(image.Path), type = image.Type.ToString(),
    width = image.Width, height = image.Height, blurhash = image.BlurHash }).OrderBy(image => JsonSerializer.Serialize(image)).ToArray();
public sealed class CustomProvider : ICustomMetadataProvider<Book>, IHasItemChangeMonitor, IHasOrder {
    public Func<Book, Task<ItemUpdateType>> Fetch = null!; public int Order { get; set; }
    public string Name => "Controlled custom image " + Order;
    public bool HasChanged(BaseItem item, IDirectoryService directory) => true;
    public Task<ItemUpdateType> FetchAsync(Book item, MetadataRefreshOptions options, CancellationToken token) => Fetch(item);
}
public sealed class PreProvider : ICustomMetadataProvider<Book>, IPreRefreshProvider, IForcedProvider, IHasItemChangeMonitor {
    public Func<Book, Task<ItemUpdateType>> Fetch = null!; public string Name => "Controlled independent image probe";
    public bool HasChanged(BaseItem item, IDirectoryService directory) => true;
    public Task<ItemUpdateType> FetchAsync(Book item, MetadataRefreshOptions options, CancellationToken token) => Fetch(item);
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
