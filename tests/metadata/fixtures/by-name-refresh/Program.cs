// Actual by-name entity hooks, metadata services and EF save boundaries.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Genres;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.GetFullPath(Path.Combine(args[2], name)); Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata"); Directory.CreateDirectory(metadata);
    string? ProjectPath(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
    var pathValues = new Dictionary<string,string> { ["ProgramDataPath"] = root, ["DataPath"] = Path.Combine(root, "data"), ["VirtualDataPath"] = "%AppDataPath%",
        ["InternalMetadataPath"] = metadata, ["VirtualInternalMetadataPath"] = "%MetadataPath%", ["PeoplePath"] = Path.Combine(metadata, "People"),
        ["GenrePath"] = Path.Combine(metadata, "Genre"), ["MusicGenrePath"] = Path.Combine(metadata, "MusicGenre"), ["StudioPath"] = Path.Combine(metadata, "Studio"),
        ["YearPath"] = Path.Combine(metadata, "Year"), ["ArtistsPath"] = Path.Combine(metadata, "artists"), ["TempDirectory"] = Path.Combine(root, "temp") };
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => pathValues.GetValueOrDefault(method.Name.Replace("get_", "")) ?? throw new NotSupportedException(method.Name));
    var configuration = new ServerConfiguration { MetadataCountryCode = "US" };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch { "get_ApplicationPaths" => paths, "get_Configuration" => configuration,
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null, _ => throw new NotSupportedException(method.Name) });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); BaseItem.FileSystem = fileSystem;
    var appHostType = Assembly.Load("jellyfin").GetType("Jellyfin.Server.CoreAppHost")!;
    var appHost = (IServerApplicationHost)RuntimeHelpers.GetUninitializedObject(appHostType);
    typeof(ApplicationHost).GetField("<ApplicationPaths>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(appHost, paths);
    var factory = new SqlFactory(Path.Combine(root, "native.db")); using (var context = factory.CreateDbContext()) context.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var calls = new List<object>();
    var library = Stub.Make<ILibraryManager>((method, parameters) => {
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "GetItemById") return null;
        if (method.Name == "GetItemList") return Array.Empty<BaseItem>();
        if (method.Name == "UpdateItemAsync") {
            var saved = (BaseItem)parameters![0]!;
            calls.Add(new { action = "save", saved.Name, Path = ProjectPath(saved.Path), reason = (int)parameters[2]! });
            persistence.SaveItems([saved], (CancellationToken)parameters[^1]!);
            return Task.CompletedTask;
        }
        if (method.Name == "ReattachUserDataAsync") { calls.Add(new { action = "reattach" }); return Task.CompletedTask; }
        return Stub.Default(method.ReturnType);
    }); BaseItem.LibraryManager = library;
    var type = typeof(BaseItem).Assembly.GetTypes().Single(type => type.Name == sample.GetProperty("type").GetString() && typeof(BaseItem).IsAssignableFrom(type));
    var item = (BaseItem)Activator.CreateInstance(type)!;
    item.Id = Guid.Parse("97810000-0000-0000-0000-000000000001"); item.Name = sample.GetProperty("itemName").GetString()!;
    item.Path = sample.GetProperty("path").GetString()!.Replace("$STATE", root, StringComparison.Ordinal);
    Directory.CreateDirectory(item.Path);
    item.DateLastRefreshed = sample.TryGetProperty("first", out var first) && first.GetBoolean() ? DateTime.MinValue : DateTime.Parse("2026-10-04T12:00:00Z").ToUniversalTime();
    item.DateModified = DateTime.MinValue;
    if (sample.TryGetProperty("physicalArtist", out var physical) && physical.GetBoolean()) {
        item.ParentId = Guid.Parse("97810000-0000-0000-0000-000000000002");
        persistence.SaveItems([new Folder { Id = item.ParentId, Name = "Physical Parent" }], CancellationToken.None);
    }
    persistence.SaveItems([item], CancellationToken.None);
    string? exception = null; object? result = null;
    try {
        var mode = sample.GetProperty("mode").GetString();
        if (mode == "before") result = new { changed = item.BeforeMetadataRefresh(false), item.Name, Path = ProjectPath(item.Path) };
        else if (mode == "requires") result = new { requiresRefresh = item.RequiresRefresh(), item.Name, Path = ProjectPath(item.Path) };
        else {
            using var providers = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance, fileSystem, null!, library,
                Stub.Make<IBaseItemManager>((method, _) => Stub.Default(method.ReturnType)), null!, null!, null!, null!); providers.AddParts([], [], [], [], [], []);
            var serviceName = sample.GetProperty("type").GetString() == "MusicArtist" ? "ArtistMetadataService" : sample.GetProperty("type").GetString() + "MetadataService";
            var serviceType = typeof(GenreMetadataService).Assembly.GetTypes().Single(type => type.Name == serviceName);
            var arguments = serviceType.GetConstructors().Single().GetParameters().Select(parameter => parameter.ParameterType == typeof(IServerConfigurationManager) ? (object)config
                : parameter.ParameterType == typeof(IProviderManager) ? providers : parameter.ParameterType == typeof(IFileSystem) ? fileSystem
                : parameter.ParameterType == typeof(ILibraryManager) ? library : parameter.ParameterType == typeof(IItemRepository) ? repository
                : parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericTypeDefinition() == typeof(ILogger<>)
                    ? typeof(NullLogger<>).MakeGenericType(parameter.ParameterType.GenericTypeArguments).GetField("Instance")!.GetValue(null) : null).ToArray();
            var service = (IMetadataService)Activator.CreateInstance(serviceType, arguments)!;
            var options = new MetadataRefreshOptions(new DirectoryService(fileSystem)) { MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(sample.GetProperty("metadataMode").GetString()!),
                ImageRefreshMode = MetadataRefreshMode.None, ForceSave = sample.TryGetProperty("force", out var force) && force.GetBoolean() };
            var update = await service.RefreshMetadata(item, options, CancellationToken.None);
            using var final = factory.CreateDbContext(); var saved = final.BaseItems.Single(value => value.Id == item.Id);
            result = new { updateType = (int)update, calls, item.Name, Path = ProjectPath(item.Path), storedPath = saved.Path, saved.Data,
                stampChanged = item.DateLastRefreshed != (sample.TryGetProperty("first", out var initialFirst) && initialFirst.GetBoolean() ? DateTime.MinValue : DateTime.Parse("2026-10-04T12:00:00Z").ToUniversalTime()) };
        }
    } catch (Exception error) { exception = error.GetType().Name; Console.Error.WriteLine(name + ": " + error); }
    if (exception is not null) throw new InvalidOperationException("Unexpected native failure: " + name + " / " + exception);
    results.Add(new { name, exception, result });
}
var assemblies = new[] { typeof(BaseItem).Assembly, typeof(GenreMetadataService).Assembly, typeof(ItemPersistenceService).Assembly,
    typeof(ApplicationHost).Assembly, Assembly.Load("jellyfin"), typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenByNameRefresh = true, results, assemblies,
    scope = "Real entity RequiresRefresh/BeforeMetadataRefresh, six actual by-name MetadataServices and empty ProviderManager, ManagedFileSystem directories, ItemPersistenceService/EF SQLite. Actual ApplicationHost.ReverseVirtualPath on an unconstructed CoreAppHost with only its application-paths field initialized. Parent/collection/library-option lookups, save and reattachment bridges and path protocol are controls. Save bridge calls real SaveItems; reattachment bridge records invocation. No image/NFO provider, network, full scalar/table projection, top root or scanner acceptance." }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T : class { var value = Create<T,Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
