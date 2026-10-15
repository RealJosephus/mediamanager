// Records the actual BaseItemMapper hydrate/map sort-name roundtrip.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
BaseItem.LibraryManager = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var cache = typeof(BaseItem).GetField("_sortName", BindingFlags.Instance | BindingFlags.NonPublic)!;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var definition = scenario.GetProperty("item");
    var type = BaseItemMapper.GetType(definition.GetProperty("Type").GetString()!)!;
    var row = JsonSerializer.Deserialize<BaseItemEntity>(definition.GetRawText(), json)!;
    var item = BaseItemMapper.Map(row, (BaseItem)Activator.CreateInstance(type)!, null);
    var hydratedCache = cache.GetValue(item);
    if (scenario.TryGetProperty("changes", out var changes)) foreach (var change in changes.EnumerateObject()) {
        var property = type.GetProperty(change.Name)!;
        property.SetValue(item, JsonSerializer.Deserialize(change.Value.GetRawText(), property.PropertyType, json));
    }
    var saved = BaseItemMapper.Map(item, null!);
    results.Add(new { name = scenario.GetProperty("name").GetString(), hydratedCache,
        result = new { saved.Name, saved.ForcedSortName, saved.SortName, saved.IndexNumber, saved.ParentIndexNumber } });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual BaseItemMapper entity-to-item and item-to-entity mapping, actual type sort getters and Name/ForcedSortName setter invalidation. Pathless items, explicit scalar changes, empty collection lookup and inactive recording lookup are controlled. Repository persistence, a previously warmed item cache, full refresh hooks, providers, NFO and file operations are excluded."
}, json));

public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? new ServerConfiguration() : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetItemById" => null, _ => throw new NotSupportedException(method.Name)
    };
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
