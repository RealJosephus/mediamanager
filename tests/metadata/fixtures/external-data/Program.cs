// Executes native extracted-file cleanup and all four native SQLite managers.
using System.Data.Common;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Chapters;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using Jellyfin.Server.Implementations.MediaSegments;
using Jellyfin.Server.Implementations.Trickplay;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Model;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaSegments;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var nativeRoot = Path.GetDirectoryName(Environment.GetEnvironmentVariable("MEDIAMANAGER_JELLYFIN_DLL"))!;
var sqliteLibrary = Path.Join(nativeRoot, "runtimes", RuntimeInformation.RuntimeIdentifier, "native", OperatingSystem.IsWindows() ? "e_sqlite3.dll" : "libe_sqlite3.so");
NativeLibrary.Load(sqliteLibrary);
SQLitePCL.Batteries_V2.Init();
var json = new JsonSerializerOptions { WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var outputRoot = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
var id = Guid.Parse("DA111111-1111-1111-1111-111111111111");
var otherId = Guid.Parse("DA222222-2222-2222-2222-222222222222");
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var name = scenario.GetProperty("name").GetString()!;
    var root = Path.Join(outputRoot, "native-state", name);
    Directory.CreateDirectory(root);
    var appPaths = DispatchProxy.Create<IServerApplicationPaths, PathsProxy>();
    ((PathsProxy)(object)appPaths).Root = root;
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)config).Paths = appPaths;
    BaseItem.ConfigurationManager = config;
    BaseItem.LibraryManager = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem item = scenario.TryGetProperty("type", out var type) && type.GetString() == "Audio" ? new Audio() : new Movie();
    item.Id = id; item.Name = "External data control";
    item.Path = scenario.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.Null ? null
        : Path.Join(root, "media", scenario.TryGetProperty("filename", out var filename) ? filename.GetString()! : "Film.mkv");
    if (scenario.TryGetProperty("channel", out var channel) && channel.GetBoolean()) item.ChannelId = otherId;
    if (item is Video video) {
        if (scenario.TryGetProperty("videoType", out var videoType)) video.VideoType = Enum.Parse<VideoType>(videoType.GetString()!);
        if (scenario.TryGetProperty("additionalParts", out var additionalParts) && additionalParts.GetBoolean()) video.AdditionalParts = [Path.Join(root, "media", "Part Two.mkv")];
    }
    if (item.Path is not null) {
        if (item is Video { VideoType: VideoType.Dvd or VideoType.BluRay }) { Directory.CreateDirectory(item.Path); File.WriteAllText(Path.Join(item.Path, "source.marker"), "Preserved media directory"); }
        else { Directory.CreateDirectory(Path.GetDirectoryName(item.Path)!); File.WriteAllText(item.Path, "Preserved source file"); }
    }
    var paths = new PathManager(NullLogger<PathManager>.Instance, config, appPaths);
    var extracted = paths.GetExtractedDataPaths(item);
    foreach (var asset in extracted) {
        var resolved = Path.GetFullPath(asset);
        if (!resolved.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Asset escaped the isolated root");
        if (resolved == item.Path) throw new InvalidOperationException("Control would delete the source media path");
        if (scenario.TryGetProperty("assetFile", out var assetFile) && assetFile.GetBoolean() && asset == extracted[0]) {
            Directory.CreateDirectory(Path.GetDirectoryName(asset)!); File.WriteAllText(asset, "Cache leaf is a file");
        } else { Directory.CreateDirectory(Path.Join(asset, "nested")); File.WriteAllText(Path.Join(asset, "nested", "cache.bin"), "Extracted data"); }
    }
    var readOnly = scenario.TryGetProperty("readOnly", out var readOnlyNode) && readOnlyNode.GetBoolean();
    var readOnlyFile = Path.Join(extracted[0], "nested", "cache.bin");
    if (readOnly) File.SetAttributes(readOnlyFile, File.GetAttributes(readOnlyFile) | FileAttributes.ReadOnly);
    var calls = new List<object>();
    var interceptor = new DeleteInterceptor { Calls = calls };
    var factory = new SqlFactory(Path.Join(root, "jellyfin.db"), interceptor);
    using (var db = factory.CreateDbContext()) {
        db.Database.EnsureCreated();
        foreach (var itemId in new[] { id, otherId }) {
            var row = new BaseItemEntity { Id = itemId, Name = "Preserved item", Type = typeof(Movie).FullName!, Data = "{}" };
            db.BaseItems.Add(row);
            db.KeyframeData.Add(new KeyframeData { ItemId = itemId, TotalDuration = 200000000, KeyframeTicks = [0, 100000000] });
            db.MediaSegments.Add(new MediaSegment { Id = itemId, ItemId = itemId, SegmentProviderId = "Control", StartTicks = 0, EndTicks = 100000000 });
            db.TrickplayInfos.Add(new TrickplayInfo { ItemId = itemId, Width = 100, Height = 50, TileWidth = 1, TileHeight = 1, ThumbnailCount = 2, Interval = 10000, Bandwidth = 100 });
            db.Chapters.Add(new Chapter { ItemId = itemId, Item = row, ChapterIndex = 0, StartPositionTicks = 0, Name = "Preserved chapter" });
        }
        db.SaveChanges();
    }
    var plugins = scenario.TryGetProperty("pluginError", out var pluginError) && pluginError.GetBoolean()
        ? new IMediaSegmentProvider[] { new CleanupProvider { Calls = calls } } : [];
    var segments = new MediaSegmentManager(new RecordingLogger<MediaSegmentManager>(calls), factory, plugins);
    var trickplay = new TrickplayManager(NullLogger<TrickplayManager>.Instance, null!, null!, null!, null!, null!, factory, null!, null!);
    var chapters = new ChapterManager(NullLogger<ChapterManager>.Instance, null!, null!, new ChapterRepository(factory, null!), null!, paths);
    var manager = new ExternalDataManager(new KeyframeManager(new KeyframeRepository(factory)), segments, paths, trickplay, chapters,
        new RecordingLogger<ExternalDataManager>(calls));
    interceptor.Active = true;
    interceptor.FailTable = scenario.TryGetProperty("failTable", out var failTable) ? failTable.GetString() : null;
    string? exception = null;
    try {
        if (scenario.TryGetProperty("filesOnly", out var filesOnly) && filesOnly.GetBoolean()) manager.DeleteExternalItemFiles(item);
        else await manager.DeleteExternalItemDataAsync(item, CancellationToken.None);
    } catch (IOException error) { exception = error.GetType().Name; }
    using var after = factory.CreateDbContext();
    var remaining = new[] { id, otherId }.Select(itemId => new { target = itemId == id,
        keyframes = after.KeyframeData.Count(row => row.ItemId == itemId), segments = after.MediaSegments.Count(row => row.ItemId == itemId),
        trickplay = after.TrickplayInfos.Count(row => row.ItemId == itemId), chapters = after.Chapters.Count(row => row.ItemId == itemId),
        baseItems = after.BaseItems.Count(row => row.Id == itemId) }).ToArray();
    results.Add(new { name, exception, paths = extracted.Select(asset => Path.GetRelativePath(root, asset)).ToArray(), calls, remaining,
        assets = extracted.Select(asset => new { directory = Directory.Exists(asset), file = File.Exists(asset) }).ToArray(),
        sourceExists = item.Path is null || File.Exists(item.Path) || Directory.Exists(item.Path) });
    if (readOnly && File.Exists(readOnlyFile)) File.SetAttributes(readOnlyFile, FileAttributes.Normal);
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    sqliteLibrarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sqliteLibrary))).ToLowerInvariant(),
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual PathManager/ExternalDataManager delete real isolated extracted directories; actual KeyframeManager/KeyframeRepository, MediaSegmentManager, TrickplayManager and ChapterManager/ChapterRepository delete from an isolated native EF SQLite database. Native SQLite command interception injects each delete-stage failure, and a controlled segment provider throws during cleanup. Application paths/library lookup are controlled, source and cache bytes are inert sentinels. Full metadata refresh, native NFO, actual network media, generic item deletion and generated media are excluded." }, json));

public class PathsProxy : DispatchProxy {
    public string Root = "";
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_DataPath" => Path.Join(Root, "data"), "get_InternalMetadataPath" => Path.Join(Root, "metadata"),
        "get_TrickplayPath" => Path.Join(Root, "data", "trickplay"), _ => throw new NotSupportedException(method.Name)
    };
}
public class ConfigurationProxy : DispatchProxy {
    public IServerApplicationPaths Paths = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "get_ApplicationPaths" => Paths, "get_Configuration" => new ServerConfiguration(), _ => throw new NotSupportedException(method.Name)
    };
}
public class LibraryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), _ => throw new NotSupportedException(method.Name)
    };
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class RecordingLogger<T>(List<object> calls) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) {
        if (level >= LogLevel.Warning) calls.Add(new { phase = "log", level = level.ToString(), exception = exception?.GetType().Name });
    }
}
public class CleanupProvider : IMediaSegmentProvider {
    public List<object> Calls = []; public string Name => "Controlled cleanup failure";
    public ValueTask<bool> Supports(BaseItem item) => ValueTask.FromResult(true);
    public Task<IReadOnlyList<MediaSegmentDto>> GetMediaSegments(MediaSegmentGenerationRequest request, CancellationToken token) => throw new NotSupportedException();
    public Task CleanupExtractedData(Guid itemId, CancellationToken token) { Calls.Add(new { phase = "plugin", cancellable = token.CanBeCanceled }); throw new IOException("Injected segment provider failure"); }
}
public class DeleteInterceptor : DbCommandInterceptor {
    public List<object> Calls = []; public bool Active; public string? FailTable;
    private void Inspect(DbCommand command, CancellationToken token) {
        if (!Active || !command.CommandText.StartsWith("DELETE", StringComparison.Ordinal)) return;
        var table = new[] { "KeyframeData", "MediaSegments", "TrickplayInfos", "Chapters" }.Single(name => command.CommandText.Contains('"' + name + '"', StringComparison.Ordinal));
        Calls.Add(new { phase = "delete", table, cancellable = token.CanBeCanceled });
        if (FailTable == table) throw new IOException("Injected native delete failure");
    }
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken token = default) {
        Inspect(command, token); return ValueTask.FromResult(result);
    }
}
public class SqlFactory(string filename, DeleteInterceptor interceptor) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False")
        .AddInterceptors(interceptor).Options, NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
