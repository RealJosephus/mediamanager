// Validation only: same-run designated special-folder resolvers and persistence.
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Emby.Server.Implementations.Library.Resolvers.Movies;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Playlists;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

var nativeName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "e_sqlite3.dll"
    : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFilename = Path.Combine(AppContext.BaseDirectory, nativeName);
var nativeHandle = NativeLibrary.Load(nativeFilename);
var nativeResolverObserved = false;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
{
    if (name != "e_sqlite3") return IntPtr.Zero;
    nativeResolverObserved = true;
    return nativeHandle;
});
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var output = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
var discoveryOrder = typeof(PlaylistResolver).Assembly.GetExportedTypes()
    .Where(type => type == typeof(PlaylistResolver) || type == typeof(BoxSetResolver)).ToArray();
var results = new List<object>();
var index = 0;
foreach (var sample in input.EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(stateRoot, name);
    var media = Path.Combine(root, "media");
    Directory.CreateDirectory(media);
    foreach (var relative in Strings("directories")) Directory.CreateDirectory(Path.Combine(media, Native(relative)));
    foreach (var relative in Strings("files"))
    {
        var filename = Path.Combine(media, Native(relative));
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        File.WriteAllBytes(filename, Encoding.UTF8.GetBytes("neutral fixture file"));
    }
    var filesBefore = SnapshotTree(media);
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch
    {
        "get_RootFolderPath" => Path.Combine(root, "root"), "get_ProgramDataPath" => root,
        "get_InternalMetadataPath" => Path.Combine(root, "metadata"), "get_DataPath" => Path.Combine(root, "data"),
        _ => Stub.Default(method.ReturnType)
    });
    var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
    {
        "get_Configuration" => new ServerConfiguration(), "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = true },
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem;
    var directoryService = new DirectoryService(fileSystem);
    Folder parent = sample.TryGetProperty("parentKind", out _) ? new PlaylistsFolder() : new Folder();
    parent.Id = Guid.Parse("15000000-0000-0000-0000-000000000099");
    parent.Name = "Physical root"; parent.Path = media;
    var subjectId = Guid.Parse($"15000000-0000-0000-0000-{++index:D12}");
    var manager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetLibraryOptions" => new LibraryOptions(), "GetNewItemId" => subjectId,
        "GetItemById" => values![0] is Guid key && key == parent.Id ? parent : null,
        "GetCollectionFolders" => new List<Folder>(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.LibraryManager = manager;
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
        ? values![0] : Stub.Default(method.ReturnType));
    var target = Path.Combine(media, Native(sample.GetProperty("target").GetString()!));
    var info = fileSystem.GetFileSystemInfo(target);
    var children = info.IsDirectory ? directoryService.GetFileSystemEntries(target) : [];
    if (sample.TryGetProperty("trailingSeparator", out var trailing) && trailing.GetBoolean()) info.FullName += Path.DirectorySeparatorChar;
    if (sample.TryGetProperty("enumerationError", out _)) info.FullName = Path.Combine(media, "absent-native-directory");
    var resolve = new ItemResolveArgs(paths, manager)
    {
        Parent = parent, FileInfo = info, FileSystemChildren = children, LibraryOptions = new LibraryOptions(),
        CollectionType = sample.TryGetProperty("collectionType", out var collection) ? Enum.Parse<CollectionType>(collection.GetString()!) : null
    };
    var resolverName = sample.GetProperty("resolver").GetString();
    var resolvers = resolverName == "chain" ? discoveryOrder.Select(type => (IItemResolver)Activator.CreateInstance(type)!).ToArray()
        : [resolverName == "boxset" ? (IItemResolver)new BoxSetResolver() : new PlaylistResolver()];
    BaseItem? item = null;
    foreach (var resolver in resolvers.OrderBy(value => value.Priority))
    {
        item = resolver.ResolvePath(resolve);
        if (item is not null) break;
    }
    object? storedProjection = null;
    object? liveProjection = null;
    object? lookupProjection = null;
    if (item is not null)
    {
        ResolverHelper.SetInitialItemValues(item, resolve, fileSystem, manager);
        // Timestamp and identity controls are independent of runtime wall clock.
        item.DateCreated = new DateTime(2026, 10, 9, 1, 2, 3, DateTimeKind.Utc);
        item.DateModified = new DateTime(2026, 10, 9, 2, 3, 4, DateTimeKind.Utc);
        liveProjection = Project(item);
        var factory = new SqlFactory(Path.Combine(root, "native.db"));
        using (var context = factory.CreateDbContext())
        {
            context.Database.EnsureCreated();
            context.BaseItems.Add(BaseItemMapper.Map(parent, appHost));
            context.SaveChanges();
        }
        new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance).SaveItems([item], CancellationToken.None);
        using var final = factory.CreateDbContext();
        var row = final.BaseItems.AsNoTracking().Include(value => value.Provider).Include(value => value.LockedFields)
            .Include(value => value.TrailerTypes).Include(value => value.Images).Include(value => value.LinkedChildEntities)
            .Single(value => value.Id == item.Id);
        lookupProjection = Project(BaseItemMapper.DeserializeBaseItem(row, NullLogger<BaseItem>.Instance, appHost)
            ?? throw new InvalidOperationException("The saved resolver entity did not hydrate."));
        var properties = final.Model.FindEntityType(typeof(BaseItemEntity))!.GetProperties().ToArray();
        if (properties.Length != 72) throw new InvalidOperationException("Expected 72 mapped columns.");
        var dataText = row.Data?.Replace(root.Replace("\\", "\\\\", StringComparison.Ordinal), "$STATE", StringComparison.Ordinal)
            .Replace(root, "$STATE", StringComparison.Ordinal);
        var columns = properties.ToDictionary(property => property.Name, property =>
        {
            var value = property.PropertyInfo!.GetValue(row);
            if (value is null) return null;
            if (property.Name == "Data") return (object?)JsonNode.Parse(dataText!);
            if (value is Guid identifier) return identifier.ToString("D").ToLowerInvariant();
            if (value is DateTime date) return date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
            if (value is string text) return text.Replace(root, "$STATE", StringComparison.Ordinal);
            return value;
        });
        storedProjection = new { columnCount = properties.Length, columns, dataIsNull = row.Data is null, dataText,
            data = dataText is null ? null : JsonNode.Parse(dataText),
            providers = final.BaseItemProviders.AsNoTracking().Where(value => value.ItemId == item.Id)
                .OrderBy(value => value.ProviderId).Select(value => new { value.ProviderId, value.ProviderValue }).ToArray() };
    }
    results.Add(new { name, resolved = liveProjection, stored = storedProjection, lookup = lookupProjection,
        filesBefore, filesAfter = SnapshotTree(media) });

    IEnumerable<string> Strings(string property) => sample.TryGetProperty(property, out var values)
        ? values.EnumerateArray().Select(value => value.GetString()!) : [];
    string Native(string value) => value.Replace('/', Path.DirectorySeparatorChar);
    object Project(BaseItem subject) => new
    {
        type = subject.GetType().FullName, id = subject.Id.ToString("D").ToLowerInvariant(),
        parentId = subject.ParentId.ToString("D").ToLowerInvariant(), name = subject.Name,
        path = subject.Path.Replace(root, "$STATE", StringComparison.Ordinal).Replace('\\', '/'),
        subject.IsFolder, mediaType = subject.MediaType.ToString(), subject.IsInMixedFolder,
        isRoot = ((Folder)subject).IsRoot, subject.IsLocked, size = subject.Size,
        openAccess = subject is Playlist playlist ? (bool?)playlist.OpenAccess : null,
        playlistMediaType = subject is Playlist typed ? typed.PlaylistMediaType.ToString() : null,
        providers = subject.ProviderIds,
    };
}
var validationPlaylist = new Playlist { Path = Path.Combine(stateRoot, "no-real-directory.m3u") };
var validationProgress = new List<double>();
await validationPlaylist.ValidateChildren(new ProgressCapture(validationProgress), new MetadataRefreshOptions((IDirectoryService)null!),
    recursive: true, allowRemoveRoot: true, cancellationToken: new CancellationToken(true));
var assemblies = new[] { typeof(PlaylistResolver).Assembly, typeof(BaseItem).Assembly, typeof(BaseItemMapper).Assembly,
        typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly, typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly }
    .Distinct()
    .OrderBy(assembly => assembly.GetName().Name, StringComparer.Ordinal).Select(assembly => new
    {
        name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    }).ToArray();
File.WriteAllText(output, JsonSerializer.Serialize(new
{
    actualExecution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    discoveryOrder = discoveryOrder.Select(type => type.FullName), results, assemblies,
    nativeSqlite = new { name = nativeName, path = nativeFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier,
        resolverObserved = nativeResolverObserved,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(nativeFilename))).ToLowerInvariant() },
    playlistValidation = new { completedWithCancelledToken = true, progress = validationProgress },
    boundary = "Actual designated BoxSetResolver/PlaylistResolver, effective resolver order, ResolverHelper, ManagedFileSystem, DirectoryService, BaseItemMapper, ItemPersistenceService and DeserializeBaseItem with EF SQLite. Neutral paths/files are real; identity, parent lookup, timestamp and virtual-path reversal are controlled. Playlist.ValidateChildren is probed with a cancelled token and inaccessible path. This is not complete LibraryManager resolver composition, linked playlist parsing, full scan, provider/network, HTTP, exchange or release acceptance."
}, json) + "\n");

static object[] SnapshotTree(string root) => Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories)
    .OrderBy(value => Path.GetRelativePath(root, value).Replace('\\', '/'), StringComparer.Ordinal).Select(filename =>
    {
        var file = File.Exists(filename);
        return (object)new { path = Path.GetRelativePath(root, filename).Replace('\\', '/'), kind = file ? "file" : "directory",
            bytes = file ? (long?)new FileInfo(filename).Length : null,
            sha256 = file ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant() : null };
    }).ToArray();

public class ProgressCapture(List<double> values) : IProgress<double> { public void Report(double value) => values.Add(value); }
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
