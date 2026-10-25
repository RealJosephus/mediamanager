// Validation only: actual pinned PlaylistManager and PlaylistsNET over neutral files.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Playlists;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Playlists;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var paths = PlaylistFileStub.Make<IServerApplicationPaths>((method, _) => method.Name switch
{
    "get_ProgramDataPath" => stateRoot, "get_DataPath" => Path.Combine(stateRoot, "data"),
    _ => PlaylistFileStub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = PlaylistFileStub.Make<IServerConfigurationManager>((method, _) => method.Name switch
{
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration(),
    _ => PlaylistFileStub.Default(method.ReturnType)
});
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var user = new User("playlist-oracle", "controlled", "controlled") { Id = Guid.Empty };
var initialBytes = Convert.FromBase64String("//5vAGwAZAA=");
Guid Id(int number) => Guid.Parse($"18000000-0000-0000-0000-{number:000000000000}");
string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var property)
    && property.ValueKind != JsonValueKind.Null ? property.GetString() : null;
string? Inflate(string? value, string root) => value?.Replace("$STATE", root).Replace('/', Path.DirectorySeparatorChar);
object Error(Exception error)
{
    while (error is TargetInvocationException && error.InnerException is not null) error = error.InnerException;
    return new { type = error.GetType().Name, parameter = (error as ArgumentException)?.ParamName };
}
BaseItem[] Children(string root) => input.GetProperty("children").EnumerateArray().Select((sample, index) =>
{
    BaseItem child = Text(sample, "type") switch
    {
        "Audio" => new Audio(), "AudioBook" => new AudioBook(), "MusicVideo" => new MusicVideo(),
        "Movie" => new MediaBrowser.Controller.Entities.Movies.Movie(), _ => throw new Exception("Unknown child type")
    };
    child.Id = Id(index + 1);
    child.Path = Text(sample, "path")?.StartsWith("$STATE") == true ? Inflate(Text(sample, "path"), root) : Text(sample, "path");
    child.Name = Text(sample, "name");
    child.Album = Text(sample, "album");
    child.RunTimeTicks = Text(sample, "ticks") is string ticks ? long.Parse(ticks, CultureInfo.InvariantCulture) : null;
    if (child is IHasAlbumArtist album && sample.TryGetProperty("albumArtists", out var albumArtists))
        album.AlbumArtists = albumArtists.ValueKind == JsonValueKind.Null ? null! : albumArtists.EnumerateArray().Select(v => v.GetString()!).ToArray();
    if (child is IHasArtist artist && sample.TryGetProperty("artists", out var artists))
        artist.Artists = artists.ValueKind == JsonValueKind.Null ? null! : artists.EnumerateArray().Select(v => v.GetString()!).ToArray();
    return child;
}).ToArray();
LinkedChild[] Links(IEnumerable<int> numbers) => numbers.Select(number => new LinkedChild { ItemId = Id(number) }).ToArray();
object Snapshot(Playlist playlist) => new { playlist.Name, links = playlist.LinkedChildren.Select(link => link.ItemId).ToArray() };
byte[]? Bytes(string filename) => File.Exists(filename) ? File.ReadAllBytes(filename) : null;
var writes = new List<object>();
foreach (var sample in input.GetProperty("writes").EnumerateArray())
{
    var name = Text(sample, "name")!;
    var root = Path.Combine(stateRoot, name);
    var directory = Path.Combine(root, "lists");
    Directory.CreateDirectory(directory);
    var filename = Path.Combine(directory, "mix" + Text(sample, "extension"));
    File.WriteAllBytes(filename, initialBytes);
    var children = Children(root);
    var calls = new List<object>();
    var library = PlaylistFileStub.Make<ILibraryManager>((method, values) =>
    {
        if (method.Name == "GetItemList")
        {
            var query = (InternalItemsQuery)values![0]!;
            calls.Add(new { method = method.Name, ids = query.ItemIds });
            return children.Where(child => query.ItemIds.Contains(child.Id)).Reverse().ToArray();
        }
        if (method.Name == "GetItemById") return children.FirstOrDefault(child => child.Id.Equals(values![0]));
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        return PlaylistFileStub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = library;
    var playlist = new Playlist { Path = filename, Name = "Playlist title is ignored" };
    playlist.LinkedChildren = sample.GetProperty("links").ValueKind == JsonValueKind.Null ? null!
        : Links(sample.GetProperty("links").EnumerateArray().Select(v => v.GetInt32()));
    var manager = new PlaylistManager(library, null!, null!, NullLogger<PlaylistManager>.Instance, null!, null!, null!);
    object? error = null;
    try { manager.SavePlaylistFile(playlist); } catch (Exception caught) { error = Error(caught); }
    writes.Add(new { name, error, bytes = Convert.ToBase64String(File.ReadAllBytes(filename)), calls });
}
var pathCases = new List<object>();
var normalize = typeof(PlaylistManager).GetMethod("NormalizeItemPath", BindingFlags.Static | BindingFlags.NonPublic)!;
foreach (var sample in input.GetProperty("pathCases").EnumerateArray())
{
    object? error = null;
    string? result = null;
    try { result = (string?)normalize.Invoke(null, [Text(sample, "playlistPath"), Text(sample, "itemPath")]); }
    catch (Exception caught) { error = Error(caught); }
    pathCases.Add(new { name = Text(sample, "name"), error, result });
}
var operations = new List<object>();
foreach (var sample in input.GetProperty("operations").EnumerateArray())
{
    var name = Text(sample, "name")!;
    var root = Path.Combine(stateRoot, name);
    var directory = Path.Combine(root, "lists");
    Directory.CreateDirectory(directory);
    var filename = Path.Combine(directory, sample.TryGetProperty("missingParent", out var absent) && absent.GetBoolean()
        ? "missing/mix.m3u" : "mix.m3u");
    if (!filename.Contains("missing")) File.WriteAllBytes(filename, initialBytes);
    var children = Children(root);
    var playlist = new Playlist { Id = Id(100), Path = filename, Name = "Original", LinkedChildren = Links([1, 2, 1]) };
    var calls = new List<object>();
    object repository = Snapshot(playlist);
    var repositoryNumber = 0;
    var library = PlaylistFileStub.Make<ILibraryManager>((method, values) =>
    {
        if (method.Name == "GetItemById") return Id(100).Equals(values![0]) ? playlist
            : children.FirstOrDefault(child => child.Id.Equals(values![0]));
        if (method.Name == "GetItemList")
        {
            var query = (InternalItemsQuery)values![0]!;
            return query.ItemIds.Length == 0 ? new BaseItem[] { playlist }
                : children.Where(child => query.ItemIds.Contains(child.Id)).ToArray();
        }
        if (method.Name == "UpdateItemAsync")
        {
            calls.Add(new { method = "repository", item = Snapshot(playlist), bytes = Bytes(filename),
                reason = values![2], cancelled = ((CancellationToken)values[3]!).IsCancellationRequested });
            if (sample.TryGetProperty("repositoryFailure", out var fail) && fail.GetBoolean())
                return Task.FromException(new IOException("Controlled repository failure"));
            repository = Snapshot(playlist);
            repositoryNumber++;
            if (sample.TryGetProperty("fileReadOnlyOnRepository", out var readOnly) && readOnly.GetInt32() == repositoryNumber)
                File.SetAttributes(filename, FileAttributes.ReadOnly);
            return Task.CompletedTask;
        }
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        return PlaylistFileStub.Default(method.ReturnType);
    });
    var users = PlaylistFileStub.Make<IUserManager>((method, values) => method.Name == "GetUserById" ? user : PlaylistFileStub.Default(method.ReturnType));
    var providers = PlaylistFileStub.Make<IProviderManager>((method, values) =>
    {
        if (method.Name == "QueueRefresh") calls.Add(new { method = "queue", bytes = Bytes(filename),
            forceSave = ((MetadataRefreshOptions)values![1]!).ForceSave, priority = (int)values[2]! });
        return PlaylistFileStub.Default(method.ReturnType);
    });
    BaseItem.LibraryManager = library;
    var manager = new PlaylistManager(library, null!, null!, NullLogger<PlaylistManager>.Instance, users, providers, null!);
    object? error = null;
    try
    {
        switch (Text(sample, "operation"))
        {
            case "add":
                await manager.AddItemToPlaylistAsync(playlist.Id, sample.GetProperty("ids").EnumerateArray().Select(v => Id(v.GetInt32())).ToArray(),
                    sample.TryGetProperty("position", out var position) ? position.GetInt32() : null, Guid.Empty);
                break;
            case "remove":
                await manager.RemoveItemFromPlaylistAsync(playlist.Id.ToString("N"), sample.GetProperty("entryIds").EnumerateArray().Select(v => Id(v.GetInt32()).ToString("N")));
                break;
            case "move":
                await manager.MoveItemAsync(playlist.Id.ToString("N"), Id(sample.GetProperty("entryId").GetInt32()).ToString("N"), sample.GetProperty("newIndex").GetInt32(), Guid.Empty);
                break;
            case "update":
                await manager.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlist.Id, UserId = Guid.Empty,
                    Name = Text(sample, "nameValue"), Ids = sample.TryGetProperty("ids", out var ids)
                        ? ids.EnumerateArray().Select(v => Id(v.GetInt32())).ToArray() : null });
                break;
        }
    }
    catch (Exception caught) { error = Error(caught); }
    operations.Add(new { name, error, repository, live = Snapshot(playlist), bytes = Bytes(filename), calls });
}
var assemblies = new[] { typeof(PlaylistManager).Assembly, typeof(BaseItem).Assembly, typeof(PlaylistsNET.Content.M3uContent).Assembly }
    .Select(assembly => new { name = assembly.GetName().Name, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { candidateVerified = false,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), assemblies, writes, pathCases, operations }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class PlaylistFileStub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, PlaylistFileStub>(); ((PlaylistFileStub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
