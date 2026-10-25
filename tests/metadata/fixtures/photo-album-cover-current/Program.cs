using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Images;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Manager;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;

var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var input = File.ReadAllBytes(args[1]);
var cases = JsonSerializer.Deserialize<string[]>(input)!;
var results = new List<object>();
foreach (var name in cases) {
    var root = Path.GetFullPath(Path.Combine(args[0], "cases", name)); Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata"); var temp = Path.Combine(root, "temp");
    var stamp = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata, "get_TempDirectory" => temp,
        "get_DataPath" => Path.Combine(root, "data"), _ => Stub.Default(method.ReturnType) });
    var configuration = new ServerConfiguration { CacheSize = 64, ImageSavingConvention = ImageSavingConvention.Compatible };
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths, "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType) });
    var actualFileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var fileSystem = Stub.Make<IFileSystem>((method, values) => {
        if (name == "save-failure" && method.Name == "SetAttributes") throw new IOException("Injected SaveImage destination failure");
        if (name == "delete-old-failure" && method.Name == "DeleteFile") throw new IOException("Injected previous image deletion failure");
        return Stub.Forward(actualFileSystem, method, values);
    });
    BaseItem.ConfigurationManager = config; BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol"
        ? MediaBrowser.Model.MediaInfo.MediaProtocol.File : Stub.Default(method.ReturnType));
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var factory = new SqlFactory(Path.Combine(root, "native.db")); using (var context = factory.CreateDbContext()) context.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    Guid Id(int number) => name == "guid-item-order" && number is 10 or 11
        ? Guid.Parse(number == 10 ? "01000000-0000-0000-0000-000000000010" : "00010000-0000-0000-0000-000000000011")
        : Guid.Parse("cd810000-0000-0000-0000-" + number.ToString("D12"));
    var album = new PhotoAlbum { Id = Id(1), Name = "Album", Path = Path.Combine(root, "album") };
    Directory.CreateDirectory(album.Path);
    var source = Path.Combine(root, "source.png"); File.Copy(args[2], source); File.SetLastWriteTimeUtc(source, stamp);
    var jpeg = Path.Combine(root, "source.jpg"); File.Copy(args[3], jpeg); File.SetLastWriteTimeUtc(jpeg, stamp);
    var first = name switch { "remote-first" => "https://images.invalid/first.png", "extensionless-first" => Path.Combine(root, "extensionless"),
        "empty-first" => "", "missing-first" => Path.Combine(root, "missing.png"), "unknown-extension" => Path.Combine(root, "source.opaque"),
        "jpeg-extension" => jpeg, "uppercase-extension" => Path.Combine(root, "source.PNG"), "tbn-extension" => Path.Combine(root, "source.tbn"),
        "nonimage-extension" => Path.Combine(root, "source.txt"), "heic-extension" => Path.Combine(root, "source.heic"), "tif-extension" => Path.Combine(root, "source.tif"),
        "tga-extension" => Path.Combine(root, "source.tga"), "jpe-extension" => Path.Combine(root, "source.jpe"), _ => source };
    if (name is "extensionless-first" or "unknown-extension" or "uppercase-extension" or "tbn-extension" or "nonimage-extension" or "heic-extension" or "tif-extension" or "tga-extension" or "jpe-extension") { if (!File.Exists(first)) File.Copy(args[2], first); File.SetLastWriteTimeUtc(first, stamp); }
    using (var context = factory.CreateDbContext()) {
        context.BaseItems.Add(new BaseItemEntity { Id = album.Id, Type = typeof(PhotoAlbum).FullName!, Name = "Album", SortName = "album", IsFolder = true, Data = "{}", Path = album.Path });
        if (name is "owner-zero" or "primary-zero" or "primary-zero-matching") {
            context.SaveChanges();
            // EF generates an ID when Add receives Guid.Empty. A raw fixture row
            // is required to observe stored zero-Guid references faithfully.
            var entity = context.Model.FindEntityType(typeof(BaseItemEntity))!;
            var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
            var columns = entity.GetProperties().Select(property => property.GetColumnName(table)!).ToArray();
            var projection = columns.Select(column => column == "Id" ? "'00000000-0000-0000-0000-000000000000'" : column == "TopParentId" ? name == "primary-zero" ? "'" + album.Id.ToString().ToUpperInvariant() + "'" : "NULL" : "\"" + column + "\"");
            context.Database.ExecuteSqlRaw("INSERT INTO \"BaseItems\" (" + string.Join(",", columns.Select(column => "\"" + column + "\"")) + ") SELECT " + string.Join(",", projection) + " FROM \"BaseItems\" WHERE \"Id\" = {0}", album.Id.ToString().ToUpperInvariant());
        }
        if (name != "no-children") {
            context.BaseItems.Add(new BaseItemEntity { Id = Id(9), Type = typeof(PhotoAlbum).FullName!, Name = "Folder", SortName = "000 folder", IsFolder = true, Data = "{}", ParentId = album.Id, Path = Path.Combine(album.Path, "folder") });
            if (name != "folder-only") {
                context.BaseItems.Add(new BaseItemEntity { Id = Id(10), Type = typeof(Photo).FullName!, Name = "First", SortName = name == "null-sort-name" ? null : "a", IsFolder = false, Data = "{}", ParentId = name == "ancestor-only" ? null : name == "nested-leaf" ? Id(9) : album.Id, Path = first, OwnerId = name == "owned-first" ? album.Id : name == "owner-zero" ? Guid.Empty : null, PrimaryVersionId = name == "alternate-first" ? Id(11) : name is "primary-zero" or "primary-zero-matching" ? Guid.Empty : null });
                context.BaseItems.Add(new BaseItemEntity { Id = Id(11), Type = typeof(Photo).FullName!, Name = "Later", SortName = name is "same-sort-name" or "guid-item-order" ? "a" : "b", IsFolder = false, Data = "{}", ParentId = album.Id, Path = jpeg });
            }
        }
        context.SaveChanges();
        if (name != "no-children") {
            foreach (var number in name == "folder-only" ? new[] { 9 } : new[] { 9, 10, 11 }) {
                if (name != "missing-ancestor" || number != 10) context.AncestorIds.Add(new AncestorId { ItemId = Id(number), ParentItemId = album.Id, Item = null!, ParentItem = null! });
                context.BaseItemImageInfos.Add(new BaseItemImageInfo { Id = name == "guid-image-order" && number == 10 ? Guid.Parse("01000000-0000-0000-0000-000000000010") : Guid.Parse("cd811000-0000-0000-0000-" + (number * 10 + 8).ToString("D12")), ItemId = Id(number), Item = null!, ImageType = ImageInfoImageType.Primary, Path = number == 10 ? first : number == 11 ? jpeg : source, Width = 8, Height = 6 });
            }
            if (name == "multiple-primary") context.BaseItemImageInfos.Add(new BaseItemImageInfo { Id = Guid.Parse("cd811000-0000-0000-0000-000000000101"), ItemId = Id(10), Item = null!, ImageType = ImageInfoImageType.Primary, Path = "https://images.invalid/lower-id.png" });
            if (name == "guid-image-order") context.BaseItemImageInfos.Add(new BaseItemImageInfo { Id = Guid.Parse("00010000-0000-0000-0000-000000000011"), ItemId = Id(10), Item = null!, ImageType = ImageInfoImageType.Primary, Path = "https://images.invalid/guid-lower-id.png" });
            context.SaveChanges();
        }
    }
    var internalCover = name.StartsWith("internal-cover") || name.StartsWith("boundary-") || name == "delete-old-failure";
    if (internalCover || name is "external-cover" or "remote-cover") {
        var cover = name == "remote-cover" ? "https://images.invalid/existing.png" : name == "external-cover" ? Path.Combine(root, "external.png") : Path.Combine(album.GetInternalMetadataPath(), "old.png");
        if (name == "boundary-forward-separators") cover = cover.Replace('\\', '/');
        if (name == "boundary-root-equal") cover = album.GetInternalMetadataPath();
        if (name == "boundary-dot-segment") cover = album.GetInternalMetadataPath() + Path.DirectorySeparatorChar + ".." + Path.DirectorySeparatorChar + "sibling" + Path.DirectorySeparatorChar + "old.png";
        var date = name.StartsWith("boundary-") || name is "internal-cover-changed" or "internal-cover-missing-min" ? DateTime.MinValue : stamp;
        album.SetImage(new ItemImageInfo { Type = ImageType.Primary, Path = cover, DateModified = date, Width = 40, Height = 20, BlurHash = "old-hash" }, 0);
        if (!name.Contains("missing") && name != "remote-cover") { Directory.CreateDirectory(Path.GetDirectoryName(cover)!); File.Copy(args[2], cover); File.SetLastWriteTimeUtc(cover, stamp); }
    }
    var queries = new List<object>(); var selected = new List<object>(); var saves = new List<object>();
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetLibraryOptions") return new LibraryOptions { SaveLocalMetadata = true };
        if (method.Name == "GetItemById") return (Guid)values![0]! == album.Id ? album : null;
        if (method.Name != "GetItemList") return Stub.Default(method.ReturnType);
        var query = (InternalItemsQuery)values![0]!;
        queries.Add(new { parentId = query.ParentId, query.Recursive, query.Limit, imageTypes = query.ImageTypes.Select(value => value.ToString()), orderBy = query.OrderBy.Select(value => new { field = value.OrderBy.ToString(), direction = value.SortOrder.ToString() }) });
        var manager = RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
        typeof(LibraryManager).GetMethod("SetTopParentIdsOrAncestors", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(manager, [query, new BaseItem[] { album }]);
        var items = repository.GetItemList(query); selected.Add(new { ids = items.Select(item => item.Id), paths = items.Select(item => item.GetImagePath(ImageType.Primary)) }); return items;
    });
    BaseItem.LibraryManager = library;
    var realManager = (ProviderManager)RuntimeHelpers.GetUninitializedObject(typeof(ProviderManager));
    foreach (var (field, value) in new (string, object)[] { ("_configurationManager", config), ("_fileSystem", fileSystem), ("_libraryMonitor", Stub.Make<ILibraryMonitor>((method, values) => Stub.Default(method.ReturnType))), ("_logger", NullLogger<ProviderManager>.Instance) }) typeof(ProviderManager).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(realManager, value);
    var providerManager = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name != "SaveImage") return Stub.Default(method.ReturnType);
        var filename = (string)values![1]!;
        saves.Add(new { mime = values[2], type = values[3]!.ToString(), saveLocally = values[5], extension = Path.GetExtension(filename), sha256 = Hash(File.ReadAllBytes(filename)) });
        return Stub.Forward(realManager, method, values);
    });
    var provider = new PhotoAlbumImageProvider(fileSystem, providerManager, paths, Stub.Make<IImageProcessor>((method, values) => Stub.Default(method.ReturnType)), library);
    bool? changed = null; string? changeError = null; int? update = null; string? errorType = null; string? errorStack = null;
    try { changed = provider.HasChanged(album, null!); } catch (Exception error) { changeError = error.GetType().Name; }
    using var cancellation = new CancellationTokenSource(); if (name == "cancelled") cancellation.Cancel();
    try { update = (int)await provider.FetchAsync(album, new MetadataRefreshOptions((IDirectoryService)null!), cancellation.Token); } catch (Exception error) { errorType = error.GetType().Name; errorStack = error.ToString(); }
    string? Project(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal).Replace(root.Replace('\\', '/'), "$STATE", StringComparison.Ordinal).Replace('\\', '/');
    object[] Snapshot<T>(IEnumerable<T> values) where T : class { using var context = factory.CreateDbContext(); var entity = context.Model.FindEntityType(typeof(T))!; var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema()); return values.Select(value => (object)entity.GetProperties().ToDictionary(property => property.GetColumnName(table)!, property => property.PropertyInfo!.GetValue(value))).ToArray(); }
    using var final = factory.CreateDbContext();
    var image = album.GetImageInfo(ImageType.Primary, 0);
    results.Add(new { name, changed, changeError, update, errorType, errorStack, queries, selected, saves,
        images = album.ImageInfos.Select(value => new { path = Project(value.Path), type = value.Type.ToString(), value.Width, value.Height, value.BlurHash, sha256 = File.Exists(value.Path) ? Hash(File.ReadAllBytes(value.Path)) : null }),
        temporaryFiles = Directory.Exists(temp) ? Directory.GetFiles(temp).Select(filename => new { extension = Path.GetExtension(filename), bytes = new FileInfo(filename).Length, sha256 = Hash(File.ReadAllBytes(filename)) }).ToArray() : [],
        internalFiles = Directory.Exists(album.GetInternalMetadataPath()) ? Directory.GetFiles(album.GetInternalMetadataPath()).Order().Select(filename => new { path = Project(filename), bytes = new FileInfo(filename).Length, sha256 = Hash(File.ReadAllBytes(filename)) }).ToArray() : [],
        root, rows = Snapshot(final.BaseItems.AsNoTracking().ToArray()), imageRows = Snapshot(final.BaseItemImageInfos.AsNoTracking().ToArray()), ancestors = Snapshot(final.AncestorIds.AsNoTracking().ToArray()) });
}
File.WriteAllText(args[4], JsonSerializer.Serialize(new { actualProvider = true, actualNativeRepository = true, actualSqlite = true, actualProviderManagerFileSave = true, actualImageSaver = true, recursiveParentNormalization = "Actual LibraryManager.SetTopParentIdsOrAncestors invoked on an uninitialized host because PhotoAlbum uses only static ancestor normalization. ILibraryManager dispatch captures the constructed query and forwards it to actual repository; no complete service or HTTP is claimed.", sourceInputSha256 = Hash(input), sqlite = new { rid = RuntimeInformation.RuntimeIdentifier, filename = sqliteFilename, sha256 = Hash(File.ReadAllBytes(sqliteFilename)), version = SQLitePCL.raw.sqlite3_libversion().utf8_to_string() }, results,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }) }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count }));
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) { try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
