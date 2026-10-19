// Executes the pinned controller and PeopleRepository on an isolated SQLite DB.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Localization;
using Jellyfin.Api.Controllers;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.IO;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

SQLitePCL.Batteries_V2.Init();
var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true, WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var entry in input.EnumerateArray()) {
    var name = entry.GetProperty("name").GetString()!;
    var mode = entry.GetProperty("mode").GetString()!;
    BaseItem item = entry.GetProperty("type").GetString() switch {
        "Series" => new Series { Children = [] }, "Movie" => new Movie(), "Folder" => new Folder { Children = [] },
        "Audio" => new Audio(), "Person" => new Person(), _ => throw new NotSupportedException()
    };
    item.Id = Guid.Parse("83000000-0000-0000-0000-000000000001"); item.Name = "Original";
    if (entry.TryGetProperty("path", out var sourcePath)) item.Path = sourcePath.GetString();
    if (item is Video video) {
        if (entry.TryGetProperty("videoType", out var videoType)) video.VideoType = Enum.Parse<MediaBrowser.Model.Entities.VideoType>(videoType.GetString()!);
        if (entry.TryGetProperty("stacked", out var stacked) && stacked.GetBoolean()) video.AdditionalParts = ["Z:\\EditMedia\\Part2.mkv"];
        if (entry.TryGetProperty("placeholder", out var placeholder)) video.IsPlaceHolder = placeholder.GetBoolean();
    }
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var config = (ConfigurationProxy)(object)configuration;
    config.Value.ContentTypes = entry.TryGetProperty("contentTypes", out var types)
        ? JsonSerializer.Deserialize<MediaBrowser.Model.Dto.NameValuePair[]>(types.GetRawText(), json)! : [];
    config.FailSave = entry.TryGetProperty("failConfiguration", out var failConfiguration) && failConfiguration.GetBoolean();
    var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    await localization.LoadAll(); BaseItem.LocalizationManager = localization; BaseItem.ConfigurationManager = configuration;
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var calls = (LibraryProxy)(object)library; calls.Item = item;
    calls.Missing = entry.TryGetProperty("missing", out var missing) && missing.GetBoolean();
    calls.FailSave = entry.TryGetProperty("failItem", out var failItem) && failItem.GetBoolean();
    var provider = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    BaseItem.LibraryManager = library;
    var controller = new ItemUpdateController(null!, library, provider, localization, configuration) {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
    };
    var factory = new SqlFactory(Path.Combine(args[2], name + ".db"));
    if (mode == "people") {
        using var context = factory.CreateDbContext(); context.Database.EnsureCreated();
        context.BaseItems.Add(new BaseItemEntity { Id = item.Id, Type = item.GetType().FullName!, Name = item.Name, IsFolder = item.IsFolder }); context.SaveChanges();
        calls.People = new PeopleRepository(factory, new ItemTypeLookup(), null!);
    }
    object? error = null; int? status = null;
    try {
        ActionResult response;
        if (mode == "content") response = controller.UpdateItemContentType(item.Id, entry.TryGetProperty("contentType", out var contentType) ? contentType.GetString() : null);
        else response = await controller.UpdateItem(item.Id, JsonSerializer.Deserialize<BaseItemDto>(entry.GetProperty("json").GetString()!, json)!);
        status = response switch { NoContentResult => 204, NotFoundResult => 404, _ => throw new NotSupportedException(response.GetType().Name) };
    } catch (Exception exception) { error = new { type = exception.GetType().Name, exception.Message }; }
    object? credits = null;
    if (mode == "people") {
        using var context = factory.CreateDbContext();
        credits = context.PeopleBaseItemMap.Include(map => map.People).OrderBy(map => map.ListOrder)
            .AsEnumerable().Select(map => new { map.People.Name, Type = map.People.PersonType, map.Role, map.ListOrder, map.SortOrder }).ToArray();
    }
    results.Add(new { name, status, error, itemName = item.Name, containingFolder = item.ContainingFolderPath,
        contentTypes = config.Value.ContentTypes, configurationSaves = config.Saves, calls = calls.Calls, credits });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    sourceBoundary = "Actual ItemUpdateController entry points, BaseItem/Video.ContainingFolderPath and native JSON converters. PeopleRepository.UpdatePeople writes an isolated native EF SQLite database; the library proxy checks actual SupportsPeople. SavePeopleMetadataAsync and person entity creation are excluded. Item persistence and configuration save are controlled callbacks, including explicit failure injection. No native HTTP or NFO file save is executed.",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(ItemUpdateController).Assembly, typeof(PeopleRepository).Assembly, typeof(JellyfinDbContext).Assembly }
        .Select(assembly => new { path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) }, json));

public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Value = new(); public int Saves; public bool FailSave;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "get_Configuration") return Value;
        if (method.Name is "add_ConfigurationUpdated" or "remove_ConfigurationUpdated") return null;
        if (method.Name == "SaveConfiguration") { Saves++; if (FailSave) throw new IOException("Injected configuration save failure"); return null; }
        throw new NotSupportedException(method.Name);
    }
}
public class LibraryProxy : DispatchProxy {
    public BaseItem Item = null!; public PeopleRepository? People; public List<string> Calls = []; public bool Missing, FailSave;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Missing ? null : Item;
        if (method.Name == "UpdatePeople") {
            Calls.Add("People"); if (Item.SupportsPeople) People!.UpdatePeople(Item.Id, (List<PersonInfo>)args![1]!); return null;
        }
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "UpdateItemAsync") { Calls.Add("Item"); if (FailSave) throw new IOException("Injected item save failure"); return Task.CompletedTask; }
        throw new NotSupportedException(method.Name);
    }
}
public class ProviderProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => throw new NotSupportedException(method!.Name);
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>()
        .UseSqlite($"Data Source={filename};Pooling=False").Options, NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
