// Actual frozen Video.UpdateToRepositoryAsync and MetadataService.SaveItemAsync.
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
using MediaBrowser.Providers.Movies;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true, NumberHandling = JsonNumberHandling.AllowReadingFromString };
json.Converters.Add(new JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray())
{
    var items = new Dictionary<string, BaseItem>();
    foreach (var definition in sample.GetProperty("items").EnumerateArray())
    {
        BaseItem item = definition.GetProperty("type").GetString() switch
        {
            "Movie" => new Movie(), "Audio" => new Audio(), _ => new Video()
        };
        foreach (var field in definition.EnumerateObject())
        {
            if (field.Name is "key" or "type") continue;
            var property = item.GetType().GetProperty(field.Name)!;
            property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
        }
        items.Add(definition.GetProperty("key").GetString()!, item);
    }
    var owner = items["owner"];
    var links = sample.GetProperty("links").EnumerateObject().ToDictionary(field => field.Name,
        field => field.Value.EnumerateArray().Select(value => value.GetString()!).ToArray());
    var calls = new List<object>();
    var commits = new List<object>();
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) =>
    {
        switch (method.Name)
        {
            case "GetItemById": return items.Values.FirstOrDefault(item => item.Id == (Guid)values![0]!);
            case "GetLocalAlternateVersionIds":
                var key = Key((BaseItem)values![0]!);
                return (links.GetValueOrDefault(key) ?? []).Select(link => items.TryGetValue(link, out var item)
                    ? item.Id : Guid.Parse("98b80000-0000-0000-0000-000000000099")).ToArray();
            case "UpdateItemAsync":
                var saved = (BaseItem)values![0]!;
                var savedKey = Key(saved);
                var reason = (int)(ItemUpdateType)values[2]!;
                calls.Add(new { action = "update", key = savedKey, reason, item = Project(saved),
                    sameImages = ReferenceEquals(saved.ImageInfos, owner.ImageInfos),
                    sameGenres = ReferenceEquals(saved.Genres, owner.Genres), sameProviders = ReferenceEquals(saved.ProviderIds, owner.ProviderIds) });
                ((CancellationToken)values[3]!).ThrowIfCancellationRequested();
                if (sample.TryGetProperty("failSave", out var fail) && fail.GetString() == savedKey) throw new IOException("Injected repository failure");
                commits.Add(new { key = savedKey, reason, item = Project(saved) });
                if (sample.TryGetProperty("cancelAfterSave", out var cancel) && cancel.GetString() == savedKey) cancellation.Cancel();
                if (sample.TryGetProperty("replaceLinksAfterSave", out var replace) && replace.GetProperty("key").GetString() == savedKey)
                    links[savedKey] = replace.GetProperty("links").EnumerateArray().Select(value => value.GetString()!).ToArray();
                if (sample.TryGetProperty("mutateAfterSave", out var mutate) && mutate.GetProperty("key").GetString() == savedKey)
                {
                    saved.Genres[0] = "Mutated genre";
                    saved.ProviderIds["Injected"] = "303";
                    saved.ImageInfos[0].Width = 99;
                }
                return Task.CompletedTask;
            case "ReattachUserDataAsync": calls.Add(new { action = "reattach", key = Key((BaseItem)values![0]!) }); return Task.CompletedTask;
            case "UpdatePeopleAsync": calls.Add(new { action = "people", key = Key((BaseItem)values![0]!) }); return Task.CompletedTask;
            default: throw new NotSupportedException(method.Name);
        }
    });
    string? exception = null;
    try
    {
        var reason = (ItemUpdateType)sample.GetProperty("reason").GetInt32();
        if (sample.TryGetProperty("saveItem", out var saveItem) && saveItem.GetBoolean())
        {
            var service = new MovieMetadataService(null!, NullLogger<MovieMetadataService>.Instance, null!, null!, BaseItem.LibraryManager, null!, null!);
            await (Task)typeof(MovieMetadataService).GetMethod("SaveItemAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(service, [new MetadataResult<Movie> { Item = (Movie)owner, People = [new PersonInfo { Name = "Controlled person" }] }, reason, true, cancellation.Token])!;
        }
        else await owner.UpdateToRepositoryAsync(reason, cancellation.Token);
    }
    catch (Exception error) { exception = error.GetBaseException().GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, calls, commits,
        items = items.Select(pair => new { key = pair.Key, item = Project(pair.Value) }) });
    string Key(BaseItem item) => items.First(pair => pair.Value.Id == item.Id).Key;
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenVideoRepository = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(BaseItem).Assembly, typeof(MovieMetadataService).Assembly }.Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }),
    results,
    scope = "Actual frozen Video.UpdateToRepositoryAsync and MetadataService.SaveItemAsync over Movie/Video/Audio entities. Native copy fields, null clearing, shared references, recursive/repeated/missing-linked dispatch and SaveItem reattachment/people order execute. Linked ID lookup and repository commits/failures/cancellation/mutations are controls. No native SQL, saver/image processing, file discovery, providers or complete library acceptance."
}, json) + "\n");

static object Project(BaseItem item) => new
{
    item.Name, item.Path, Genres = item.Genres?.ToArray(), item.Overview, item.ProductionYear, item.PremiereDate, item.CommunityRating,
    item.OfficialRating, ProviderIds = new Dictionary<string, string>(item.ProviderIds),
    ImageInfos = item.ImageInfos.Select(image => new { image.Type, image.Path, image.Width, image.Height, image.DateModified }).ToArray(),
    Studios = item.Studios?.ToArray(), Tags = item.Tags?.ToArray(), item.CriticRating, item.CustomRating, item.OriginalTitle, item.RunTimeTicks,
    item.IsLocked, LockedFields = item.LockedFields?.ToArray()
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
