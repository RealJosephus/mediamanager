// Validation only: real pinned parsers/provider/metadata merge; controlled library lookup.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Playlists;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Providers.Playlists;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using UtfUnknown;
using PlaylistsNET.Content;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var inputBytes = File.ReadAllBytes(args[0]);
var document = JsonDocument.Parse(inputBytes).RootElement;
var input = document.GetProperty("input");
var output = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
var results = new List<object>();
var merges = new List<object>();
var inputFiles = new List<object>();
var writers = new List<object>();
using var modelContext = new SqlFactory().CreateDbContext();
var properties = modelContext.Model.FindEntityType(typeof(BaseItemEntity))!.GetProperties().ToArray();
if (properties.Length != 72) throw new InvalidOperationException("Expected 72 native mapped properties.");
var mergeIndex = 0;

foreach (var sample in input.GetProperty("providerCases").EnumerateArray()
    .Concat(document.GetProperty("candidateWriters").EnumerateArray()))
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(stateRoot, name);
    var media = Path.Combine(root, "media");
    Directory.CreateDirectory(media);
    var fileNames = input.GetProperty("files").EnumerateArray().Select(value => value.GetString()!).ToArray();
    var absentIds = sample.TryGetProperty("missingFromDatabase", out var missing)
        ? missing.EnumerateArray().Select(value => value.GetString()!).ToHashSet(StringComparer.Ordinal) : [];
    var items = new List<BaseItem>();
    for (var index = 0; index < fileNames.Length; index++)
    {
        var filename = Path.Combine(media, fileNames[index].Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        File.WriteAllBytes(filename, Encoding.UTF8.GetBytes("neutral media file"));
        if (!absentIds.Contains(fileNames[index])) items.Add(new Audio
        {
            Id = Identifier(index + 1), Name = Path.GetFileNameWithoutExtension(filename), Path = filename,
            DateCreated = new DateTime(2026, 10, 10, 0, 0, index, DateTimeKind.Utc)
        });
    }
    var paths = Paths(root);
    var configuration = Configuration(paths);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem;
    BaseItem.ConfigurationManager = configuration;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var calls = new List<object>();
    var collectionInput = sample.TryGetProperty("collections", out var declared) ? declared
        : JsonDocument.Parse("[{\"type\":\"music\",\"roots\":[\"Library\"]}]").RootElement;
    var folders = collectionInput.EnumerateArray().Select(value => (BaseItem)new CollectionFolder
    {
        CollectionType = value.GetProperty("type").ValueKind == JsonValueKind.Null ? null
            : Enum.Parse<CollectionType>(value.GetProperty("type").GetString()!),
        PhysicalLocationsList = value.GetProperty("roots").EnumerateArray()
            .Select(value => Path.Combine(media, value.GetString()!.Replace('/', Path.DirectorySeparatorChar))).ToArray()
    }).ToArray();
    var userRoot = new UserRootFolder { Children = folders };
    var manager = Stub.Make<ILibraryManager>((method, values) =>
    {
        if (method.Name == "GetItemList")
        {
            var query = (InternalItemsQuery)values![0]!;
            return items.Where(item => query.ItemIds.Contains(item.Id)).Reverse().ToArray();
        }
        if (method.Name == "GetItemById") return items.FirstOrDefault(item => item.Id.Equals(values![0]));
        if (method.Name == "GetUserRootFolder") { calls.Add(new { method = "GetUserRootFolder" }); return userRoot; }
        if (method.Name == "FindByPath")
        {
            var identity = (string)values![0]!;
            calls.Add(new { method = "FindByPath", path = Normalize(identity, root), isFolder = values[1] });
            return items.OrderByDescending(item => item.DateCreated).FirstOrDefault(item => item.Path == identity);
        }
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        return Stub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = manager;
    var relative = sample.GetProperty("path").GetString();
    var target = relative is null ? null : Path.Combine(media, relative.Replace('/', Path.DirectorySeparatorChar));
    var kind = sample.TryGetProperty("kind", out var specifiedKind) ? specifiedKind.GetString() : "file";
    object? detection = null;
    if (target is not null && kind == "directory") Directory.CreateDirectory(target);
    else if (target is not null && kind != "absent")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        byte[] bytes;
        if (sample.TryGetProperty("bytes", out var encodedBytes))
        {
            bytes = Convert.FromBase64String(encodedBytes.GetString()!);
        }
        else
        {
            var encodingName = sample.TryGetProperty("encoding", out var declaredEncoding) ? declaredEncoding.GetString()! : "utf-8";
            var encoding = encodingName switch
            {
                "utf-8" => new UTF8Encoding(false), "utf-8-bom" => new UTF8Encoding(true),
                _ => Encoding.GetEncoding(encodingName)
            };
            var content = sample.GetProperty("content").GetString()!;
            if (content.Contains("$MEDIA", StringComparison.Ordinal))
            {
                content = content.Replace('/', Path.DirectorySeparatorChar).Replace("$MEDIA", media, StringComparison.Ordinal);
            }
            bytes = encoding.GetPreamble().Concat(encoding.GetBytes(content)).ToArray();
        }
        File.WriteAllBytes(target, bytes);
        var detected = CharsetDetector.DetectFromBytes(bytes).Detected;
        detection = new { encoding = detected?.Encoding?.WebName, confidence = detected?.Confidence,
            preferredEncoding = detected?.Encoding is not null && detected.Confidence >= 0.5f ? detected.Encoding.WebName : "utf-8" };
        inputFiles.Add(new { name, path = target, sha256 = Hash(bytes), bytes = bytes.Length,
            base64 = Convert.ToBase64String(bytes) });
    }
    object? projection = null;
    object? error = null;
    try
    {
        var provider = new PlaylistItemsProvider(NullLogger<PlaylistItemsProvider>.Instance, manager, fileSystem);
        var result = await provider.GetMetadata(new ItemInfo(new Playlist { Path = target }), new DirectoryService(fileSystem), new CancellationToken(true));
        projection = new { result.HasMetadata, item = Project(result.Item, root), stored = Map(result.Item, root),
            diagnosticProvider = new { provider.Name, provider.Order, completedWithCancelledToken = true } };
        if (sample.TryGetProperty("currentWriter", out var currentWriter) && currentWriter.GetBoolean())
        {
            foreach (var child in input.GetProperty("writerChildren").EnumerateArray())
            {
                var filename = Path.Combine(media, child.GetProperty("Path").GetString()!.Replace('/', Path.DirectorySeparatorChar));
                var item = (Audio)items.Single(item => item.Path == filename);
                item.Name = child.GetProperty("Name").GetString();
                item.Album = child.GetProperty("Album").GetString();
                item.AlbumArtists = child.GetProperty("AlbumArtists").EnumerateArray().Select(value => value.GetString()!).ToArray();
                item.Artists = child.GetProperty("Artists").EnumerateArray().Select(value => value.GetString()!).ToArray();
                item.RunTimeTicks = long.Parse(child.GetProperty("RunTimeTicks").GetString()!, CultureInfo.InvariantCulture);
            }
            var before = File.ReadAllBytes(target!);
            var beforeEntries = ReadEntries(target!);
            new PlaylistManager(manager, null!, null!, NullLogger<PlaylistManager>.Instance, null!, null!, null!)
                .SavePlaylistFile(result.Item);
            var after = File.ReadAllBytes(target!);
            var reread = await provider.GetMetadata(new ItemInfo(new Playlist { Path = target }),
                new DirectoryService(fileSystem), CancellationToken.None);
            writers.Add(new { name, root, filename = target,
                before = new { bytes = before.Length, sha256 = Hash(before), base64 = Convert.ToBase64String(before) },
                after = new { bytes = after.Length, sha256 = Hash(after), base64 = Convert.ToBase64String(after) },
                beforeEntries, afterEntries = ReadEntries(target!),
                reread = new { reread.HasMetadata, item = Project(reread.Item, root), stored = Map(reread.Item, root) } });
        }
    }
    catch (Exception failure) { error = new { type = failure.GetType().Name, message = Normalize(failure.Message, root) }; }
    results.Add(new { name, root, filename = target, detection, result = projection, error, calls });
}

foreach (var sample in input.GetProperty("mergeCases").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(stateRoot, name);
    var paths = Paths(root);
    var configuration = Configuration(paths);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem;
    BaseItem.ConfigurationManager = configuration;
    var manager = Stub.Make<ILibraryManager>((method, _) => method.Name == "GetLibraryOptions" ? new LibraryOptions() : Stub.Default(method.ReturnType));
    BaseItem.LibraryManager = manager;
    var source = new MetadataResult<Playlist> { Item = PlaylistFrom(sample.GetProperty("source"), root) };
    var target = new MetadataResult<Playlist> { Item = PlaylistFrom(sample.GetProperty("target"), root) };
    target.Item.Id = Guid.Parse($"17000000-0000-0000-0000-{++mergeIndex:D12}");
    var before = Project(target.Item, root);
    var service = new PlaylistMetadataService(configuration, NullLogger<PlaylistMetadataService>.Instance,
        null!, fileSystem, manager, null!, null!);
    var method = typeof(PlaylistMetadataService).GetMethod("MergeData", BindingFlags.Instance | BindingFlags.NonPublic)!;
    method.Invoke(service, [source, target, Array.Empty<MetadataField>(),
        sample.TryGetProperty("replaceData", out var replace) && replace.GetBoolean(),
        !sample.TryGetProperty("mergeMetadataSettings", out var settings) || settings.GetBoolean()]);
    merges.Add(new { name, source = Project(source.Item, root), before, after = Project(target.Item, root), stored = Map(target.Item, root) });
}
var assemblies = new[] { typeof(PlaylistItemsProvider).Assembly, typeof(Playlist).Assembly,
    typeof(BaseItemMapper).Assembly, typeof(PlaylistManager).Assembly, typeof(CharsetDetector).Assembly,
    typeof(WplContent).Assembly }.Distinct()
    .OrderBy(assembly => assembly.GetName().Name, StringComparer.Ordinal).Select(assembly => new
    { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
File.WriteAllText(output, JsonSerializer.Serialize(new
{
    actualExecution = true, inputSha256 = Hash(inputBytes), results, merges, writers, inputFiles, assemblies,
    boundary = "Current designated PlaylistItemsProvider, PlaylistMetadataService.MergeData, BaseItemMapper and PlaylistManager.SavePlaylistFile over actual files. Node-written bytes are consumed by Native and its rewritten files are consumed by Node. Library path and item lookups are controlled; this is component evidence, not a Native repository, SaveItems transaction, HTTP instance, full-library exchange or release acceptance."
}, json) + "\n");

object ReadEntries(string filename)
{
    using var stream = File.OpenRead(filename);
    return Path.GetExtension(filename).ToLowerInvariant() switch
    {
        ".wpl" => JsonSerializer.SerializeToElement(new WplContent().GetFromStream(stream).PlaylistEntries),
        ".zpl" => JsonSerializer.SerializeToElement(new ZplContent().GetFromStream(stream).PlaylistEntries),
        ".pls" => JsonSerializer.SerializeToElement(new PlsContent().GetFromStream(stream, Encoding.UTF8).PlaylistEntries),
        _ => JsonSerializer.SerializeToElement(new M3uContent().GetFromStream(stream, Encoding.UTF8).PlaylistEntries)
    };
}

string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
Guid Identifier(int index) => Guid.Parse($"16000000-0000-0000-0000-{index:D12}");
string Normalize(string value, string root) => value.Replace(root, "$STATE", StringComparison.Ordinal).Replace('\\', '/');
IServerApplicationPaths Paths(string root) => Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch
{
    "get_ProgramDataPath" => root, "get_DataPath" => Path.Combine(root, "data"),
    "get_InternalMetadataPath" => Path.Combine(root, "metadata"), "get_TempDirectory" => Path.Combine(root, "temp"),
    _ => Stub.Default(method.ReturnType)
});
IServerConfigurationManager Configuration(IServerApplicationPaths paths) => Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
{
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration(),
    _ => Stub.Default(method.ReturnType)
});
Playlist PlaylistFrom(JsonElement value, string root) => new()
{
    Path = value.TryGetProperty("path", out var path) ? path.GetString()?.Replace("$STATE", root, StringComparison.Ordinal)
        .Replace("$MEDIA", Path.Combine(root, "media"), StringComparison.Ordinal).Replace('/', Path.DirectorySeparatorChar) : null,
    PlaylistMediaType = value.TryGetProperty("mediaType", out var mediaType) ? Enum.Parse<MediaType>(mediaType.GetString()!) : MediaType.Unknown,
    OwnerUserId = value.TryGetProperty("owner", out var owner) ? Identifier(owner.GetInt32()) : Guid.Empty,
    OpenAccess = value.TryGetProperty("open", out var open) && open.GetBoolean(),
    LinkedChildren = value.TryGetProperty("links", out var links) ? links.EnumerateArray().Select(link => new LinkedChild
    {
        ItemId = link.TryGetProperty("id", out var id) ? id.GetInt32() == 0 ? Guid.Empty : Identifier(id.GetInt32()) : null,
        Path = link.TryGetProperty("path", out var path) ? path.GetString() : null, Type = MediaBrowser.Controller.Entities.LinkedChildType.Manual
    }).ToArray() : [],
    Shares = value.TryGetProperty("shares", out var shares) ? shares.EnumerateArray().Select(share => new PlaylistUserPermissions(
        Identifier(share.GetProperty("user").GetInt32()), share.GetProperty("edit").GetBoolean())).ToArray() : []
};
object Project(Playlist item, string root) => new
{
    item.Name, path = item.Path is null ? null : Normalize(item.Path, root), item.IsFolder,
    mediaType = item.PlaylistMediaType.ToString(), owner = item.OwnerUserId.ToString("D"), item.OpenAccess,
    links = item.LinkedChildren.Select(child => new { id = child.ItemId?.ToString("D"), path = child.Path, type = child.Type.ToString() }),
    shares = item.Shares.Select(share => new { user = share.UserId.ToString("D"), edit = share.CanEdit })
};
object Map(Playlist item, string root)
{
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var row = BaseItemMapper.Map(item, appHost);
    var dataText = row.Data?.Replace(root.Replace("\\", "\\\\", StringComparison.Ordinal), "$STATE", StringComparison.Ordinal).Replace(root, "$STATE", StringComparison.Ordinal);
    var columns = properties.ToDictionary(property => property.Name, property =>
    {
        var value = property.PropertyInfo!.GetValue(row);
        if (property.Name == "Data") return dataText is null ? null : (object?)JsonNode.Parse(dataText);
        return value switch
        {
            Guid id => id.ToString("D"), DateTime date => date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            string text => Normalize(text, root), _ => value
        };
    });
    return new { columnCount = properties.Length, columns, dataText, data = dataText is null ? null : JsonNode.Parse(dataText) };
}
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite("Data Source=:memory:").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
