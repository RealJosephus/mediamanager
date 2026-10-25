// Runs the pinned Series service and real TV entities; effects are explicit controls.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Naming.TV;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Sorting;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Sorting;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.TV;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var configControl = (ConfigurationProxy)(object)config;
    configControl.Data.DisplaySpecialsWithinSeasons = !scenario.TryGetProperty("displaySpecials", out var specials) || specials.GetBoolean();
    configControl.Data.EnableCaseSensitiveItemIds = scenario.TryGetProperty("caseSensitive", out var sensitive) && sensitive.GetBoolean();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, SourcesProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var control = (LibraryProxy)(object)library; BaseItem.LibraryManager = library;
    control.Real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetField("_configurationManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(control.Real, config);
    typeof(LibraryManager).GetField("_namingOptions", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(control.Real, new NamingOptions());
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(control.Real,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    if (scenario.TryGetProperty("libraryOptions", out var options)) control.Options = JsonSerializer.Deserialize<LibraryOptions>(options.GetRawText(), json)!;
    control.Failure = scenario.TryGetProperty("failure", out var failure) ? failure.GetString() : null;
    control.FailureAt = scenario.TryGetProperty("failureAt", out var failureAt) ? failureAt.GetInt32() : 1;
    var repository = DispatchProxy.Create<IItemRepository, RepositoryProxy>();
    ((RepositoryProxy)(object)repository).Library = control; BaseItem.ItemRepository = repository;
    var createdRefresh = DispatchProxy.Create<IProviderManager, CreatedRefreshProxy>();
    ((CreatedRefreshProxy)(object)createdRefresh).Library = control; BaseItem.ProviderManager = createdRefresh;
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        BaseItem item = definition.GetProperty("type").GetString() switch {
            "Series" => new Series(), "Season" => new Season(), "Episode" => new Episode(), "Folder" => new Folder(), _ => throw new NotSupportedException()
        };
        foreach (var field in definition.EnumerateObject()) if (!new[] { "key", "type", "parent", "links", "ancestors", "SortName" }.Contains(field.Name)) {
            var property = item.GetType().GetProperty(field.Name)!;
            property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
        }
        if (item is Folder folder) folder.Children = [];
        control.Items.Add(definition.GetProperty("key").GetString()!, item);
        control.StoredSort[item.Id] = definition.TryGetProperty("SortName", out var sort) ? sort.GetString() : item.SortName;
    }
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        var item = control.Items[definition.GetProperty("key").GetString()!];
        if (definition.TryGetProperty("parent", out var parent) && parent.ValueKind != JsonValueKind.Null) item.SetParent((Folder)control.Items[parent.GetString()!]);
        if (item is Folder folder && definition.TryGetProperty("links", out var links)) folder.LinkedChildren = links.EnumerateArray()
            .Select(value => new LinkedChild { ItemId = control.Items[value.GetString()!].Id }).ToArray();
        if (definition.TryGetProperty("ancestors", out var ancestors)) control.Ancestors[item.Id] = ancestors.EnumerateArray().Select(value => control.Items[value.GetString()!].Id).ToArray();
    }
    foreach (var folder in control.Items.Values.OfType<Folder>()) folder.Children = control.Query(new InternalItemsQuery { Parent = folder }).ToArray();
    foreach (var item in control.Items.Values) control.Persisted[item.Id] = Projection.Capture(item);
    var series = (Series)control.Items[scenario.GetProperty("target").GetString()!];
    using var providers = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance, BaseItem.FileSystem, null!, library, null!, null!, null!, null!, null!);
    providers.AddParts([], [], [], [], [], []);
    var service = new SeriesMetadataService(config, NullLogger<SeriesMetadataService>.Instance, providers, BaseItem.FileSystem, library,
        DispatchProxy.Create<ILocalizationManager, LocalizationProxy>(), null!, repository);
    using var cancellation = new CancellationTokenSource();
    if (scenario.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    var refresh = new MetadataRefreshOptions((IDirectoryService)null!) { MetadataRefreshMode = MetadataRefreshMode.None,
        ImageRefreshMode = MetadataRefreshMode.None, ReplaceAllMetadata = scenario.TryGetProperty("replace", out var replace) && replace.GetBoolean() };
    string? exception = null; int? updateType = null;
    try {
        if (scenario.GetProperty("mode").GetString() == "after") {
            await (Task)typeof(SeriesMetadataService).GetMethod("AfterMetadataRefresh", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [series, refresh, cancellation.Token])!;
        } else updateType = (int)await service.RefreshMetadata(series, refresh, cancellation.Token);
    } catch (Exception error) {
        exception = (error is TargetInvocationException wrapped ? wrapped.InnerException : error)!.GetType().Name;
        if (!scenario.TryGetProperty("expectException", out var expected) || exception != expected.GetString()) throw;
    }
    if (exception is null && scenario.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected failure was not raised.");
    results.Add(new { name = scenario.GetProperty("name").GetString(), updateType, exception,
        items = control.Items.Values.OrderBy(item => item.Id).Select(Projection.Capture),
        persisted = control.Persisted.OrderBy(pair => pair.Key).Select(pair => pair.Value), calls = control.Calls });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual SeriesMetadataService Before/After and None refresh; actual TV entities, recursive/linked traversal, season/episode filters and native comparers; actual naming and item-id methods; actual Folder.AddChild and BaseItem.RefreshMetadata defaults; actual BaseItemMapper for creations. Typed cached entities, SQL query arrays/filtering, library options, localization strings, update/create/delete effects and new-season RefreshSingleItem are controlled. No native SQL, metadata files, NFO or external provider execution."
}, json) + "\n");

public static class Projection {
    public static object Capture(BaseItem item) => new { id = item.Id, type = item.GetType().Name, item.Name, item.Path, item.ParentId,
        item.IndexNumber, item.ParentIndexNumber, item.IsVirtualItem, item.PresentationUniqueKey,
        SeriesId = (item as IHasSeries)?.SeriesId, SeriesName = (item as IHasSeries)?.SeriesName,
        SeriesPresentationUniqueKey = (item as IHasSeries)?.SeriesPresentationUniqueKey,
        SeasonId = (item as Episode)?.SeasonId, SeasonName = (item as Episode)?.SeasonName,
        IndexNumberEnd = (item as Episode)?.IndexNumberEnd, item.ProductionYear, item.PremiereDate };
    public static object Mapped(BaseItem item) {
        var row = BaseItemMapper.Map(item, DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>());
        return new { row.Id, row.Type, row.Name, row.IndexNumber, row.ParentId, row.SeriesId, row.SeriesName, row.SeriesPresentationUniqueKey,
            row.PresentationUniqueKey, row.IsFolder, row.IsVirtualItem, row.MediaType, row.UnratedType, row.ChannelId, row.Data, row.SortName,
            row.CleanName, row.Genres, row.Studios, row.Tags, row.ProductionLocations,
            created = row.DateCreated.HasValue, modified = row.DateModified.HasValue, saved = row.DateLastSaved.HasValue, refreshed = row.DateLastRefreshed.HasValue };
    }
    public static object Relations(BaseItem item, IEnumerable<BaseItem> existing) => new {
        ancestorIds = item.GetAncestorIds().Where(id => existing.Any(candidate => candidate.Id == id)).Distinct().OrderBy(id => id),
        inheritedTags = item.GetInheritedTags().OrderBy(tag => tag, StringComparer.Ordinal)
    };
}
public class ApplicationHostProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ReverseVirtualPath" ? args![0] : throw new NotSupportedException(method.Name);
}
public class ConfigurationProxy : DispatchProxy {
    public ServerConfiguration Data = new() { MetadataCountryCode = "US" };
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => Data, "get_ApplicationPaths" => DispatchProxy.Create<IServerApplicationPaths, PathsProxy>(),
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null, _ => throw new NotSupportedException(method.Name)
    };
}
public class PathsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_ProgramDataPath" ? @"Z:\SeriesOracleState" : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<string, BaseItem> Items = []; public Dictionary<Guid, string?> StoredSort = []; public Dictionary<Guid, Guid[]> Ancestors = [];
    public Dictionary<Guid, object> Persisted = [];
    public LibraryOptions Options = new(); public LibraryManager Real = null!; public List<object> Calls = [];
    public string? Failure; public int FailureAt = 1; private Dictionary<string, int> _attempts = [];
    public void Fail(string operation) {
        _attempts[operation] = _attempts.GetValueOrDefault(operation) + 1;
        if (Failure == operation && _attempts[operation] == FailureAt) throw new IOException("Injected " + operation + " failure");
    }
    public IEnumerable<BaseItem> Query(InternalItemsQuery query) {
        IEnumerable<BaseItem> result = Items.Values;
        if (query.ParentId != Guid.Empty) result = result.Where(item => item.ParentId == query.ParentId);
        if (query.ItemIds.Length > 0) result = result.Where(item => query.ItemIds.Contains(item.Id));
        if (query.IncludeItemTypes.Length > 0) result = result.Where(item => query.IncludeItemTypes.Any(type => type.ToString() == item.GetType().Name));
        if (!string.IsNullOrWhiteSpace(query.SeriesPresentationUniqueKey)) result = result.Where(item => (item as IHasSeries)?.SeriesPresentationUniqueKey == query.SeriesPresentationUniqueKey);
        if (!string.IsNullOrWhiteSpace(query.AncestorWithPresentationUniqueKey)) {
            var parents = Items.Values.Where(item => item.PresentationUniqueKey == query.AncestorWithPresentationUniqueKey).Select(item => item.Id).ToHashSet();
            result = result.Where(item => Ancestors.GetValueOrDefault(item.Id, []).Any(parents.Contains));
        }
        return result.OrderBy(item => StoredSort.GetValueOrDefault(item.Id), StringComparer.Ordinal).ToArray();
    }
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemById" => Items.Values.FirstOrDefault(item => item.Id == (Guid)args![0]!),
        "GetItemList" => Query((InternalItemsQuery)args![0]!).ToArray(), "GetLibraryOptions" => Options, "GetCollectionFolders" => new List<Folder>(),
        "GetLocalAlternateVersionIds" => Array.Empty<Guid>(), "GetLinkedAlternateVersions" => Enumerable.Empty<Video>(),
        "Sort" => Real.Sort((IEnumerable<BaseItem>)args![0]!, null, (IEnumerable<ItemSortBy>)args[2]!, (SortOrder)args[3]!),
        "GetNewItemId" => Real.GetNewItemId((string)args![0]!, (Type)args[1]!),
        "GetSeasonNumberFromPath" => SeasonPathParser.Parse((string)args![0]!, args[1] is Guid id ? Items.Values.FirstOrDefault(item => item.Id == id)?.ContainingFolderPath : null, true, true).SeasonNumber,
        "FillMissingEpisodeNumbersFromPath" => Real.FillMissingEpisodeNumbersFromPath((Episode)args![0]!, (bool)args[1]!),
        "UpdateItemAsync" => Update((BaseItem)args![0]!, (ItemUpdateType)args[2]!, (CancellationToken)args[3]!),
        "CreateItem" => Create((BaseItem)args![0]!, (BaseItem)args[1]!),
        "DeleteItem" => Delete((BaseItem)args![0]!, (DeleteOptions)args[1]!, (bool)args[2]!),
        "ReattachUserDataAsync" => Task.CompletedTask,
        _ => throw new NotSupportedException(method.Name)
    };
    private Task Update(BaseItem item, ItemUpdateType reason, CancellationToken token) {
        token.ThrowIfCancellationRequested(); Fail("update");
        Calls.Add(new { action = "update", item = Projection.Capture(item), reason = (int)reason, relations = Projection.Relations(item, Items.Values) });
        Persisted[item.Id] = Projection.Capture(item);
        StoredSort[item.Id] = item.SortName; return Task.CompletedTask;
    }
    private object? Create(BaseItem item, BaseItem parent) {
        Fail("create"); Calls.Add(new { action = "create", item = Projection.Capture(item), mapped = Projection.Mapped(item), relations = Projection.Relations(item, Items.Values) });
        Items[item.Id.ToString("N")] = item; StoredSort[item.Id] = item.SortName; ((Folder)parent).Children = null;
        Persisted[item.Id] = Projection.Capture(item);
        return null;
    }
    private object? Delete(BaseItem item, DeleteOptions options, bool notify) {
        Fail("delete"); Calls.Add(new { action = "delete", item = Projection.Capture(item), options.DeleteFileLocation, notify });
        var parent = item.GetParent(); var descendants = item is Folder folder ? folder.GetRecursiveChildren(false) : [];
        var ids = descendants.Select(child => child.Id).Append(item.Id).ToHashSet();
        foreach (var key in Items.Where(pair => ids.Contains(pair.Value.Id)).Select(pair => pair.Key).ToArray()) Items.Remove(key);
        foreach (var id in ids) Persisted.Remove(id);
        item.SetParent(null!); if (parent is Folder container) container.Children = null;
        return null;
    }
}
public class RepositoryProxy : DispatchProxy {
    public LibraryProxy Library = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemList" => Library.Query((InternalItemsQuery)args![0]!).ToArray(), "ItemExistsAsync" => Task.FromResult(true), _ => throw new NotSupportedException(method.Name)
    };
}
public class CreatedRefreshProxy : DispatchProxy {
    public LibraryProxy Library = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name != "RefreshSingleItem") throw new NotSupportedException(method.Name);
        var options = (MetadataRefreshOptions)args![1]!;
        Library.Fail("refresh"); ((CancellationToken)args[2]!).ThrowIfCancellationRequested();
        Library.Calls.Add(new { action = "refresh", id = ((BaseItem)args[0]!).Id, options.MetadataRefreshMode, options.ImageRefreshMode, options.IsAutomated,
            options.ForceSave, options.ReplaceAllMetadata });
        return Task.FromResult(ItemUpdateType.None);
    }
}
public class LocalizationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetLocalizedString" ? (string)args![0]! switch {
        "NameSeasonUnknown" => "Season Unknown", "NameSeasonNumber" => "Season {0}", _ => throw new NotSupportedException((string)args[0]!)
    } : throw new NotSupportedException(method.Name);
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "IsPathFile" => true, "GetFileSystemInfo" or "GetFileInfo" => new FileSystemMetadata { Exists = false }, _ => throw new NotSupportedException(method.Name)
    };
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class SourcesProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetPathProtocol"
        ? args![0] is string path && path.Length > 0 ? path.StartsWith("http") ? MediaProtocol.Http : MediaProtocol.File : (MediaProtocol?)null
        : throw new NotSupportedException(method.Name);
}
