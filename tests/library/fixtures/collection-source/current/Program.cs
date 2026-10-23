using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;

var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
    name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var root = Path.GetFullPath(Path.Combine(args[0], "instance")); Directory.CreateDirectory(root);
var configuration = new ServerConfiguration { CacheSize = 64, EnableCaseSensitiveItemIds = false };
var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
    "get_ProgramDataPath" => root, "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
    "get_DataPath" => Path.Combine(root, "data"), _ => Stub.Default(method.ReturnType)
});
var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
    "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
    "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
    ? values![0] : Stub.Default(method.ReturnType));
var factory = new SqlFactory(Path.Combine(root, "native.db"));
using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = repository;
var manager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
void Field(string name, object value) => typeof(LibraryManager).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, value);
Field("_configurationManager", config); Field("_logger", NullLogger<LibraryManager>.Instance);
Field("_cache", Activator.CreateInstance(typeof(LibraryManager).GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)!.FieldType, [64])!);
Field("_itemRepository", repository); Field("_userRootFolder", new UserRootFolder { Children = [] });
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetCollectionFolders"
    ? new List<Folder>() : Stub.Forward(manager, method, values));
Guid Id(int number) => Guid.Parse("cb210000-0000-0000-0000-" + number.ToString("D12"));
var input = File.ReadAllBytes(args[1]); var specification = JsonSerializer.Deserialize<Input>(input)!;
using (var context = factory.CreateDbContext()) {
    context.BaseItems.Add(new BaseItemEntity { Id = Guid.Empty, Type = typeof(Folder).FullName!, Name = "Empty anchor", Data = "{}", TopParentId = Id(2), IsFolder = true });
    foreach (var item in specification.Items) {
        var type = item.Kind == "Movie" ? typeof(Movie).FullName! : item.Kind == "BoxSet" ? typeof(BoxSet).FullName!
            : item.Kind == "PlaylistsFolder" ? typeof(Emby.Server.Implementations.Playlists.PlaylistsFolder).FullName!
            : item.Kind == "Playlist" ? typeof(Playlist).FullName!
            : item.Kind == "Unknown" ? "Controlled.Unknown.Type" : "MediaBrowser.Controller.Entities." + item.Kind;
        context.BaseItems.Add(new BaseItemEntity { Id = Id(item.Number), Type = type, Name = item.Name ?? "Item " + item.Number,
            SortName = item.Sort ?? item.Number.ToString("D6"), Data = item.Data ?? "{}", Path = "Z:\\CollectionSource\\" + item.Number,
            ParentId = item.Parent.HasValue ? Id(item.Parent.Value) : null, TopParentId = item.Top.HasValue ? Id(item.Top.Value) : null,
            OwnerId = item.Owner.HasValue ? Id(item.Owner.Value) : null, PrimaryVersionId = item.PrimaryEmpty ? Guid.Empty : item.Primary.HasValue ? Id(item.Primary.Value) : null,
            IsFolder = item.Kind is not ("Movie" or "Unknown"), MediaType = item.MediaType ?? (item.Kind == "Movie" ? "Video" : "Unknown"),
            IsVirtualItem = item.Virtual, ExtraType = (BaseItemExtraType?)item.Extra, PresentationUniqueKey = item.PresentationKey });
    }
    for (var index = 0; index < specification.PageMovies; index++) context.BaseItems.Add(new BaseItemEntity {
        Id = Id(10000 + index), Type = typeof(Movie).FullName!, Name = "Page " + index, SortName = index.ToString("D6"),
        ParentId = Id(5), TopParentId = Id(5), MediaType = "Video", Data = JsonSerializer.Serialize(new { TmdbCollectionName = index == 1000 ? "After page" : "" }) });
    context.SaveChanges();
    foreach (var item in specification.Items) foreach (var ancestor in item.Ancestors) context.AncestorIds.Add(new AncestorId { ItemId = Id(item.Number), ParentItemId = Id(ancestor), Item = null!, ParentItem = null! });
    for (var index = 0; index < specification.PageMovies; index++) context.AncestorIds.Add(new AncestorId { ItemId = Id(10000 + index), ParentItemId = Id(5), Item = null!, ParentItem = null! });
    foreach (var (link, index) in specification.Links.Select((link, index) => (link, index))) context.LinkedChildren.Add(new LinkedChildEntity {
        ParentId = Id(link.Parent), ChildId = Id(link.Child), SortOrder = index, ChildType = (Jellyfin.Database.Implementations.Entities.LinkedChildType)link.Type });
    context.SaveChanges();
}
var aggregate = (AggregateFolder)manager.GetItemById(Id(1))!;
var rootItems = aggregate.Children.Select(item => new { item.Id, item.Name, Type = item.GetType().FullName, item.Path, item.ParentId }).ToArray();
var pages = new List<object>();
foreach (var sample in specification.Queries) {
    var parent = manager.GetItemById(Id(sample.Parent))!;
    var query = new InternalItemsQuery { Parent = parent, Recursive = true, IncludeItemTypes = [BaseItemKind.Movie],
        MediaTypes = [MediaType.Video], IsVirtualItem = false, StartIndex = sample.Start, Limit = sample.Limit,
        OrderBy = [(ItemSortBy.SortName, SortOrder.Ascending)] };
    try {
        var selected = manager.GetItemList(query);
        pages.Add(new { sample, rows = selected.Select(item => new { item.Id, ((Movie)item).CollectionName, ((Movie)item).PrimaryVersionId }).ToArray(),
            query.AncestorIds, query.TopParentIds, query.DescendantOfId, failure = (object?)null });
    } catch (Exception error) {
        pages.Add(new { sample, failure = new { type = error.GetType().Name, error.Message } });
    }
}
var boxes = manager.GetItemList(new InternalItemsQuery { IncludeItemTypes = [BaseItemKind.BoxSet], CollapseBoxSetItems = false, Recursive = true })
    .Select(item => new { item.Id, item.Name }).ToArray();
using var final = factory.CreateDbContext();
object[] Snapshot<T>(IEnumerable<T> rows) where T : class {
    var entity = final.Model.FindEntityType(typeof(T))!; var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
    return rows.Select(row => (object)entity.GetProperties().ToDictionary(property => property.GetColumnName(table)!, property => property.PropertyInfo!.GetValue(row))).ToArray();
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualLibraryManager = true, actualFolderChildren = true, actualRepository = true,
    actualSqlite = true, applicationPathReversalControlled = true, mediaOpened = false, portOpened = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(), rootItems, pages, boxes,
    rows = Snapshot(final.BaseItems.AsNoTracking().OrderBy(item => item.Id).ToArray()),
    ancestors = Snapshot(final.AncestorIds.AsNoTracking().OrderBy(item => item.ItemId).ThenBy(item => item.ParentItemId).ToArray()),
    links = Snapshot(final.LinkedChildren.AsNoTracking().OrderBy(item => item.ParentId).ThenBy(item => item.SortOrder).ToArray()), assemblies,
    sqliteRuntime = new { name = sqliteName, filename = sqliteFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sqliteFilename))).ToLowerInvariant() }
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { queries = pages.Count, roots = rootItems.Length }));
public sealed class Input { public ItemSpec[] Items { get; set; } = []; public LinkSpec[] Links { get; set; } = []; public QuerySpec[] Queries { get; set; } = []; public int PageMovies { get; set; } }
public sealed class ItemSpec {
    public int Number { get; set; } public string Kind { get; set; } = "Movie"; public string? Name { get; set; } public string? Sort { get; set; }
    public string? Data { get; set; } public string? MediaType { get; set; } public string? PresentationKey { get; set; }
    public int? Parent { get; set; } public int? Top { get; set; } public int? Owner { get; set; } public int? Primary { get; set; }
    public int? Extra { get; set; } public bool Virtual { get; set; } public bool PrimaryEmpty { get; set; } public int[] Ancestors { get; set; } = [];
}
public sealed class LinkSpec { public int Parent { get; set; } public int Child { get; set; } public int Type { get; set; } }
public sealed class QuerySpec { public string Name { get; set; } = ""; public int Parent { get; set; } public int Start { get; set; } public int Limit { get; set; } = 1000; }
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!; protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
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
