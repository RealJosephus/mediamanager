// Records actual BoxSet affiliation and its BeforeSave/None refresh ordering.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.BoxSets;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var control = (LibraryProxy)(object)library;
    control.Real = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    BaseItem.ConfigurationManager = config; BaseItem.LibraryManager = library; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        BaseItem item = definition.GetProperty("type").GetString() switch {
            "AggregateFolder" => new AggregateFolder(), "UserRootFolder" => new UserRootFolder(), "Folder" => new Folder(),
            "CollectionFolder" => new CollectionFolder(), "Movie" => new Movie(), "BoxSet" => new BoxSet(), _ => throw new NotSupportedException()
        };
        foreach (var field in definition.EnumerateObject()) if (!new[] { "key", "type", "parent", "links", "missingLinks" }.Contains(field.Name)) {
            var property = item.GetType().GetProperty(field.Name)!;
            property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
        }
        if (item is Folder folder) folder.Children = [];
        control.Items.Add(definition.GetProperty("key").GetString()!, item);
    }
    foreach (var definition in scenario.GetProperty("items").EnumerateArray()) {
        var item = control.Items[definition.GetProperty("key").GetString()!];
        if (definition.TryGetProperty("parent", out var parent)) {
            var folder = (Folder)control.Items[parent.GetString()!]; item.SetParent(folder);
        }
        if (item is Folder container && definition.TryGetProperty("links", out var links)) {
            container.LinkedChildren = links.EnumerateArray().Select(value => new LinkedChild { ItemId = control.Items[value.GetString()!].Id }).ToArray();
            if (definition.TryGetProperty("missingLinks", out var missing)) container.LinkedChildren = [.. container.LinkedChildren,
                .. missing.EnumerateArray().Select(value => new LinkedChild { ItemId = value.GetGuid() })];
        }
    }
    foreach (var folder in control.Items.Values.OfType<Folder>()) folder.Children = control.Items.Values.Where(item => item.ParentId == folder.Id).ToArray();
    control.Root = (UserRootFolder)control.Items["userRoot"];
    control.Root.Children = control.Root.Children.OrderBy(item => item.SortName, StringComparer.Ordinal).ToArray();
    var box = (BoxSet)control.Items[scenario.GetProperty("target").GetString()!];
    var service = new BoxSetMetadataService(config, NullLogger<BoxSetMetadataService>.Instance, null!, BaseItem.FileSystem, library, null!,
        DispatchProxy.Create<IItemRepository, RepositoryProxy>());
    int? updateType = null; string? exception = null;
    try {
        if (scenario.GetProperty("mode").GetString() == "before") {
            updateType = (int)(ItemUpdateType)typeof(BoxSetMetadataService).GetMethod("BeforeSaveInternal", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(service, [box, false, ItemUpdateType.None])!;
        } else {
            using var providers = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance, BaseItem.FileSystem,
                null!, library, null!, null!, null!, null!, null!);
            providers.AddParts([], [], [], [], [], []);
            service = new BoxSetMetadataService(config, NullLogger<BoxSetMetadataService>.Instance, providers, BaseItem.FileSystem, library, null!,
                DispatchProxy.Create<IItemRepository, RepositoryProxy>());
            updateType = (int)await service.RefreshMetadata(box, new MetadataRefreshOptions((IDirectoryService)null!) {
                MetadataRefreshMode = MetadataRefreshMode.None, ImageRefreshMode = MetadataRefreshMode.None }, CancellationToken.None);
        }
        if (scenario.TryGetProperty("expectException", out _)) throw new InvalidOperationException("Expected native exception was not raised.");
    } catch (Exception error) {
        exception = (error is TargetInvocationException reflectionError ? reflectionError.InnerException : error)!.GetType().Name;
        if (!scenario.TryGetProperty("expectException", out var expected) || exception != expected.GetString()) throw;
    }
    object? mapped = exception is null ? Projection.Map(box) : null;
    results.Add(new { name = scenario.GetProperty("name").GetString(), updateType, exception, item = Projection.Capture(box), mapped, calls = control.Calls });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual BoxSet.GetLibraryFolderIds, nested/cycle traversal, Folder linked resolution, actual LibraryManager.GetCollectionFolders, BoxSetMetadataService.BeforeSaveInternal and None RefreshMetadata with actual ProviderManager, plus BaseItemMapper data projection. Typed cached entities, root order, ItemId query/lookup, identity path reversal, absent files, default library options and repository callbacks are controlled. No native SQL, HTTP, files, NFO or external collection link merge runs." }, json) + "\n");

public static class Projection {
    public static object Capture(BoxSet item) => new { item.LibraryFolderIds, item.PresentationUniqueKey };
    public static object Map(BoxSet item) {
        var entity = BaseItemMapper.Map(item, DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>());
        var data = JsonDocument.Parse(entity.Data!).RootElement;
        return new { LibraryFolderIds = data.GetProperty("LibraryFolderIds") };
    }
}
public class ApplicationHostProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ReverseVirtualPath" ? args![0] : throw new NotSupportedException(method.Name);
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_Configuration" => new ServerConfiguration { MetadataCountryCode = "US" },
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null, _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    public Dictionary<string, BaseItem> Items = []; public UserRootFolder Root = null!; public LibraryManager Real = null!; public List<object> Calls = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetItemById" => Items.Values.FirstOrDefault(item => item.Id == (Guid)args![0]!),
        "GetItemList" => Items.Values.Where(item => ((InternalItemsQuery)args![0]!).ItemIds.Contains(item.Id)).ToArray(),
        "GetUserRootFolder" => Root,
        "GetCollectionFolders" => Real.GetCollectionFolders((BaseItem)args![0]!, args.Length > 1 ? (IEnumerable<Folder>)args[1]! : Root.Children.OfType<Folder>()),
        "GetLibraryOptions" => new LibraryOptions(),
        "UpdateItemAsync" => Update((BoxSet)args![0]!, (ItemUpdateType)args[2]!),
        _ => throw new NotSupportedException(method.Name)
    };
    private Task Update(BoxSet item, ItemUpdateType reason) { Calls.Add(new { item = Projection.Capture(item), updateReason = (int)reason }); return Task.CompletedTask; }
}
public class FileSystemProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetFileSystemInfo" or "GetFileInfo" => new FileSystemMetadata { Exists = false },
        "IsPathFile" => true, _ => throw new NotSupportedException(method.Name)
    };
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
