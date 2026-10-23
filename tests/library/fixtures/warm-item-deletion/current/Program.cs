// Same-run designated Native Playlist deletion and EF persistence consumers.
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
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
var results = new List<object>();
var stamp = DateTime.Parse("2025-01-03T04:05:06Z").ToUniversalTime();
foreach (var sample in input.EnumerateArray()) {
    var root = Path.GetFullPath(Path.Combine(args[2], sample.GetProperty("name").GetString()!));
    Directory.CreateDirectory(root);
    var calls = new List<object>(); var active = false;
    LibraryManager? manager = null; Playlist? target = null;
    string? internalMarker = null, externalMarker = null;
    var filename = sample.TryGetProperty("filename", out var filenameValue) ? filenameValue.GetString()! : "Target";
    var source = Path.Combine(root, Bool("managed") ? "data/playlists" : "media", filename);
    var parentPath = Path.GetDirectoryName(source)!;
    Directory.CreateDirectory(parentPath); Directory.CreateDirectory(Path.Combine(root, "media"));
    if (Bool("directory")) Write(Path.Combine(source, "source.txt"), "source"); else Write(source, "source");
    Write(Path.Combine(root, "media", "sibling.keep"), "sibling");
    Write(Path.Combine(root, "media", "Target.xml"), "sidecar");
    Write(Path.Combine(root, "media", "member.flac"), "member");
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_RootFolderPath" => Path.Combine(root, "root"), "get_ProgramDataPath" => root,
        "get_InternalMetadataPath" => Path.Combine(root, "metadata"), "get_DataPath" => Path.Combine(root, "data"),
        "get_TrickplayPath" => Path.Combine(root, "data", "trickplay"), _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { CacheSize = 64 }, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem; var directoryService = new DirectoryService(fileSystem);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
        ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (active && method.Name == "DeleteItem") calls.Add(new { action = "delete",
            ids = ((IReadOnlyList<Guid>)values![0]!).Select(Id).ToArray(), state = State() });
        return Stub.Forward(realPersistence, method, values);
    });
    var provider = Stub.Make<IProviderManager>((method, _) => Stub.Default(method.ReturnType));
    var pathManager = new PathManager(NullLogger<PathManager>.Instance, config, paths);
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            var item = (BaseItem)values![0]!;
            if (active) calls.Add(new { action = "external", id = Id(item.Id), state = State() });
            if (active && Bool("externalFailure")) throw new IOException("Controlled external cleanup failure.");
            var directory = Path.Combine(root, "data", "fixture-external", Id(item.Id));
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return Stub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Forward(manager!, method, values)
    });
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, null!, config, null!, new(() => null!), fileSystem,
        new(() => provider), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), new Emby.Naming.Common.NamingOptions(), directoryService,
        null!, pathManager, new DotIgnoreIgnoreRule(), BaseItem.LocalizationManager, null!, new(() => externalData));
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(manager, new UserRootFolder { Children = [] });
    var parent = new Folder { Id = Key(2), Name = "Parent", Path = parentPath }; Configure(parent); manager.CreateItem(parent, null);
    var member = new Audio { Id = Key(3), Name = "Member", Path = Path.Combine(root, "media", "member.flac"), ParentId = parent.Id };
    Configure(member); manager.CreateItem(member, parent);
    target = new Playlist { Id = Key(1), Name = "Target", Path = source, ParentId = parent.Id,
        OwnerUserId = Key(9), OpenAccess = true, IsInMixedFolder = Bool("mixed"), LinkedChildren = [new LinkedChild { ItemId = member.Id }] };
    Configure(target); manager.CreateItem(target, parent);
    var incoming = new Playlist { Id = Key(6), Name = "Incoming", Path = Path.Combine(root, "media", "Incoming.m3u"), ParentId = parent.Id,
        OwnerUserId = Key(9), LinkedChildren = [new LinkedChild { ItemId = target.Id }, new LinkedChild { ItemId = member.Id }] };
    Configure(incoming); manager.CreateItem(incoming, parent);
    BaseItem? closure = null;
    if (Bool("owned") || Bool("child")) {
        closure = sample.GetProperty("closureType").GetString() switch {
            "Video" => new Video { VideoType = MediaBrowser.Model.Entities.VideoType.VideoFile, IsInMixedFolder = true },
            "Folder" => new Folder(),
            "MusicArtist" => new MusicArtist(),
            _ => new Audio()
        };
        closure.Id = Key(4); closure.Name = "Closure"; closure.Path = Path.Combine(root, "media", closure is Folder ? "Closure" : closure is Video ? "closure.mkv" : "closure.flac");
        closure.ParentId = Bool("child") ? target.Id : parent.Id; closure.OwnerId = Bool("owned") ? target.Id : Guid.Empty;
        Configure(closure); Write(closure is Folder ? Path.Combine(closure.Path, "source.txt") : closure.Path, "closure");
        if (Bool("created")) manager.CreateItem(closure, parent); else realPersistence.SaveItems([closure], CancellationToken.None);
        Write(Path.Combine(closure.GetInternalMetadataPath(), "marker.txt"), "closure-internal");
        Write(Path.Combine(root, "data", "fixture-external", Id(closure.Id), "marker.txt"), "closure-external");
        if (Bool("warm")) _ = manager.GetItemById(closure.Id);
        if (Bool("cached")) target.Children = [closure];
    }
    if (Bool("nested")) {
        var nested = new Audio { Id = Key(5), Name = "Nested", Path = Path.Combine(root, "media", "nested.flac"), ParentId = closure!.Id };
        Configure(nested); Write(nested.Path, "nested"); realPersistence.SaveItems([nested], CancellationToken.None);
        Write(Path.Combine(nested.GetInternalMetadataPath(), "marker.txt"), "nested-internal");
    }
    parent.Children = [target]; parent.UserData = [];
    internalMarker = Path.Combine(target.GetInternalMetadataPath(), "marker.txt"); Write(internalMarker, "internal");
    externalMarker = Path.Combine(root, "data", "fixture-external", Id(target.Id), "marker.txt"); Write(externalMarker, "external");
    if (Bool("missing")) { if (Directory.Exists(source)) Directory.Delete(source, true); else File.Delete(source); }
    if (Bool("sqlFailure")) using (var fault = factory.CreateDbContext())
        fault.Database.ExecuteSqlRaw("CREATE TRIGGER deletion_failure BEFORE DELETE ON BaseItems BEGIN SELECT RAISE(ABORT, 'Controlled deletion failure'); END");
    var initialRows = Rows(); var initialLinks = Links(); var initialFiles = Files();
    manager.ItemRemoved += (_, change) => calls.Add(new { action = "event", id = Id(change.Item.Id),
        parentId = change.Parent is null ? null : Id(change.Parent.Id), state = State() });
    var plan = target.GetDeletePaths().Select(entry => new { path = Project(entry.FullName), directory = entry.IsDirectory }).ToArray();
    active = true; string? exception = null;
    FileStream? sourceLock = null, internalLock = null;
    try {
        if (Bool("sourceFailure")) sourceLock = new FileStream(Bool("directory") ? Path.Combine(source, "source.txt") : source,
            FileMode.Open, FileAccess.Read, FileShare.None);
        if (Bool("internalFailure")) internalLock = new FileStream(internalMarker, FileMode.Open, FileAccess.Read, FileShare.None);
        var options = new DeleteOptions { DeleteFileLocation = Bool("deleteSource") };
        if (Bool("nullParent")) manager.DeleteItem(target, options, null!, !Bool("noNotify"));
        else manager.DeleteItem(target, options, !Bool("noNotify"));
    } catch (Exception error) { exception = error.GetType().Name; if (exception != Expected()) Console.Error.WriteLine(error); }
    finally { sourceLock?.Dispose(); internalLock?.Dispose(); }
    if (exception != Expected()) throw new InvalidOperationException("Unexpected exception for " + sample.GetProperty("name").GetString() + ": " + exception);
    var firstRows = Rows(); var firstLinks = Links(); var firstFiles = Files();
    var firstCalls = calls.ToArray();
    var lookedUp = manager.GetItemById(closure!.Id);
    var lookupAfterFirst = lookedUp is not null;
    var firstClosureParentId = lookedUp is null ? null : Id(lookedUp.ParentId);
    calls.Clear(); string? secondException = null;
    if (lookedUp is not null) {
        try { manager.DeleteItem(lookedUp, new DeleteOptions { DeleteFileLocation = Bool("secondSource") }); }
        catch (Exception error) { secondException = error.GetType().Name; Console.Error.WriteLine(error); }
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), initialRows, initialLinks, initialFiles, plan, exception,
        firstRows, firstLinks, firstFiles, firstCalls, lookupAfterFirst, firstClosureParentId, secondException, calls,
        rows = Rows(), links = Links(), files = Files(), targetParentId = Id(target.ParentId), targetLookup = manager.GetItemById(target.Id) is not null,
        closureLookup = closure is null ? (bool?)null : manager.GetItemById(closure.Id) is not null,
        parentChildrenCleared = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null,
        parentUserDataCleared = parent.UserData is null });

    bool Bool(string name) => sample.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    string? Expected() => sample.TryGetProperty("expectException", out var value) ? value.GetString() : null;
    string Project(string value) {
        if (value == root) return "$STATE";
        if (!value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !value.StartsWith(root + Path.AltDirectorySeparatorChar, StringComparison.Ordinal)) return value;
        return "$STATE" + value[root.Length..].Replace(Path.DirectorySeparatorChar, '\\').Replace(Path.AltDirectorySeparatorChar, '\\');
    }
    void Write(string filename, string text) { Directory.CreateDirectory(Path.GetDirectoryName(filename)!); File.WriteAllBytes(filename, Encoding.UTF8.GetBytes(text)); }
    object State() { using var phase = factory.CreateDbContext(); return new {
        sourceExists = File.Exists(source) || Directory.Exists(source), internalExists = internalMarker is not null && File.Exists(internalMarker),
        externalExists = externalMarker is not null && File.Exists(externalMarker), databaseExists = phase.BaseItems.AsNoTracking().Any(row => row.Id == target!.Id),
        parentId = target is null ? null : Id(target.ParentId) }; }
    object[] Rows() {
        using var context = factory.CreateDbContext();
        return context.BaseItems.AsNoTracking().AsEnumerable().OrderBy(row => Id(row.Id), StringComparer.Ordinal).Select(row => {
            var columns = new Dictionary<string, object?>();
            foreach (var property in context.Model.FindEntityType(typeof(BaseItemEntity))!.GetProperties()) {
                var value = property.PropertyInfo!.GetValue(row);
                columns[property.Name] = value switch { Guid key => Id(key), DateTime date => date.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ"),
                    Enum enumeration => Convert.ToInt32(enumeration), string text when property.Name == "Path" => Project(text),
                    string text when property.Name == "Data" => ProjectJson(text), _ => value };
            }
            return (object)columns;
        }).ToArray();
    }
    string ProjectJson(string text) {
        var node = JsonNode.Parse(text); Rewrite(node); return node!.ToJsonString();
        void Rewrite(JsonNode? current) {
            if (current is JsonObject obj) foreach (var pair in obj.ToArray()) {
                if (pair.Value is JsonValue value && value.TryGetValue<string>(out var s)) obj[pair.Key] = Project(s); else Rewrite(pair.Value);
            } else if (current is JsonArray array) for (var i = 0; i < array.Count; i++) {
                if (array[i] is JsonValue value && value.TryGetValue<string>(out var s)) array[i] = Project(s); else Rewrite(array[i]);
            }
        }
    }
    object[] Links() { using var context = factory.CreateDbContext(); return context.LinkedChildren.AsNoTracking().AsEnumerable()
        .OrderBy(row => Id(row.ParentId), StringComparer.Ordinal).ThenBy(row => row.SortOrder)
        .Select(row => (object)new { ParentId = Id(row.ParentId), ChildId = Id(row.ChildId), row.SortOrder, ChildType = (int)row.ChildType }).ToArray(); }
    object[] Files() => Directory.GetFiles(root, "*", SearchOption.AllDirectories).Where(file => file != Path.Combine(root, "native.db"))
        .OrderBy(Project, StringComparer.Ordinal).Select(file => (object)new { path = Project(file), sha256 = Hash(File.ReadAllBytes(file)) }).ToArray();
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualWarmItemDeletion = true, 
    inputSha256 = Hash(Encoding.UTF8.GetBytes(inputText)), results,
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(LibraryManager).Assembly, typeof(ItemPersistenceService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }),
    scope = "Same-run designated Native LibraryManager/ItemPersistenceService with EF SQLite/files/cache/events over all 24 neutral cases, including 8 created-and-registered variants. Application paths, path reversal, collection-folder resolver, external cleanup provider and selected static collaborators are explicit controls. Authentication, HTTP, complete metadata/scanner coverage, clients, instance exchange and release acceptance are outside this component scope." }, json) + "\n");
static Guid Key(int key) => Guid.Parse("99d00000-0000-0000-0000-" + key.ToString("D12"));
static string Id(Guid value) => value.ToString("D");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
void Configure(BaseItem item) { item.DateCreated = stamp; item.DateModified = stamp; item.DateLastSaved = stamp; item.DateLastRefreshed = stamp; }
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) { try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
