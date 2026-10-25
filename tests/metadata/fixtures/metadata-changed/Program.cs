// Executes BaseItem.OnMetadataChanged and the controller's rating save order.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Localization;
using Jellyfin.Api.Controllers;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Movies;
using MediaBrowser.Providers.Manager;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var config = (ConfigurationProxy)(object)configuration;
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
await localization.LoadAll(); BaseItem.LocalizationManager = localization;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    config.Value.MetadataCountryCode = scenario.TryGetProperty("globalCountry", out var global) ? global.GetString() : "US";
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    BaseItem.LibraryManager = library;
    var proxy = (LibraryProxy)(object)library;
    proxy.Options.MetadataCountryCode = null;
    var items = new Dictionary<string, BaseItem>();
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        var type = definition.GetProperty("type").GetString() switch {
            "Folder" => typeof(Folder), "Movie" => typeof(Movie), "Series" => typeof(Series), "Season" => typeof(Season),
            "Episode" => typeof(Episode), "MusicAlbum" => typeof(MusicAlbum), "Audio" => typeof(Audio), _ => throw new NotSupportedException()
        };
        var item = (BaseItem)Activator.CreateInstance(type)!;
        if (item is Folder folder) folder.Children = [];
        foreach (var field in definition.EnumerateObject()) if (field.Name is not "key" and not "type" and not "parent") Bind(item, field.Name, field.Value);
        items.Add(definition.GetProperty("key").GetString()!, item); proxy.Items.Add(item.Id, item);
    }
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) if (definition.TryGetProperty("parent", out var parent)) {
        var item = items[definition.GetProperty("key").GetString()!];
        var folder = (Folder)items[parent.GetString()!];
        item.SetParent(folder); folder.Children = folder.Children.Append(item).ToList();
    }
    var target = items[scenario.GetProperty("target").GetString()!];
    var steps = new List<object>(); string? exception = null; int? refreshUpdate = null;
    var initialRefreshStamp = target.DateLastRefreshed;
    try {
        if (scenario.GetProperty("mode").GetString() == "refresh") {
            var fileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
            using var providers = new ProviderManager(null!, null!, configuration, null!, NullLogger<ProviderManager>.Instance,
                fileSystem, null!, library, null!, null!, null!, null!, null!);
            var metadataProviders = new IMetadataProvider[] { new RatingProvider {
                Fail = scenario.TryGetProperty("fail", out var fail) && fail.GetBoolean(),
                Cancel = scenario.TryGetProperty("cancel", out var cancel) && cancel.GetBoolean(),
                Update = (ItemUpdateType)(scenario.TryGetProperty("providerUpdate", out var providerUpdate) ? providerUpdate.GetInt32() : 1)
            } };
            var imageProviders = scenario.TryGetProperty("imageFail", out var imageFail) && imageFail.GetBoolean()
                ? new IImageProvider[] { new FailingImageProvider() } : Array.Empty<IImageProvider>();
            providers.AddParts(imageProviders, [], metadataProviders, [], [], []);
            var service = new MovieMetadataService(configuration, NullLogger<MovieMetadataService>.Instance, providers,
                fileSystem, library, null!, DispatchProxy.Create<IItemRepository, RepositoryProxy>());
            var options = new MetadataRefreshOptions((IDirectoryService)null!) {
                MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(scenario.GetProperty("metadataMode").GetString()!),
                ImageRefreshMode = MetadataRefreshMode.None,
                ForceSave = scenario.TryGetProperty("force", out var force) && force.GetBoolean()
            };
            refreshUpdate = (int)await service.RefreshMetadata(target, options, CancellationToken.None);
        } else if (scenario.GetProperty("mode").GetString() == "edit") {
            var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
            var controller = new ItemUpdateController(null!, library, providers, localization, configuration) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
            };
            var request = JsonSerializer.Deserialize<BaseItemDto>(scenario.GetProperty("request").GetRawText(), JsonDefaults.Options)!;
            await controller.UpdateItem(target.Id, request);
        } else {
            steps.Add(Capture(target, target.OnMetadataChanged()));
            if (scenario.TryGetProperty("changes", out var changes)) foreach (var change in changes.EnumerateArray()) {
                var item = items[change.GetProperty("key").GetString()!];
                foreach (var field in change.GetProperty("fields").EnumerateObject()) Bind(item, field.Name, field.Value);
            }
            steps.Add(Capture(target, target.OnMetadataChanged()));
        }
        if (scenario.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected native exception was not raised.");
    } catch (Exception error) when (scenario.TryGetProperty("expectException", out var expected) && error.GetType().Name == expected.GetString()) {
        exception = error.GetType().Name;
    }
    results.Add(new { name = scenario.GetProperty("name").GetString(), steps, calls = proxy.Calls, exception,
        refresh = scenario.GetProperty("mode").GetString() == "refresh" ? new {
            updateType = refreshUpdate, saved = proxy.Calls.Count > 0, stampChanged = initialRefreshStamp != target.DateLastRefreshed,
            rawDateLastRefreshed = target.DateLastRefreshed.ToString("O")
        } : null,
        items = items.Select(pair => new { key = pair.Key, result = Capture(pair.Value, null) }) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual BaseItem.OnMetadataChanged, rating inheritance and LocalizationManager resources; repeated explicit calls, actual ItemUpdateController save order and five pathless MovieMetadataService refresh controls. Parent entities, library options, collection folders, custom/image providers and repository callbacks are controlled. HTTP, native repository writes, NFO, media file operations and person creation are excluded."
}, json));

void Bind(BaseItem item, string name, JsonElement value) {
    var property = item.GetType().GetProperty(name)!;
    if (property is null || !property.CanWrite) throw new NotSupportedException(name);
    property.SetValue(item, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType, json));
}
static object Capture(BaseItem item, ItemUpdateType? updateType) => new {
    item.Name, item.OfficialRating, item.CustomRating, item.PreferredMetadataCountryCode, item.IsLocked,
    item.InheritedParentalRatingValue, item.InheritedParentalRatingSubValue, updateType = (int?)updateType
};
public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Value = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Value, "add_ConfigurationUpdated" => null, "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = []; public LibraryOptions Options = new(); public List<object> Calls = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Items.GetValueOrDefault((Guid)args![0]!);
        if (method.Name == "GetLibraryOptions") return Options;
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "UpdateItemAsync") {
            var item = (BaseItem)args![0]!;
            Calls.Add(new { item.Id, item.Name, item.OfficialRating, item.CustomRating, item.PreferredMetadataCountryCode, item.IsLocked,
                item.InheritedParentalRatingValue, item.InheritedParentalRatingSubValue, updateReason = (int)args[2]! });
            return Task.CompletedTask;
        }
        throw new NotSupportedException(method.Name);
    }
}
public class ProviderProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "QueueRefresh" ? null : throw new NotSupportedException(method.Name);
}
public class RatingProvider : ICustomMetadataProvider<Movie>, IHasItemChangeMonitor {
    public string Name => "Controlled rating"; public bool Fail, Cancel; public ItemUpdateType Update;
    public bool HasChanged(BaseItem item, IDirectoryService directoryService) => true;
    public Task<ItemUpdateType> FetchAsync(Movie item, MetadataRefreshOptions options, CancellationToken cancellationToken) {
        if (Cancel) throw new OperationCanceledException("Injected cancellation after rating first save");
        item.OfficialRating = "R";
        if (Fail) throw new InvalidOperationException("Injected provider failure after rating mutation");
        return Task.FromResult(Update);
    }
}
public class FailingImageProvider : ILocalImageProvider {
    public string Name => "Controlled image failure";
    public bool Supports(BaseItem item) => true;
    public IEnumerable<LocalImageInfo> GetImages(BaseItem item, IDirectoryService directoryService) => throw new InvalidOperationException("Injected local image validation failure");
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => throw new NotSupportedException(method!.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
