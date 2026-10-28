using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Session;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Session;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var observations = new List<object>();
var sourceId = Guid.Parse(input.GetProperty("sourceId").GetString()!);
var rockId = Guid.Parse(input.GetProperty("rockId").GetString()!);
var jazzId = Guid.Parse(input.GetProperty("jazzId").GetString()!);
foreach (var sample in input.GetProperty("samples").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(args[1], observations.Count.ToString("D2"));
    Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata");
    var configuration = new ServerConfiguration { CacheSize = 64, EnableNormalizedItemByNameIds = true };
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata,
        "get_DataPath" => Path.Combine(root, "data"), "get_MusicGenrePath" => Path.Combine(metadata, "MusicGenre"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.UserDataManager = Stub.Make<IUserDataManager>((method, _) => method.Name == "GetUserData"
        ? new UserItemData { Key = "fixture" } : Stub.Default(method.ReturnType));
    var media = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
        "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(),
        "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.MediaSourceManager = media;
    Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
    var host = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "get_SystemId") return "instant-mix-warm";
        if (method.Name == "ReverseVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith(metadata, StringComparison.Ordinal) == true ? "%MetadataPath%" + value[metadata.Length..] : value;
        }
        if (method.Name == "ExpandVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith("%MetadataPath%", StringComparison.Ordinal) == true ? metadata + value[14..] : value;
        }
        return Stub.Default(method.ReturnType);
    });
    var factory = new SqlFactory(Path.Combine(root, "native.sqlite"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, host, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, host, NullLogger<ItemPersistenceService>.Instance);
    var actual = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    Field(actual, "_configurationManager", config); Field(actual, "_logger", NullLogger<LibraryManager>.Instance);
    Field(actual, "_cache", new FastConcurrentLru<Guid, BaseItem>(64));
    Field(actual, "_itemRepository", repository); Field(actual, "_persistenceService", persistence);
    Field(actual, "_userRootFolder", new UserRootFolder { Children = [] });
    var genreCalls = new List<string>(); var added = new List<Guid>();
    actual.ItemAdded += (_, change) => added.Add(change.Item.Id);
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetCollectionFolders") return new List<Folder>();
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        if (method.Name == "GetMusicGenre") genreCalls.Add((string)values![0]!);
        return Stub.Forward(actual, method, values);
    });
    BaseItem.LibraryManager = library;
    var type = sample.GetProperty("type").GetString()!;
    BaseItem source = NewItem(type, sourceId, "Original source", "Rock");
    persistence.SaveItems([source, NewItem("Audio", rockId, "Rock candidate", "Rock"),
        NewItem("Audio", jazzId, "Jazz candidate", "Jazz")], CancellationToken.None);
    var initialRows = Snapshot(factory);
    if (sample.TryGetProperty("warm", out var warm) && warm.GetBoolean()) _ = actual.GetItemById(sourceId);
    if (sample.TryGetProperty("mutation", out var mutation)) {
        if (mutation.GetString() == "delete") persistence.DeleteItem([sourceId]);
        else persistence.SaveItems([NewItem(mutation.GetString() == "movie" ? "Movie"
            : mutation.GetString() == "replace-audio" ? "Audio" : "MusicAlbum", sourceId, "Replacement source", "Jazz")], CancellationToken.None);
    }
    var sourceAfterMutation = Snapshot(factory).SingleOrDefault(row => row["Id"] is Guid value && value == sourceId);
    var genreId = actual.GetMusicGenreId("Rock");
    var requests = sample.TryGetProperty("requests", out var requestValues) ? requestValues.EnumerateArray().Select(value => value.GetString()).ToArray() : ["source"];
    var itemIds = requests.Select(value => value switch { "source" => sourceId, "genre" => genreId, _ => Guid.Empty }).ToArray();
    var messages = new List<object>();
    var lifetime = Stub.Make<IHostApplicationLifetime>((method, _) => method.Name is "get_ApplicationStopping" or "get_ApplicationStarted" or "get_ApplicationStopped"
        ? CancellationToken.None : Stub.Default(method.ReturnType));
    var sessions = new SessionManager(NullLogger<SessionManager>.Instance,
        Stub.Make<IEventManager>((method, _) => Stub.Default(method.ReturnType)), BaseItem.UserDataManager, config,
        library, Stub.Make<IUserManager>((method, _) => Stub.Default(method.ReturnType)), new MusicManager(library),
        Stub.Make<IDtoService>((method, _) => Stub.Default(method.ReturnType)), Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)),
        host, Stub.Make<IDeviceManager>((method, _) => Stub.Default(method.ReturnType)), media, lifetime);
    var control = new CaptureController(messages);
    int status = 204; string? errorMessage = null; object? errorResponse = null;
    try {
        var session = await sessions.LogSessionActivity("InstantMixWarm", "1", "target", "Fixture", "127.0.0.1", null!);
        session.SessionControllers = [control];
        await sessions.SendPlayCommand(null!, session.Id, new PlayRequest {
            ItemIds = itemIds, PlayCommand = PlayCommand.PlayInstantMix, StartPositionTicks = 9007199254740993L,
            MediaSourceId = "opaque-source", AudioStreamIndex = 2, SubtitleStreamIndex = -1, StartIndex = 0
        }, CancellationToken.None);
    } catch (Exception error) {
        errorMessage = error.Message;
        var context = new DefaultHttpContext();
        await using var body = new MemoryStream(); context.Response.Body = body;
        var environment = Stub.Make<IWebHostEnvironment>((method, _) => method.Name == "get_EnvironmentName" ? "Production" : Stub.Default(method.ReturnType));
        var middleware = new ExceptionMiddleware(_ => Task.FromException(error), NullLogger<ExceptionMiddleware>.Instance, config, environment);
        await middleware.Invoke(context);
        status = context.Response.StatusCode;
        errorResponse = new { status, contentType = context.Response.ContentType, body = Encoding.UTF8.GetString(body.ToArray()) };
    }
    finally { await sessions.DisposeAsync(); }
    using var after = factory.CreateDbContext();
    var rows = after.BaseItems.AsNoTracking().OrderBy(row => row.Id).ToArray().Select(row => new {
        row.Id, row.Type, row.Name, row.Genres, row.CleanName, row.Path
    }).ToArray();
    observations.Add(new { name, status, errorMessage, errorResponse, initialRows, sourceAfterMutation, genreId, itemIds, genreCalls, added, messages, rows,
        genreDirectoryExists = Directory.Exists(MusicGenre.GetPath("Rock")), controllerDisposed = control.Disposed });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
var nativeLibraries = new[] { new { filename = sqliteFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier,
    sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFilename))) } };
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    actualSessionManager = true, actualMusicManager = true, actualLibraryManager = true,
    actualSqliteRepository = true, actualGenreCreation = true, actualExceptionMiddleware = true, observations, assemblies, nativeLibraries,
    dependenciesControlled = new[] { "application paths", "userless session", "non-query infrastructure", "session transport sink" },
    actualNativeHttp = false, actualNativeWebSocket = false, phaseAcceptance = false
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static BaseItem NewItem(string type, Guid id, string name, string genre) {
    BaseItem item = type switch { "MusicAlbum" => new MusicAlbum(), "MusicArtist" => new MusicArtist(),
        "Playlist" => new Playlist { OpenAccess = true }, "Movie" => new Movie(), "AudioBook" => new AudioBook(), _ => new Audio() };
    item.Id = id; item.Name = name; item.Genres = [genre]; item.Path = "/fixture/" + id.ToString("N") + ".media";
    if (item is Folder folder) folder.LinkedChildren = [];
    return item;
}
static void Field(object owner, string name, object value) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(owner, value);
static Dictionary<string, object?>[] Snapshot(SqlFactory factory) {
    using var context = factory.CreateDbContext();
    var entity = context.Model.FindEntityType(typeof(BaseItemEntity))!;
    var table = StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
    return context.BaseItems.AsNoTracking().OrderBy(row => row.Id).ToArray().Select(row =>
        entity.GetProperties().ToDictionary(property => property.GetColumnName(table)!, property => property.PropertyInfo!.GetValue(row))).ToArray();
}
public sealed class CaptureController(List<object> messages) : ISessionController, IAsyncDisposable {
    public bool IsSessionActive => true;
    public bool SupportsMediaControl => true;
    public bool Disposed { get; private set; }
    public Task SendMessage<T>(SessionMessageType name, Guid messageId, T data, CancellationToken cancellationToken) {
        if (data is PlayRequest request) messages.Add(new { MessageType = name.ToString(), MessageId = messageId.ToString("N"), Data = new {
            ItemIds = request.ItemIds.Select(id => id.ToString("N")).ToArray(), PlayCommand = request.PlayCommand.ToString(),
            request.StartPositionTicks, ControllingUserId = request.ControllingUserId.ToString("N"), request.MediaSourceId,
            request.AudioStreamIndex, request.SubtitleStreamIndex, request.StartIndex
        } });
        return Task.CompletedTask;
    }
    public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
