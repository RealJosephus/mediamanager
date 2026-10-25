using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Emby.Server.Implementations.IO;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.LocalMetadata.Parsers;
using MediaBrowser.LocalMetadata.Savers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
var inputBytes = File.ReadAllBytes(args[0]);
var envelope = JsonDocument.Parse(inputBytes).RootElement;
var input = envelope.GetProperty("input");
var stateRoot = Path.GetFullPath(args[2]); Directory.CreateDirectory(stateRoot);
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_ProgramDataPath" => stateRoot, "get_DataPath" => Path.Combine(stateRoot, "data"),
    "get_InternalMetadataPath" => Path.Combine(stateRoot, "metadata"), _ => Stub.Default(method.ReturnType)
});
var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration { SaveMetadataHidden = false },
    _ => Stub.Default(method.ReturnType)
});
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.ConfigurationManager = configuration; BaseItem.FileSystem = fileSystem; BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol"
    ? MediaProtocol.File : Stub.Default(method.ReturnType));
var readers = Stub.Make<IProviderManager>((method, _) => method.Name == "GetExternalIdInfos"
    ? Array.Empty<ExternalIdInfo>() : Stub.Default(method.ReturnType));
var observations = new List<object>();
foreach (var repetition in new[] { "first", "repeat" }) {
    var results = new List<object>();
    foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
        var name = sample.GetProperty("name").GetString()!;
        var type = sample.GetProperty("type").GetString()!;
        var fault = sample.GetProperty("fault").GetString();
        var mode = sample.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() : "local";
        var filePlaylist = sample.TryGetProperty("filePlaylist", out var fileFlag) && fileFlag.GetBoolean();
        var root = Path.Combine(stateRoot, repetition, name); Directory.CreateDirectory(root);
        var itemPath = type == "Playlist" ? Path.Combine(root, "Road.m3u") : Path.Combine(root, "collection");
        if (filePlaylist) File.WriteAllText(itemPath, "#EXTM3U\n"); else Directory.CreateDirectory(itemPath);
        var target = type == "Playlist" ? PlaylistXmlSaver.GetSavePath(itemPath) : Path.Combine(itemPath, "collection.xml");
        var previous = Encoding.UTF8.GetBytes(input.GetProperty("previous").GetString()!);
        var existing = sample.GetProperty("existing").GetBoolean();
        if (existing) File.WriteAllBytes(target, previous);
        var pathValues = (sample.TryGetProperty("paths", out var entries) ? entries : input.GetProperty("defaultPaths"))
            .EnumerateArray().Select(value => value.ValueKind == JsonValueKind.Null ? null : value.GetString()).ToArray();
        var count = sample.TryGetProperty("count", out var countValue) ? countValue.GetInt32() : pathValues.Length;
        var members = Enumerable.Range(0, count).Select(index => new Movie {
            Id = Guid.Parse("cd310000-0000-0000-0001-" + (index + 1).ToString("x12")), Path = pathValues[index % pathValues.Length]
        }).ToArray();
        var effects = new List<string>(); var diagnostics = new List<object>();
        var library = Stub.Make<ILibraryManager>((method, _) => {
            if (method.Name == "GetLibraryOptions") return new LibraryOptions { MetadataSavers = ["Emby Xml", "Other"] };
            if (method.Name == "GetPeople") {
                if (fault == "people") throw new IOException("Controlled people lookup failure");
                return new List<PersonInfo>();
            }
            if (method.Name == "GetItemList") {
                if (fault is "links" or "unused-links") throw new IOException("Controlled member lookup failure");
                return members.Cast<BaseItem>().ToArray();
            }
            return Stub.Default(method.ReturnType);
        });
        BaseItem.LibraryManager = library;
        Folder item = type == "Playlist" ? new Playlist() : new BoxSet();
        item.Id = Guid.Parse("cd310000-0000-0000-0000-000000000001"); item.Path = itemPath;
        var fields = input.GetProperty("item");
        item.Name = fields.GetProperty("Name").GetString();
        item.Overview = fault == "xml-null" ? "Before \0 after" : fault == "xml-control" ? "Before \u0001 after" : fields.GetProperty("Overview").GetString();
        item.OfficialRating = fields.GetProperty("OfficialRating").GetString();
        item.DateCreated = DateTime.Parse(fields.GetProperty("DateCreated").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        if (item is IHasDisplayOrder displayOrder) displayOrder.DisplayOrder = fields.GetProperty("DisplayOrder").GetString();
        item.LinkedChildren = members.Select(member => new LinkedChild { ItemId = member.Id, Type = LinkedChildType.Manual }).ToArray();
        if (item is Playlist playlist) {
            playlist.OwnerUserId = Guid.Parse(fields.GetProperty("OwnerUserId").GetString()!);
            playlist.Shares = fields.GetProperty("Shares").EnumerateArray().Select(share =>
                new PlaylistUserPermissions(Guid.Parse(share.GetProperty("UserId").GetString()!), share.GetProperty("CanEdit").GetBoolean())).ToArray();
            playlist.PlaylistMediaType = Enum.Parse<MediaType>(fields.GetProperty("PlaylistMediaType").GetString()!);
        }
        BaseXmlSaver saver = type == "Playlist"
            ? new PlaylistXmlSaver(fileSystem, configuration, library, NullLogger<PlaylistXmlSaver>.Instance)
            : new BoxSetXmlSaver(fileSystem, configuration, library, NullLogger<BoxSetXmlSaver>.Instance);
        object? failure = null;
        try {
            if (mode == "manager") {
                var monitor = Stub.Make<ILibraryMonitor>((method, values) => {
                    if (method.Name == "ReportFileSystemChangeBeginning") effects.Add("begin");
                    if (method.Name == "ReportFileSystemChangeComplete") {
                        effects.Add("complete");
                        if ((bool)values![1]!) throw new InvalidOperationException("A failed saver must not request refresh.");
                    }
                    return Stub.Default(method.ReturnType);
                });
                using var memory = new MemoryCache(new MemoryCacheOptions());
                using var manager = new ProviderManager(null!, null!, configuration, monitor,
                    new CaptureLogger<ProviderManager>(effects, diagnostics), fileSystem, paths, library, null!, null!, memory, null!, null!);
                manager.AddParts([], [], [], [saver, new OtherSaver(effects)], [], []);
                await manager.SaveMetadataAsync(item, ItemUpdateType.MetadataEdit);
            } else await saver.SaveAsync(item, CancellationToken.None);
        } catch (Exception error) { failure = Error(error); }
        var bytes = File.Exists(target) ? File.ReadAllBytes(target) : null;
        // An exclusive reopen checks that each real native saver released the file.
        if (bytes is not null) using (File.Open(target, FileMode.Open, FileAccess.Read, FileShare.None)) { }
        results.Add(new { name, type, fault, saveFailed = failure is not null, failure, effects, diagnostics,
            fileExists = bytes is not null, changed = bytes is not null && (!existing || !bytes.SequenceEqual(previous)),
            file = bytes is null ? null : Raw(bytes), relativePath = Path.GetRelativePath(root, target).Replace('\\', '/'),
            reader = bytes is null ? null : Read(type, target, readers) });
    }
    observations.Add(new { repetition, results });
}
var candidateReads = new List<object>();
foreach (var candidate in envelope.GetProperty("candidate").EnumerateArray()) {
    var filename = candidate.GetProperty("filename").GetString()!;
    var bytes = File.ReadAllBytes(filename);
    var expected = candidate.GetProperty("file");
    if (Hash(bytes) != expected.GetProperty("sha256").GetString() || bytes.Length != expected.GetProperty("bytes").GetInt32())
        throw new InvalidDataException("The declared Node output changed before actual Native consumption.");
    candidateReads.Add(new { name = candidate.GetProperty("name").GetString(), file = Raw(bytes),
        reader = Read(candidate.GetProperty("type").GetString()!, filename, readers) });
}
var assemblyNames = new HashSet<string>(StringComparer.Ordinal) {
    "Emby.Server.Implementations", "MediaBrowser.Controller", "MediaBrowser.LocalMetadata", "MediaBrowser.Model", "MediaBrowser.Providers", "Jellyfin.Data"
};
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => assemblyNames.Contains(assembly.GetName().Name!))
    .Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { schemaVersion = 1, actualExecution = true,
    inputSha256 = Hash(inputBytes), actualXmlSavers = true, actualXmlParsers = true, actualProviderManager = true,
    repositoryInputsControlled = true, databaseOpened = false, portOpened = false, observations, candidateReads, assemblies,
    phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));

static object Read(string type, string filename, IProviderManager manager) {
    object? error = null; object projected;
    if (type == "Playlist") {
        var result = new MetadataResult<Playlist> { Item = new Playlist() };
        try { new PlaylistXmlParser(NullLogger<PlaylistXmlParser>.Instance, manager).Fetch(result, filename, CancellationToken.None); }
        catch (Exception failure) { error = Error(failure); }
        projected = Project(result.Item, result.People);
    } else {
        var result = new MetadataResult<BoxSet> { Item = new BoxSet() };
        try { new BoxSetXmlParser(NullLogger<BoxSetXmlParser>.Instance, manager).Fetch(result, filename, CancellationToken.None); }
        catch (Exception failure) { error = Error(failure); }
        projected = Project(result.Item, result.People);
    }
    bool validXml = true;
    try { using var reader = XmlReader.Create(filename); while (reader.Read()) { } } catch { validXml = false; }
    return new { failed = error is not null, error, validXml, result = projected };
}
static object Project(Folder item, IReadOnlyList<PersonInfo> people) {
    var playlist = item as Playlist;
    return new { item.Name, item.Overview, item.OfficialRating, dateCreated = item.DateCreated.ToString("O"), item.IsLocked,
        displayOrder = (item as IHasDisplayOrder)?.DisplayOrder,
#pragma warning disable CS0618
        links = item.LinkedChildren.Select(link => new { path = link.Path, libraryItemId = link.LibraryItemId }),
#pragma warning restore CS0618
        people = people.Select(person => new { person.Name, person.Role, type = person.Type.ToString() }),
        ownerUserId = playlist?.OwnerUserId.ToString("N"),
        shares = playlist?.Shares.Select(share => new { userId = share.UserId.ToString("N"), share.CanEdit }),
        playlistMediaType = playlist?.PlaylistMediaType.ToString() };
}
static object Raw(byte[] bytes) => new { bytes = bytes.Length, sha256 = Hash(bytes), base64 = Convert.ToBase64String(bytes) };
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static object Error(Exception error) => new { name = error.GetType().Name, error.Message };
public class OtherSaver(List<string> effects) : IMetadataSaver {
    public string Name => "Other";
    public bool IsEnabledFor(BaseItem item, ItemUpdateType type) => true;
    public Task SaveAsync(BaseItem item, CancellationToken token) { effects.Add("other"); return Task.CompletedTask; }
}
public class CaptureLogger<T>(List<string> effects, List<object> diagnostics) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        if (level < LogLevel.Error) return;
        effects.Add("logged-failure"); diagnostics.Add(new { message = formatter(state, error), error = error?.GetType().Name });
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
