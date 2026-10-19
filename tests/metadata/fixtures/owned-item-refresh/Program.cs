// Executes the actual frozen BaseItem.RefreshMetadataForOwnedItem method.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;

var json = new JsonSerializerOptions { WriteIndented = true, PropertyNameCaseInsensitive = false };
json.Converters.Add(new JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) =>
    method.Name == "GetPathProtocol" ? MediaProtocol.File : throw new NotSupportedException(method.Name));
var inheritDates = typeof(BaseItem).GetMethod("InheritDatesFromOwner", BindingFlags.Static | BindingFlags.NonPublic)!;
var refreshOwned = typeof(BaseItem).GetMethod("RefreshMetadataForOwnedItem", BindingFlags.Instance | BindingFlags.NonPublic)!;
foreach (var sample in input.EnumerateArray())
{
    var owner = (Movie)Instantiate(typeof(Movie), sample.GetProperty("owner"), json);
    var ownedType = sample.GetProperty("ownedType").GetString();
    var type = ownedType switch { "Audio" => typeof(Audio), "Trailer" => typeof(Trailer), _ => typeof(Video) };
    var owned = Instantiate(type, sample.GetProperty("owned"), json);
    owner.Id = Guid.Parse("97a70000-0000-0000-0000-000000000001");
    owned.Id = Guid.Parse("97a70000-0000-0000-0000-000000000002");
    owned.OwnerId = owner.Id;
    owned.ParentId = Guid.Empty;
    var configured = sample.GetProperty("options");
    var options = new MetadataRefreshOptions((IDirectoryService)null!)
    {
        MetadataRefreshMode = configured.TryGetProperty("MetadataRefreshMode", out var mode)
            ? Enum.Parse<MetadataRefreshMode>(mode.GetString()!) : MetadataRefreshMode.Default,
        ImageRefreshMode = MetadataRefreshMode.Default,
        SearchResult = new RemoteSearchResult { Name = "Owner-specific search", SearchProviderName = "Frozen" },
        ForceSave = configured.TryGetProperty("ForceSave", out var force) && force.GetBoolean(),
        ReplaceAllMetadata = configured.TryGetProperty("ReplaceAllMetadata", out var replace) && replace.GetBoolean(),
        IsAutomated = true,
        RefreshPaths = configured.TryGetProperty("RefreshPaths", out var paths)
            ? JsonSerializer.Deserialize<string[]>(paths.GetRawText(), json) : null
    };
    var calls = new List<object>();
    BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, values) =>
    {
        if (method.Name != "RefreshSingleItem") throw new NotSupportedException(method.Name);
        var forwarded = (MetadataRefreshOptions)values![1]!;
        calls.Add(new
        {
            action = "RefreshSingleItem",
            item = Project((BaseItem)values[0]!),
            options = new { forwarded.ForceSave, forwarded.MetadataRefreshMode, forwarded.ImageRefreshMode,
                forwarded.ReplaceAllMetadata, forwarded.IsAutomated, forwarded.SearchResult, forwarded.RefreshPaths },
            sameOptions = ReferenceEquals(options, forwarded),
            sameRefreshPaths = ReferenceEquals(options.RefreshPaths, forwarded.RefreshPaths),
            cancellationRequested = ((CancellationToken)values[2]!).IsCancellationRequested
        });
        return Task.FromResult(ItemUpdateType.None);
    });
    using var cancelled = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancel) && cancel.GetBoolean()) cancelled.Cancel();
    string? exception = null;
    bool? datesChanged = null;
    try
    {
        if (sample.TryGetProperty("datesOnly", out var datesOnly) && datesOnly.GetBoolean())
            datesChanged = (bool)inheritDates.Invoke(null, [owner, owned])!;
        else
            await (Task)refreshOwned.Invoke(owner,
                [owned, sample.GetProperty("copyTitleMetadata").GetBoolean(), options, cancelled.Token])!;
    }
    catch (Exception error)
    {
        exception = (error is TargetInvocationException wrapped ? wrapped.InnerException : error)!.GetType().Name;
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, datesChanged,
        owned = Project(owned), owner = Project(owner), calls,
        originalOptions = new { options.ForceSave, options.MetadataRefreshMode, options.SearchResult, options.RefreshPaths } });
}
var assemblies = new[] { typeof(BaseItem).Assembly }.Select(assembly => new
{
    name = assembly.GetName().Name,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
});
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenOwnedItemRefresh = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    results,
    assemblies,
    scope = "Actual frozen BaseItem.RefreshMetadataForOwnedItem and InheritDatesFromOwner. Native Movie/Video/Trailer/Audio entities, metadata option copying, field mutations and child RefreshMetadata dispatch execute. ProviderManager.RefreshSingleItem and path protocol are controls; owned children have no physical parent. File discovery, provider execution, images, persistence, full owner RefreshMetadata and complete library acceptance are excluded."
}, json) + "\n");

static BaseItem Instantiate(Type type, JsonElement values, JsonSerializerOptions options)
{
    // Native entity JsonIgnore attributes suppress ordinary JSON hydration.
    // Set the actual public properties explicitly from the controlled input.
    var item = (BaseItem)Activator.CreateInstance(type)!;
    foreach (var value in values.EnumerateObject())
    {
        var property = type.GetProperty(value.Name, BindingFlags.Public | BindingFlags.Instance)!;
        property.SetValue(item, JsonSerializer.Deserialize(value.Value.GetRawText(), property.PropertyType, options));
    }
    return item;
}

static object Project(BaseItem item) => new
{
    item.Name, item.Path, item.Genres, item.Studios, item.ProductionLocations,
    item.CommunityRating, item.CriticRating, item.Overview, item.OfficialRating, item.CustomRating,
    item.ProductionYear, item.PremiereDate, item.IsLocked, item.LockedFields,
    item.ProviderIds, item.Tags, item.OriginalTitle, item.RunTimeTicks
};

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var proxy = Create<T, Stub>();
        ((Stub)(object)proxy).Handler = handler;
        return proxy;
    }
}
