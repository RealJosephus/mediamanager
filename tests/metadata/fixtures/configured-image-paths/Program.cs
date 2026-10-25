using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var output = Path.GetFullPath(args[1]);
var picture = File.ReadAllBytes(args[2]);
var previousPicture = File.ReadAllBytes(args[3]);
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = System.Runtime.InteropServices.NativeLibrary.Load(sqliteFilename);
System.Runtime.InteropServices.NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly,
    (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var results = new List<object>();
var failures = new List<Exception>();
using var input = JsonDocument.Parse(inputBytes);
foreach (var sample in input.RootElement.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(30));
    var boundary = sample.GetProperty("boundary").GetString()!;
    var root = Path.Combine(Path.GetDirectoryName(output)!, "states", name); Directory.CreateDirectory(root);
    var first = Path.Combine(root, "first-metadata"); var second = Path.Combine(root, "second-metadata");
    Directory.CreateDirectory(second);
    var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
    Directory.CreateDirectory(paths.ConfigurationDirectoryPath);
    ServerConfiguration Options(string metadata) => new() { MetadataPath = metadata, IsStartupWizardCompleted = true,
        ImageSavingConvention = ImageSavingConvention.Compatible, CacheSize = 64 };
    var serializer = new MyXmlSerializer(); serializer.SerializeToFile(Options(first), Path.Combine(paths.ConfigurationDirectoryPath, "system.xml"));
    var configuration = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer);
    var files = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.ConfigurationManager = configuration; BaseItem.FileSystem = files; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
    Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
    var appHostType = Assembly.Load("jellyfin").GetType("Jellyfin.Server.CoreAppHost")!;
    var appHost = (IServerApplicationHost)RuntimeHelpers.GetUninitializedObject(appHostType);
    typeof(ApplicationHost).GetField("<ApplicationPaths>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(appHost, paths);
    var factory = new SqlFactory(Path.Combine(root, "native.db")); using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    var item = new Movie { Id = Guid.Parse("d9430000-0000-0000-0000-000000000041"), Name = "Original movie", ProductionYear = 2026,
        Path = Path.Combine(boundary == "repository" ? first : root, "media", "movie.mkv"), IsInMixedFolder = true };
    Directory.CreateDirectory(Path.GetDirectoryName(item.Path)!); File.WriteAllText(item.Path, "Controlled media identity; no probe or encoder is installed.");
    var library = Stub.Make<ILibraryManager>((method, parameters) => method.Name switch {
        "GetLibraryOptions" => new LibraryOptions { SaveLocalMetadata = false },
        "GetItemById" => (Guid)parameters![0]! == item.Id ? item : null,
        "GetCollectionFolders" => new List<Folder>(),
        _ => Stub.Default(method.ReturnType)
    }); BaseItem.LibraryManager = library;
    persistence.SaveItems([item], CancellationToken.None);
    var oldFile = Path.Combine(first, "library", "d9", item.Id.ToString("N"), "poster.jpg");
    if (boundary == "copy") {
        Directory.CreateDirectory(Path.GetDirectoryName(oldFile)!); File.WriteAllBytes(oldFile, previousPicture);
        item.SetImagePath(ImageType.Primary, 0, files.GetFileInfo(oldFile));
        await persistence.SaveImagesAsync(item);
    }
    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    WebApplication? server = null; Task? work = null; GateStream? stream = null;
    using var http = new HttpClient(); using var cache = new MemoryCache(new MemoryCacheOptions());
    using var providers = new ProviderManager(new ClientFactory(http), null!, configuration,
        Stub.Make<ILibraryMonitor>((method, _) => Stub.Default(method.ReturnType)), NullLogger<ProviderManager>.Instance,
        files, paths, library, Stub.Make<IBaseItemManager>((method, _) => Stub.Default(method.ReturnType)), null!, cache, null!, null!);
    object? failure = null; object? sourceReadAfterSave = null; long? openedBytes = null;
    var sourceClosed = true; var targetOpened = false; var serverClosed = false; var workObserved = false;
    try {
        if (boundary == "download") {
            var builder = WebApplication.CreateSlimBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
            server = builder.Build();
            server.MapGet("/poster.png", async context => {
                context.Response.ContentType = "image/png"; context.Response.ContentLength = picture.Length;
                await context.Response.StartAsync(context.RequestAborted); entered.TrySetResult();
                await release.Task.WaitAsync(context.RequestAborted); await context.Response.Body.WriteAsync(picture, context.RequestAborted);
            });
            await server.StartAsync();
            var address = server.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            work = providers.SaveImage(item, address + "/poster.png", ImageType.Primary, 0, lifetime.Token);
        } else if (boundary == "copy") {
            stream = new GateStream(picture, entered, release);
            work = providers.SaveImage(item, stream, "image/png", ImageType.Primary, 0, lifetime.Token);
        } else {
            // This control pauses before the actual SaveItems call. The SQL
            // mapper, virtual path conversion and cold repository read are real.
            work = Task.Run(async () => { entered.TrySetResult(); await release.Task; item.Overview = "After provider";
                persistence.SaveItems([item], lifetime.Token); });
        }
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        if (boundary == "copy") {
            var target = Path.ChangeExtension(oldFile, ".png"); targetOpened = File.Exists(target);
            if (targetOpened) openedBytes = new FileInfo(target).Length;
        }
        configuration.ReplaceConfiguration(Options(second));
        release.TrySetResult(); try { await work.WaitAsync(lifetime.Token); } finally { workObserved = work.IsCompleted; }
        if (boundary != "repository") await persistence.SaveImagesAsync(item);
        if (stream is not null) {
            try { stream.ReadByte(); sourceClosed = false; }
            catch (ObjectDisposedException error) { sourceClosed = true; sourceReadAfterSave = Failure(error); }
        }
    } catch (Exception error) { failure = Failure(error); failures.Add(error); }
    finally {
        release.TrySetResult();
        if (work is not null && !workObserved) try { await work; }
            catch (Exception error) { failure ??= Failure(error); failures.Add(error); }
        if (server is not null) { try { await server.StopAsync(); await server.DisposeAsync(); serverClosed = true; }
            catch (Exception error) { failures.Add(error); failure = Failure(error); } }
        else serverClosed = true;
    }
    using var final = factory.CreateDbContext();
    var stored = final.BaseItems.AsNoTracking().Single(value => value.Id == item.Id);
    var rows = final.BaseItemImageInfos.AsNoTracking().Where(value => value.ItemId == item.Id).ToArray();
    var cold = repository.RetrieveItem(item.Id)!;
    string? Project(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal).Replace(Path.DirectorySeparatorChar, '/');
    var business = new { itemPath = Project(item.Path), storedPath = Project(stored.Path), coldPath = Project(cold.Path), stored.Overview,
        metadataPath = Project(paths.InternalMetadataPath),
        images = rows.Select(value => new { path = Project(value.Path), value.Width, value.Height, type = (int)value.ImageType }).ToArray(),
        files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(filename => filename.EndsWith(".png", StringComparison.Ordinal) || filename.EndsWith(".jpg", StringComparison.Ordinal))
            .Select(filename => new { path = Project(filename), bytes = new FileInfo(filename).Length, sha256 = Hash(File.ReadAllBytes(filename)) })
            .OrderBy(value => value.path, StringComparer.Ordinal).ToArray(), targetOpened, openedBytes, failure };
    results.Add(new { name, business, resources = new { sourceClosed = boundary == "copy" ? (bool?)sourceClosed : null, sourceReadAfterSave, serverClosed }, raw = new { item.Path, storedPath = stored.Path, coldPath = cold.Path,
        images = rows.Select(value => new { value.Path, value.DateModified, value.Width, value.Height, value.Blurhash, value.ImageType }),
        configuration = configuration.Configuration.MetadataPath } });
}
File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Hash(inputBytes), imageSha256 = Hash(picture), previousImageSha256 = Hash(previousPicture),
    scope = "Actual ServerConfigurationManager/serializer/ApplicationPaths, ManagedFileSystem, ProviderManager URL and stream overloads/ImageSaver, ItemPersistenceService EF SQLite, and BaseItemRepository cold reads. Actual ApplicationHost ReverseVirtualPath/ExpandVirtualPath on an unconstructed host with its paths field initialized; unrelated library options/lookups and monitor are controlled. Repository case pauses before real SaveItems, not a full MetadataService claim.",
    results, failures = failures.Select(Failure), sqlite = new { name = sqliteName, runtimeIdentifier = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier,
        sha256 = Hash(File.ReadAllBytes(sqliteFilename)) },
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location)
        && (value.GetName().Name == "jellyfin" || value.GetName().Name!.StartsWith("Jellyfin.", StringComparison.Ordinal)
            || value.GetName().Name!.StartsWith("MediaBrowser.", StringComparison.Ordinal) || value.GetName().Name!.StartsWith("Emby.", StringComparison.Ordinal)))
        .Select(value => new { name = value.GetName().Name, sha256 = Hash(File.ReadAllBytes(value.Location)) }) },
    new JsonSerializerOptions { WriteIndented = true }) + "\n");
if (failures.Count > 0) throw new AggregateException("Configured image path capture failed.", failures);
static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));
static object Failure(Exception error) => new { error.Message, error.StackTrace, type = error.GetType().FullName,
    cause = error.InnerException is null ? null : Failure(error.InnerException),
    errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
public class ClientFactory(HttpClient client) : IHttpClientFactory { public HttpClient CreateClient(string name) => client; }
public sealed class GateStream(byte[] bytes, TaskCompletionSource entered, TaskCompletionSource release) : Stream {
    private readonly MemoryStream inner = new(bytes, false); private bool closed;
    public override bool CanRead => !closed; public override bool CanSeek => false; public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
        ObjectDisposedException.ThrowIf(closed, this); entered.TrySetResult(); await release.Task.WaitAsync(token); return await inner.ReadAsync(buffer, token);
    }
    public override int Read(byte[] buffer, int offset, int count) { ObjectDisposedException.ThrowIf(closed, this); return inner.Read(buffer, offset, count); }
    protected override void Dispose(bool disposing) { closed = true; if (disposing) inner.Dispose(); base.Dispose(disposing); }
    public override void Flush() => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
