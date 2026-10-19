// Executes the native virtual support/search getters rather than reimplementing them.
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.MediaInfo;

var json = new JsonSerializerOptions { WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
var supports = typeof(BaseItem).GetProperty("SupportsOwnedItems", BindingFlags.Instance | BindingFlags.NonPublic)!;
var searches = typeof(BaseItem).GetProperty("SearchesContainingFolderForExtras", BindingFlags.Instance | BindingFlags.NonPublic)!;
foreach (var sample in input.EnumerateArray())
{
    var items = new Dictionary<string, BaseItem>();
    foreach (var definition in sample.GetProperty("items").EnumerateArray())
    {
        BaseItem item = definition.GetProperty("type").GetString() switch
        {
            "Movie" => new Movie(), "Video" => new Video(), "Episode" => new Episode(), "Season" => new Season(),
            "Audio" => new Audio(), "AudioBook" => new AudioBook(), "UserRootFolder" => new UserRootFolder(),
            "AggregateFolder" => new AggregateFolder(), "CollectionFolder" => new CollectionFolder(), _ => new Folder()
        };
        foreach (var field in definition.EnumerateObject())
        {
            if (new[] { "key", "type" }.Contains(field.Name)) continue;
            var property = item.GetType().GetProperty(field.Name)!;
            property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
        }
        items.Add(definition.GetProperty("key").GetString()!, item);
    }
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol"
        ? values![0] is not string path || string.IsNullOrEmpty(path) ? (MediaProtocol?)null
            : path.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? MediaProtocol.Http : MediaProtocol.File
        : throw new NotSupportedException(method.Name));
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetItemById" => items.Values.FirstOrDefault(item => item.Id == (Guid)values![0]!),
        "GetLocalAlternateVersionIds" => sample.GetProperty("links").EnumerateArray()
            .Where(link => link.GetProperty("parent").GetString() == items.First(pair => pair.Value.Id == ((Video)values![0]!).Id).Key
                && link.GetProperty("childType").GetInt32() == 2)
            .Select(link => items[link.GetProperty("child").GetString()!].Id).ToArray(),
        "GetLinkedAlternateVersions" => sample.GetProperty("links").EnumerateArray()
            .Where(link => link.GetProperty("parent").GetString() == items.First(pair => pair.Value.Id == ((Video)values![0]!).Id).Key
                && link.GetProperty("childType").GetInt32() == 3)
            .Select(link => items[link.GetProperty("child").GetString()!]).OfType<Video>().ToArray(),
        _ => throw new NotSupportedException(method.Name)
    });
    var target = items["target"];
    results.Add(new { name = sample.GetProperty("name").GetString(), supportsOwnedItems = supports.GetValue(target),
        searchesContainingFolderForExtras = searches.GetValue(target), mediaSourceCount = (target as Video)?.MediaSourceCount });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenOwnedItemSupport = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    assemblies = new[] { typeof(BaseItem).Assembly }.Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }), results,
    scope = "Actual frozen virtual BaseItem/Folder/Audio/Episode SupportsOwnedItems, SearchesContainingFolderForExtras and Video.MediaSourceCount getters. Typed native entities execute; path protocol and linked-version arrays are controls. No refresh dispatch, discovery, provider/probe/image execution or persistence."
}, json) + "\n");

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
}
