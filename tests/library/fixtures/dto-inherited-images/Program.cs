using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Jellyfin.Extensions;
using Jellyfin.Extensions.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true };
var fields = new HashSet<string>([
    "ImageTags", "BackdropImageTags", "ImageBlurHashes", "ParentPrimaryImageItemId", "ParentPrimaryImageTag",
    "ParentLogoItemId", "ParentLogoImageTag", "ParentArtItemId", "ParentArtImageTag", "ParentThumbItemId",
    "ParentThumbImageTag", "ParentBackdropItemId", "ParentBackdropImageTags", "AlbumPrimaryImageTag", "AlbumId"
]);
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? new ServerConfiguration() : null);
BaseItem.ConfigurationManager = config;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance,
    Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_TempDirectory" ? Path.GetTempPath() : null), []);
MediaBrowser.Controller.Entities.Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((_, _) => null);
var processorType = Assembly.Load("Jellyfin.Drawing").GetType("Jellyfin.Drawing.ImageProcessor")!;
var processor = (IImageProcessor)RuntimeHelpers.GetUninitializedObject(processorType);
var service = (DtoService)RuntimeHelpers.GetUninitializedObject(typeof(DtoService));
void Field(string name, object value) => typeof(DtoService).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, value);
Field("_logger", NullLogger<DtoService>.Instance);
Field("_imageProcessor", processor);
var types = new Dictionary<string, string>();
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray())
{
    var items = new Dictionary<string, BaseItem>();
    var definitions = sample.GetProperty("items").EnumerateArray().ToArray();
    foreach (var (definition, index) in definitions.Select((value, index) => (value, index)))
    {
        var name = definition.GetProperty("Type").GetString()!;
        var type = new[] { typeof(BaseItem).Assembly, typeof(DtoService).Assembly }.SelectMany(assembly => assembly.GetTypes())
            .FirstOrDefault(type => type.Name == name && typeof(BaseItem).IsAssignableFrom(type))
            ?? throw new InvalidOperationException("Missing native entity constructor: " + name);
        types[name] = type.FullName!;
        var item = (BaseItem)Activator.CreateInstance(type)!;
        item.Id = Guid.Parse("982f0000-0000-0000-0000-" + (index + 1).ToString("D12"));
        item.Name = definition.GetProperty("Name").GetString()!;
        item.Path = definition.GetProperty("Path").GetString()!;
        foreach (var propertyName in new[] { "Artists", "AlbumArtists" }) if (definition.TryGetProperty(propertyName, out var value))
        {
            var property = type.GetProperty(propertyName)!;
            property.SetValue(item, JsonSerializer.Deserialize(value.GetRawText(), property.PropertyType, json));
        }
        if (item is UserView view && definition.TryGetProperty("viewType", out var viewType))
        {
            var property = typeof(UserView).GetProperty("ViewType")!;
            property.SetValue(view, JsonSerializer.Deserialize(viewType.GetRawText(), property.PropertyType, json));
        }
        if (definition.TryGetProperty("images", out var images)) item.ImageInfos = images.EnumerateArray().Select(image => new ItemImageInfo {
            Type = Enum.Parse<ImageType>(image.GetProperty("type").GetString()!), Path = item.Path + "." + image.GetProperty("type").GetString() + ".png",
            DateModified = DateTime.Parse(image.GetProperty("stamp").GetString()!, null, System.Globalization.DateTimeStyles.RoundtripKind),
            BlurHash = image.GetProperty("hash").GetString(), Width = 10, Height = 20
        }).ToArray();
        items[definition.GetProperty("key").GetString()!] = item;
    }
    foreach (var definition in definitions)
    {
        var item = items[definition.GetProperty("key").GetString()!];
        foreach (var (key, propertyName) in new[] { ("parent", "ParentId"), ("owner", "OwnerId"), ("season", "SeasonId"), ("series", "SeriesId"), ("displayParent", "DisplayParentId") })
            if (definition.TryGetProperty(key, out var value)) item.GetType().GetProperty(propertyName)!.SetValue(item, items[value.GetString()!].Id);
    }
    Dictionary<string, MusicArtist[]> FindArtists(IReadOnlyList<string> names) => names.Distinct().ToDictionary(name => name,
        name => items.Values.OfType<MusicArtist>().Where(artist => artist.Name.GetCleanValue() == name.GetCleanValue()).ToArray());
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetItemById" => items.Values.FirstOrDefault(item => item.Id == (Guid)values![0]!),
        "GetArtists" => FindArtists((IReadOnlyList<string>)values![0]!),
        "GetArtist" => items.Values.OfType<MusicArtist>().Where(artist => artist.Name == (string)values![0]!).OrderBy(artist => artist.ParentId == Guid.Empty).FirstOrDefault(),
        "GetCollectionFolders" => sample.TryGetProperty("collectionFolders", out var libraries)
            ? libraries.EnumerateArray().Select(key => (Folder)items[key.GetString()!]).ToList() : new List<Folder>(),
        _ => null
    });
    BaseItem.LibraryManager = library; Field("_libraryManager", library);
    var options = new DtoOptions(false) { EnableUserData = false };
    if (sample.TryGetProperty("options", out var settings))
    {
        if (settings.TryGetProperty("enableImages", out var enabled)) options.EnableImages = enabled.GetBoolean();
        if (settings.TryGetProperty("limit", out var limit)) options.ImageTypeLimit = limit.GetInt32();
        if (settings.TryGetProperty("types", out var enabledTypes)) options.ImageTypes = enabledTypes.EnumerateArray().Select(value => Enum.Parse<ImageType>(value.GetString()!)).ToArray();
    }
    var target = items[sample.GetProperty("target").GetString()!];
    var owner = sample.TryGetProperty("owner", out var ownerKey) ? items[ownerKey.GetString()!] : null;
    var artistNames = target is IHasAlbumArtist albumArtist ? albumArtist.AlbumArtists.Where(name => !string.IsNullOrWhiteSpace(name)).ToArray() : [];
    var batch = sample.TryGetProperty("batch", out var batchEnabled) && batchEnabled.GetBoolean() ? FindArtists(artistNames) : null;
    var dto = new BaseItemDto { ImageBlurHashes = [] };
    typeof(DtoService).GetMethod("AttachBasicFields", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(service, [dto, target, owner, options, batch, null, null]);
    var serialized = JsonSerializer.SerializeToElement(dto, json);
    results.Add(new { name = sample.GetProperty("name").GetString(), images = serialized.EnumerateObject().Where(property => fields.Contains(property.Name)).ToDictionary(property => property.Name, property => property.Value.Clone()) });
}
var assemblies = new[] { typeof(DtoService).Assembly, typeof(BaseItem).Assembly, processorType.Assembly, Assembly.Load("jellyfin") }
    .Distinct().Select(assembly => new { assembly.FullName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualDtoExecution = true, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), types, results, assemblies,
    scope = "Actual DtoService.AttachBasicFields/AddInheritedImages and actual ImageProcessor cache tags. Entity parent/owner lookup, collection fallback and artist provider boundaries are controlled. Complete public image field graph only; not full DTO, EF artist lookup or media delivery."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
}
