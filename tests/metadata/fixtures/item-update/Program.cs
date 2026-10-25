// Executes the pinned ItemUpdateController and its actual JSON converters.
// Library persistence and provider callbacks are explicit recording boundaries.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Api.Controllers;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Emby.Server.Implementations.Localization;
using Microsoft.Extensions.Logging.Abstractions;

var options = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true, WriteIndented = true };
var definitions = new Dictionary<string, object>();
object Rule(Type type) {
    var underlying = Nullable.GetUnderlyingType(type);
    var actual = underlying ?? type;
    var nullable = underlying is not null || !actual.IsValueType;
    if (actual.IsEnum) return new { type = "enum", nullable, clrType = actual.FullName, values = Enum.GetNames(actual).ToDictionary(name => name, name => Convert.ToInt32(Enum.Parse(actual, name))) };
    var kind = actual == typeof(string) ? "string" : actual == typeof(bool) ? "boolean" : actual == typeof(int) ? "integer"
        : actual == typeof(long) ? "long" : actual == typeof(float) ? "float" : actual == typeof(double) ? "double"
        : actual == typeof(DateTime) ? "datetime" : actual == typeof(Guid) ? "guid" : null;
    if (kind is not null) return new { type = kind, nullable, clrType = actual.FullName };
    if (actual.IsGenericType && actual.GetGenericTypeDefinition() == typeof(Dictionary<,>)) {
        var types = actual.GetGenericArguments();
        return new { type = "dictionary", nullable, clrType = actual.FullName, key = Rule(types[0]), item = Rule(types[1]) };
    }
    var sequence = actual.IsArray ? actual.GetElementType() : actual.GetInterfaces().Append(actual)
        .FirstOrDefault(candidate => candidate.IsGenericType && candidate.GetGenericTypeDefinition() == typeof(IEnumerable<>))?.GetGenericArguments()[0];
    if (sequence is not null) return new { type = "array", nullable, clrType = actual.FullName, item = Rule(sequence) };
    if (!definitions.ContainsKey(actual.FullName!)) {
        definitions[actual.FullName!] = null!;
        var instance = actual.GetConstructor(Type.EmptyTypes) is not null ? Activator.CreateInstance(actual) : RuntimeHelpers.GetUninitializedObject(actual);
        var properties = actual.GetProperties().Where(prop => prop.CanWrite && prop.GetCustomAttribute<JsonIgnoreAttribute>()?.Condition != JsonIgnoreCondition.Always).ToArray();
        definitions[actual.FullName!] = new { fields = properties.ToDictionary(prop => prop.Name, prop => Rule(prop.PropertyType)),
            defaults = JsonSerializer.SerializeToElement(instance, actual, options), required = Array.Empty<string>() };
    }
    return new { type = "object", nullable, clrType = actual.FullName, reference = actual.FullName };
}
if (args[0] == "schema") {
    var item = Rule(typeof(BaseItemDto));
    File.WriteAllText(args[1], JsonSerializer.Serialize(new { item, definitions }, options));
    return;
}

var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
await localization.LoadAll();
BaseItem.LocalizationManager = localization;
BaseItem.ConfigurationManager = configuration;
var results = new List<object>();
foreach (var entry in JsonDocument.Parse(File.ReadAllText(args[0])).RootElement.EnumerateArray()) {
    var name = entry.GetProperty("name").GetString();
    var type = entry.GetProperty("type").GetString();
    BaseItem item = type switch { "Movie" => new Movie(), "Episode" => new Episode(), "Season" => new Season(), "Series" => new Series(),
        "Audio" => new Audio(), "MusicAlbum" => new MusicAlbum(), "MusicVideo" => new MusicVideo(), "Person" => new Person(), _ => new Folder() };
    item.Id = Guid.Parse("81000000-0000-0000-0000-000000000001");
    item.Name = "Stored title"; item.ForcedSortName = "Old sort"; item.OriginalTitle = "Original"; item.OriginalLanguage = "fr";
    item.Overview = "Stored overview"; item.Genres = ["Old genre"]; item.Tags = ["Old", "keep"]; item.Studios = ["Old studio"];
    item.ProductionLocations = ["Old country"]; item.ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Custom"] = "old" };
    item.IsLocked = true; item.LockedFields = [MediaBrowser.Model.Entities.MetadataField.Name];
    item.DateCreated = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc); item.RunTimeTicks = 9007199254740993;
    item.Tagline = "Old tagline";
    if (item is Folder folder) folder.Children = [];
    if (item is Series series) { series.AirDays = [DayOfWeek.Monday]; series.AirTime = "Old time"; series.DisplayOrder = "Aired"; }
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var recording = (LibraryProxy)(object)library; recording.Item = item;
    var descendants = new List<BaseItem>();
    if (entry.TryGetProperty("children", out var childInputs) && item is Folder tree) {
        BaseItem Build(JsonElement childInput, Folder parent) {
            var kind = childInput.GetProperty("type").GetString();
            BaseItem child = kind switch { "Season" => new Season(), "Episode" => new Episode(), "Audio" => new Audio(), "Folder" => new Folder(), _ => throw new NotSupportedException(kind) };
            child.Id = Guid.Parse("81000000-0000-0000-0000-" + (descendants.Count + 2).ToString("D12"));
            child.Name = childInput.GetProperty("name").GetString(); child.ParentId = parent.Id;
            child.Tags = childInput.GetProperty("tags").EnumerateArray().Select(tag => tag.GetString()!).ToArray();
            child.IsLocked = childInput.TryGetProperty("locked", out var locked) && locked.GetBoolean();
            child.LockedFields = childInput.TryGetProperty("lockedFields", out var fields) ? fields.EnumerateArray().Select(field => Enum.Parse<MediaBrowser.Model.Entities.MetadataField>(field.GetString()!)).ToArray() : [];
            child.OfficialRating = "R"; child.CustomRating = "Old custom";
            descendants.Add(child);
            if (child is Folder childFolder) childFolder.Children = childInput.TryGetProperty("children", out var nested)
                ? nested.EnumerateArray().Select(nestedChild => Build(nestedChild, childFolder)).ToArray() : [];
            return child;
        }
        tree.Children = childInputs.EnumerateArray().Select(childInput => Build(childInput, tree)).ToArray();
    }
    recording.Items = descendants.Prepend(item).ToDictionary(child => child.Id);
    recording.Capture = Snapshot;
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    BaseItem.LibraryManager = library;
    var controller = new ItemUpdateController(null!, library, providers, BaseItem.LocalizationManager, BaseItem.ConfigurationManager) {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
    };
    try {
        var request = JsonSerializer.Deserialize<BaseItemDto>(entry.GetProperty("json").GetString()!, options)!;
        await controller.UpdateItem(item.Id, request);
        results.Add(new { name, value = Snapshot(item), saves = recording.Saves, people = recording.People,
            queued = ((ProviderProxy)(object)providers).Queued, writes = descendants.Count > 0 ? recording.Writes : null,
            children = descendants.Count > 0 ? descendants.Select(Snapshot).ToArray() : null });
    } catch (JsonException error) { results.Add(new { name, error = error.GetType().Name, error.Message, error.Path, error.LineNumber, error.BytePositionInLine }); }
    catch (Exception error) { results.Add(new { name, error = error.GetType().Name, error.Message }); }
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results,
    sourceBoundary = "Unmodified ItemUpdateController.UpdateItem, native BaseItemDto JSON converters, physical Children, recursive lock propagation and OnMetadataChanged; ILibraryManager repository writes and IProviderManager.QueueRefresh are recorded callbacks, not real database or NFO evidence. Children are supplied explicitly by scenarios; alternate versions are empty.",
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    assemblies = new[] { typeof(ItemUpdateController).Assembly, typeof(BaseItem).Assembly, typeof(object).Assembly }.Select(assembly => new {
        path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }),
    candidateVerified = false }, options));

static object Snapshot(BaseItem item) => new {
    item.Name, item.ForcedSortName, item.OriginalTitle, item.OriginalLanguage, item.CriticRating, item.CommunityRating,
    item.IndexNumber, item.ParentIndexNumber, item.Overview, item.Genres, item.Tagline, item.Studios, item.DateCreated,
    item.EndDate, item.PremiereDate, item.ProductionYear, item.OfficialRating, item.CustomRating, item.Tags, item.ProductionLocations,
    item.PreferredMetadataCountryCode, item.PreferredMetadataLanguage, item.IsLocked, item.LockedFields, item.RunTimeTicks, item.ProviderIds,
    DisplayOrder = (item as IHasDisplayOrder)?.DisplayOrder, AspectRatio = (item as IHasAspectRatio)?.AspectRatio,
    Video3DFormat = (item as Video)?.Video3DFormat, Album = (item as Audio)?.Album ?? (item as MusicVideo)?.Album,
    Artists = (item as IHasArtist)?.Artists, AlbumArtists = (item as IHasAlbumArtist)?.AlbumArtists,
    Status = (item as Series)?.Status, AirDays = (item as Series)?.AirDays, AirTime = (item as Series)?.AirTime,
    SeriesName = (item as IHasSeries)?.SeriesName, AirsAfterSeasonNumber = (item as Episode)?.AirsAfterSeasonNumber,
    AirsBeforeSeasonNumber = (item as Episode)?.AirsBeforeSeasonNumber, AirsBeforeEpisodeNumber = (item as Episode)?.AirsBeforeEpisodeNumber
};
public class LibraryProxy : DispatchProxy {
    public BaseItem Item = null!;
    public Dictionary<Guid, BaseItem> Items = [];
    public Func<BaseItem, object> Capture = null!;
    public List<object> Saves = [];
    public List<object> Writes = [];
    public List<object> People = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetItemById") return Items.GetValueOrDefault((Guid)args![0]!);
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "UpdateItemAsync") { Saves.Add(new { Id = ((BaseItem)args![0]!).Id.ToString("N"), reason = args[2]!.ToString() }); Writes.Add(Capture((BaseItem)args[0]!)); return Task.CompletedTask; }
        if (method.Name == "UpdatePeople") { People.AddRange(((List<PersonInfo>)args![1]!).Select(person => new { person.Name, person.Role, person.Type })); return null; }
        throw new NotSupportedException(method.Name);
    }
}
public class ProviderProxy : DispatchProxy {
    public int Queued;
    protected override object? Invoke(MethodInfo? method, object?[]? args) { if (method!.Name == "QueueRefresh") { Queued++; return null; } throw new NotSupportedException(method.Name); }
}
public class LocalizationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetRatingScore" ? null : throw new NotSupportedException(method.Name);
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration" ? new ServerConfiguration()
        : method.Name is "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" ? null : throw new NotSupportedException(method.Name);
}
