// Records the pinned Folder, Series and MusicAlbum metadata traversal methods.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LibraryTaskScheduler;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true, WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var entry in input.EnumerateArray()) {
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var errors = new List<object>();
    BaseItem.ConfigurationManager = configuration; BaseItem.Logger = new RecordingLogger<BaseItem>(errors);
    BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, MediaSourceProxy>();
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var repository = DispatchProxy.Create<IItemRepository, RepositoryProxy>();
    var provider = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var calls = (ProviderProxy)(object)provider;
    using var cancellation = new CancellationTokenSource(); calls.Cancellation = cancellation;
    calls.Fail = Text(entry, "fail"); calls.CancelAfter = Text(entry, "cancelAfter");
    var items = new Dictionary<string, BaseItem>(); var definitions = new Dictionary<string, JsonElement>();
    var children = new Dictionary<Guid, List<BaseItem>>(); var sequence = 0;
    BaseItem Create(JsonElement definition, Folder? parent = null) {
        BaseItem item = Text(definition, "type") switch {
            "Folder" => new Folder(), "Series" => new Series(), "Season" => new Season(), "Episode" => new Episode(),
            "MusicAlbum" => new MusicAlbum(), "Audio" => new Audio(), "MusicArtist" => new MusicArtist(), "Movie" => new Movie(),
            _ => throw new NotSupportedException()
        };
        item.Id = Guid.Parse($"84000000-0000-0000-0000-{++sequence:D12}"); item.Name = Text(definition, "name")!;
        item.Path = definition.TryGetProperty("path", out var path) ? path.GetString() : "https://media.invalid/" + item.Name;
        if (parent is not null) item.SetParent(parent);
        if (definition.TryGetProperty("virtual", out var virtualItem)) {
            item.IsVirtualItem = virtualItem.GetBoolean(); if (item.IsVirtualItem && !definition.TryGetProperty("path", out _)) item.Path = null;
        }
        if (definition.TryGetProperty("premiere", out var premiere)) item.PremiereDate = premiere.GetDateTime();
        if (item is IHasArtist artist && definition.TryGetProperty("artists", out var artists)) artist.Artists = artists.EnumerateArray().Select(value => value.GetString()!).ToArray();
        if (item is IHasAlbumArtist album && definition.TryGetProperty("albumArtists", out var albumArtists)) album.AlbumArtists = albumArtists.EnumerateArray().Select(value => value.GetString()!).ToArray();
        items.Add(item.Name, item); definitions.Add(item.Name, definition);
        calls.Updates[item.Id] = definition.TryGetProperty("updateType", out var updateType) ? (ItemUpdateType)updateType.GetInt32() : ItemUpdateType.None;
        if (item is Folder folder) {
            var values = definition.TryGetProperty("children", out var childValues) ? childValues.EnumerateArray().Select(value => Create(value, folder)).ToList() : [];
            children.Add(item.Id, values); folder.Children = values;
        }
        return item;
    }
    var root = (Folder)Create(entry.GetProperty("root"));
    if (entry.TryGetProperty("external", out var external)) foreach (var definition in external.EnumerateArray()) Create(definition);
    foreach (var (name, definition) in definitions) {
        if (items[name] is Folder folder && definition.TryGetProperty("links", out var links)) folder.LinkedChildren = links.EnumerateArray()
            .Select(value => new LinkedChild { ItemId = items[value.GetString()!].Id }).ToArray();
        if (items[name] is MusicArtist && definition.TryGetProperty("byName", out var byName) && !byName.GetBoolean()) items[name].SetParent(root);
    }
    var libraryProxy = (LibraryProxy)(object)library; libraryProxy.Items = items; libraryProxy.Lookups = calls.Lookups;
    ((RepositoryProxy)(object)repository).Children = children;
    BaseItem.LibraryManager = library; BaseItem.ItemRepository = repository; BaseItem.ProviderManager = provider;
    await using var scheduler = new LimitedConcurrencyLibraryScheduler(new Lifetime(), new RecordingLogger<LimitedConcurrencyLibraryScheduler>(errors), configuration);
    Folder.LimitedConcurrencyLibraryScheduler = scheduler;
    var options = new MetadataRefreshOptions((IDirectoryService)null!) { MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(Text(entry, "metadataMode") ?? "Default"),
        ImageRefreshMode = Enum.Parse<MetadataRefreshMode>(Text(entry, "imageMode") ?? "None"), IsAutomated = !entry.TryGetProperty("automated", out var automated) || automated.GetBoolean(),
        ReplaceAllMetadata = entry.TryGetProperty("replaceAllMetadata", out var replace) && replace.GetBoolean(),
        ForceSave = entry.TryGetProperty("forceSave", out var force) && force.GetBoolean(),
        RefreshPaths = entry.TryGetProperty("refreshPaths", out var refreshPaths) ? refreshPaths.EnumerateArray().Select(value => value.GetString()!).ToArray() : [] };
    object? error = null;
    try {
        var method = typeof(Folder).GetMethod("RefreshMetadataRecursive", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await (Task)method.Invoke(root, [children[root.Id], options, !entry.TryGetProperty("recursive", out var recursive) || recursive.GetBoolean(), new InlineProgress(), cancellation.Token])!;
    } catch (Exception exception) {
        if (exception is InvalidOperationException && exception.Message == "Unexpected oracle callback failure") throw;
        error = new { type = exception.GetType().Name, exception.Message };
    }
    results.Add(new { name = Text(entry, "name"), calls = calls.Calls, artistLookups = calls.Lookups, errors, error });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    sourceBoundary = "Actual Folder.RefreshMetadataRecursive, RefreshChildMetadata, Series and MusicAlbum.RefreshAllMetadata, BaseItem.RefreshMetadata and native sequential LimitedConcurrencyLibraryScheduler. Repository child lists, linked-child lookup, artist lookup and RefreshSingleItem results are controlled callbacks. Metadata providers, owned-item/file enumeration, structural reconciliation, persistence, image writes and top-level configuration are excluded. Paths use a synthetic non-file protocol; IsAutomated and RefreshPaths are explicit inputs.",
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(Folder).Assembly, typeof(JsonDefaults).Assembly }
        .Select(assembly => new { path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) }, json));

static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var property) ? property.GetString() : null;
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? new ServerConfiguration { LibraryScanFanoutConcurrency = 1 } : throw new NotSupportedException(method.Name);
}
public class RepositoryProxy : DispatchProxy {
    public Dictionary<Guid, List<BaseItem>> Children = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetItemList"
        ? Children.GetValueOrDefault(((InternalItemsQuery)args![0]!).ParentId, []) : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<string, BaseItem> Items = []; public List<string> Lookups = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "UpdateImagesAsync") return Task.CompletedTask;
        if (method.Name == "GetLinkedAlternateVersions") return Array.Empty<Video>();
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "GetItemList") { var query = (InternalItemsQuery)args![0]!; return Items.Values.Where(item => query.ItemIds.Contains(item.Id)).ToArray(); }
        if (method.Name == "GetItemById") return Items.Values.FirstOrDefault(item => item.Id == (Guid)args![0]!);
        if (method.Name == "GetArtist") { var name = (string)args![0]!; Lookups.Add(name); return Items[name]; }
        throw new NotSupportedException(method.Name);
    }
}
public class ProviderProxy : DispatchProxy {
    public List<object> Calls = []; public List<string> Lookups = []; public Dictionary<Guid, ItemUpdateType> Updates = [];
    public CancellationTokenSource Cancellation = null!; public string? Fail, CancelAfter;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name != "RefreshSingleItem") throw new NotSupportedException(method.Name);
        var item = (BaseItem)args![0]!; var options = (MetadataRefreshOptions)args[1]!; ((CancellationToken)args[2]!).ThrowIfCancellationRequested();
        Calls.Add(new { name = item.Name, type = item.GetType().Name, metadataMode = options.MetadataRefreshMode.ToString(), imageMode = options.ImageRefreshMode.ToString(),
            automated = options.IsAutomated, replaceAllMetadata = options.ReplaceAllMetadata, forceSave = options.ForceSave, refreshPaths = options.RefreshPaths });
        if (item.Name == Fail) throw new IOException("Injected refresh failure");
        if (item.Name == CancelAfter) Cancellation.Cancel();
        return Task.FromResult(Updates[item.Id]);
    }
}
public class InlineProgress : IProgress<double> { public void Report(double value) {} }
public class MediaSourceProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetPathProtocol" ? MediaProtocol.Http : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "IsPathFile" ? false : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class RecordingLogger<T>(List<object> errors) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Error;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) {
        if (logLevel >= LogLevel.Error) errors.Add(new { type = exception?.GetType().Name, message = exception?.Message, log = formatter(state, exception) });
        if (exception is not null and not IOException and not OperationCanceledException) throw new InvalidOperationException("Unexpected oracle callback failure", exception);
    }
}
public class Lifetime : IHostApplicationLifetime {
    public CancellationToken ApplicationStarted => CancellationToken.None; public CancellationToken ApplicationStopping => CancellationToken.None;
    public CancellationToken ApplicationStopped => CancellationToken.None; public void StopApplication() {}
}
