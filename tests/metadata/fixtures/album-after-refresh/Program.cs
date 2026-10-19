// Executes the pinned Album service's After hook and PeopleRepository on SQLite.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Music;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var name = scenario.GetProperty("name").GetString()!;
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    await localization.LoadAll(); BaseItem.LocalizationManager = localization;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var control = (LibraryProxy)(object)library; BaseItem.LibraryManager = library;
    var album = new MusicAlbum { Id = Guid.Parse("95000000-0000-0000-0000-000000000001"), Name = "Album", Children = [],
        Artists = JsonSerializer.Deserialize<string[]>(scenario.GetProperty("artists").GetRawText(), json)!,
        AlbumArtists = JsonSerializer.Deserialize<string[]>(scenario.GetProperty("albumArtists").GetRawText(), json)!,
        DateLastRefreshed = new DateTime(2026, 10, 4, 12, 0, 0, DateTimeKind.Utc), DateLastMediaAdded = DateTime.MinValue,
        IsLocked = scenario.TryGetProperty("locked", out var locked) && locked.GetBoolean() };
    album.PresentationUniqueKey = album.GetPresentationUniqueKey();
    if (scenario.TryGetProperty("force", out var forced) && forced.GetBoolean()) {
        var track = new Audio { Id = Guid.Parse("95000000-0000-0000-0000-000000000002"), Name = "Track", Album = "Album", Artists = album.Artists,
            AlbumArtists = album.AlbumArtists };
        track.SetParent(album); album.Children = [track];
    }
    control.Item = album;
    var factory = new SqlFactory(Path.Combine(args[2], name + ".db"));
    using (var context = factory.CreateDbContext()) {
        context.Database.EnsureCreated();
        context.BaseItems.Add(new BaseItemEntity { Id = album.Id, Type = album.GetType().FullName!, Name = album.Name, IsFolder = true });
        context.SaveChanges();
    }
    control.People = new PeopleRepository(factory, new ItemTypeLookup(), null!);
    control.People.UpdatePeople(album.Id, [new PersonInfo { Name = "Old Credit", Type = Jellyfin.Data.Enums.PersonKind.Actor, Role = "Original Role" }]);
    control.Failure = scenario.TryGetProperty("failure", out var failure) ? failure.GetString() : null;
    var repository = DispatchProxy.Create<IItemRepository, RepositoryProxy>();
    BaseItem.ItemRepository = repository;
    using var providers = new ProviderManager(null!, null!, configuration, null!, NullLogger<ProviderManager>.Instance, BaseItem.FileSystem, null!, library, null!, null!, null!, null!, null!);
    providers.AddParts([], [], [], [], [], []);
    var service = new AlbumMetadataService(configuration, NullLogger<AlbumMetadataService>.Instance, providers, BaseItem.FileSystem, library, null!, repository);
    using var cancellation = new CancellationTokenSource();
    if (scenario.TryGetProperty("cancelAfterSave", out var cancelAfterSave) && cancelAfterSave.GetBoolean()) control.CancelAfterItem = () => cancellation.Cancel();
    if (scenario.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    var refresh = new MetadataRefreshOptions((IDirectoryService)null!) { MetadataRefreshMode = MetadataRefreshMode.None, ImageRefreshMode = MetadataRefreshMode.None,
        ForceSave = scenario.TryGetProperty("force", out var force) && force.GetBoolean() };
    int? updateType = null; string? exception = null;
    try {
        if (scenario.GetProperty("mode").GetString() == "after") {
            await (Task)typeof(AlbumMetadataService).GetMethod("AfterMetadataRefresh", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [album, refresh, cancellation.Token])!;
        } else updateType = (int)await service.RefreshMetadata(album, refresh, cancellation.Token);
    } catch (Exception error) {
        exception = (error is TargetInvocationException wrapped ? wrapped.InnerException : error)!.GetType().Name;
        if (!scenario.TryGetProperty("expectException", out var expected) || exception != expected.GetString()) throw;
    }
    if (exception is null && scenario.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected failure was not raised.");
    using var final = factory.CreateDbContext();
    var credits = final.PeopleBaseItemMap.Include(map => map.People).OrderBy(map => map.ListOrder).AsEnumerable()
        .Select(map => new { map.People.Name, Type = map.People.PersonType, map.Role, map.ListOrder, map.SortOrder }).ToArray();
    results.Add(new { name, updateType, exception, album.Artists, album.AlbumArtists, calls = control.Calls, credits });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual AlbumMetadataService After hook and None refresh, native MusicAlbum/PeopleHelper and PeopleRepository.UpdatePeople with real EF SQLite. Empty providers/children and metadata item-save callbacks are controls. Library.UpdatePeople delegates to the actual repository, with explicit pre-repository or post-credit failure. SavePeopleMetadataAsync, person creation and NFO/file/image operations are excluded." }, json) + "\n");

public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Data = new() { MetadataCountryCode = "US" };
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Data, "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public MusicAlbum Item = null!; public PeopleRepository People = null!; public string? Failure; public List<object> Calls = []; public Action? CancelAfterItem;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetItemById") return (Guid)args![0]! == Item.Id ? Item : null;
        if (method.Name == "GetItemList") return Array.Empty<BaseItem>();
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "ReattachUserDataAsync") return Task.CompletedTask;
        if (method.Name == "UpdateItemAsync") {
            Calls.Add(new { action = "item", reason = (int)(ItemUpdateType)args![2]! });
            if (Failure == "item") throw new IOException("Injected item save failure");
            CancelAfterItem?.Invoke();
            return Task.CompletedTask;
        }
        if (method.Name == "UpdatePeople") {
            var people = (List<PersonInfo>)args![1]!;
            Calls.Add(new { action = "people", people = people.Select(person => new { person.Name, person.Type, person.Role, person.SortOrder, person.ProviderIds }).ToArray() });
            if (Failure == "people") throw new IOException("Injected people repository failure");
            if (Item.SupportsPeople) People.UpdatePeople(Item.Id, people);
            if (Failure == "person") throw new IOException("Injected post-credit person metadata failure");
            return null;
        }
        throw new NotSupportedException(method.Name);
    }
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemList" => Array.Empty<BaseItem>(), "ItemExistsAsync" => Task.FromResult(true),
        _ => throw new NotSupportedException(method.Name)
    };
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "IsPathFile" => true, "GetFileSystemInfo" or "GetFileInfo" => new FileSystemMetadata { Exists = false },
        _ => throw new NotSupportedException(method.Name)
    };
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>()
        .UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
