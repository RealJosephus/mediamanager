using System.Globalization;
using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Drawing;
using Jellyfin.Drawing.Skia;
using Jellyfin.Server.Extensions;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Net;
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
using Microsoft.AspNetCore.Localization;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]); using var input = JsonDocument.Parse(inputBytes);
var output = Path.GetFullPath(args[1]); var picture = File.ReadAllBytes(args[2]);
var diagnostics = new ConcurrentQueue<object>();
using var captureLoggers = LoggerFactory.Create(value => value.ClearProviders().AddProvider(new DiagnosticProvider(diagnostics)));
var root = Path.Combine(Path.GetDirectoryName(output)!, "state"); Directory.CreateDirectory(root);
var program = Path.Combine(root, "program"); var first = Path.Combine(root, "metadata-a"); var second = Path.Combine(root, "metadata-b");
Directory.CreateDirectory(second);
var configDirectory = Path.Combine(root, "config"); Directory.CreateDirectory(configDirectory);
var media = Path.Combine(root, "media"); Directory.CreateDirectory(media);
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var skiaName = OperatingSystem.IsWindows() ? "libSkiaSharp.dll" : OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so";
var nativeLibraries = new[] { (Name: "sqlite", Filename: sqliteName), (Name: "skia", Filename: skiaName) };
var sqliteHandle = System.Runtime.InteropServices.NativeLibrary.Load(Path.Combine(AppContext.BaseDirectory, sqliteName));
var skiaHandle = System.Runtime.InteropServices.NativeLibrary.Load(Path.Combine(AppContext.BaseDirectory, skiaName));
System.Runtime.InteropServices.NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? sqliteHandle : IntPtr.Zero);
System.Runtime.InteropServices.NativeLibrary.SetDllImportResolver(typeof(SkiaSharp.SKBitmap).Assembly, (name, _, _) => name == "libSkiaSharp" ? skiaHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var factory = new SqlFactory(Path.Combine(root, "native.db")); using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
var serializer = new MyXmlSerializer(); var configurationFile = Path.Combine(configDirectory, "system.xml");
ServerConfiguration Options(string metadata) => new() { IsStartupWizardCompleted = true, MetadataPath = metadata,
    UICulture = "en-US", ImageSavingConvention = ImageSavingConvention.Compatible, CacheSize = 64 };
serializer.SerializeToFile(Options(first), configurationFile);
ServerApplicationPaths Paths() => new(program, Path.Combine(root, "log"), configDirectory, Path.Combine(root, "cache"), Path.Combine(root, "web"));
IServerApplicationHost Host(ServerApplicationPaths paths) {
    var type = Assembly.Load("jellyfin").GetType("Jellyfin.Server.CoreAppHost")!;
    var host = (IServerApplicationHost)RuntimeHelpers.GetUninitializedObject(type);
    typeof(ApplicationHost).GetField("<ApplicationPaths>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(host, paths); return host;
}
void EntityServices(ServerConfigurationManager configuration, ManagedFileSystem files) {
    BaseItem.ConfigurationManager = configuration; BaseItem.FileSystem = files; BaseItem.Logger = captureLoggers.CreateLogger<BaseItem>();
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
    Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));
}
var id = Guid.Parse("c01d0000-0000-0000-0000-000000000001");
var warmPaths = Paths(); var warmConfiguration = new ServerConfigurationManager(warmPaths, NullLoggerFactory.Instance, serializer);
var warmFiles = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, warmPaths, []); EntityServices(warmConfiguration, warmFiles);
var warmHost = Host(warmPaths); var warmRepository = new BaseItemRepository(factory, warmHost, new ItemTypeLookup(), warmConfiguration, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = warmRepository;
var persistence = new ItemPersistenceService(factory, warmHost, NullLogger<ItemPersistenceService>.Instance);
var owner = new Movie { Id = id, Name = "Cold metadata image", ProductionYear = 2026, IsInMixedFolder = true,
    Path = Path.Combine(media, "movie.mkv") };
File.WriteAllText(owner.Path, "Controlled media identity; no probe or encoder is installed.");
var warmLibrary = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
    "GetLibraryOptions" => new LibraryOptions { SaveLocalMetadata = false }, "GetItemById" => (Guid)values![0]! == id ? owner : null,
    "GetCollectionFolders" => new List<Folder>(), _ => Stub.Default(method.ReturnType)
}); BaseItem.LibraryManager = warmLibrary;
persistence.SaveItems([owner], CancellationToken.None);
using (var cache = new MemoryCache(new MemoryCacheOptions()))
using (var providers = new ProviderManager(null!, null!, warmConfiguration, Stub.Make<ILibraryMonitor>((method, _) => Stub.Default(method.ReturnType)),
    NullLogger<ProviderManager>.Instance, warmFiles, warmPaths, warmLibrary, Stub.Make<IBaseItemManager>((method, _) => Stub.Default(method.ReturnType)), null!, cache, null!, null!)) {
    await providers.SaveImage(owner, new MemoryStream(picture, false), "image/png", ImageType.Primary, 0, CancellationToken.None);
}
var imagePath = owner.ImageInfos.Single().Path;
File.SetLastWriteTimeUtc(imagePath, DateTime.Parse(input.RootElement.GetProperty("modified").GetString()!, CultureInfo.InvariantCulture).ToUniversalTime());
owner.SetImagePath(ImageType.Primary, 0, warmFiles.GetFileInfo(imagePath));
using (var processor = new ImageProcessor(captureLoggers.CreateLogger<ImageProcessor>(), warmPaths, warmFiles,
    new SkiaEncoder(captureLoggers.CreateLogger<SkiaEncoder>(), warmPaths), warmConfiguration)) {
    var consumer = (Emby.Server.Implementations.Library.LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(Emby.Server.Implementations.Library.LibraryManager));
    void Set(string name, object value) => typeof(Emby.Server.Implementations.Library.LibraryManager).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(consumer, value);
    Set("_fileSystem", warmFiles); Set("_imageProcessor", processor); Set("_persistenceService", persistence);
    Set("_logger", captureLoggers.CreateLogger<Emby.Server.Implementations.Library.LibraryManager>());
    Set("_cache", new FastConcurrentLru<Guid, BaseItem>(warmConfiguration.Configuration.CacheSize));
    await consumer.UpdateImagesAsync(owner, true);
}
warmConfiguration.ReplaceConfiguration(Options(second));
var savedConfiguration = File.ReadAllBytes(configurationFile);

// Recreate configuration, application paths, repository and image processor.
// The library gateway returns only freshly deserialized real SQLite values.
var coldPaths = Paths(); var coldConfiguration = new ServerConfigurationManager(coldPaths, NullLoggerFactory.Instance, serializer);
var coldFiles = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, coldPaths, []); EntityServices(coldConfiguration, coldFiles);
var coldRepository = new BaseItemRepository(factory, Host(coldPaths), new ItemTypeLookup(), coldConfiguration, NullLogger<BaseItemRepository>.Instance);
BaseItem.ItemRepository = coldRepository;
var coldLibrary = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetItemById"
    ? coldRepository.RetrieveItem((Guid)values![0]!) : method.Name == "GetLibraryOptions" ? new LibraryOptions { SaveLocalMetadata = false } : Stub.Default(method.ReturnType));
BaseItem.LibraryManager = coldLibrary;
var coldProcessor = new ImageProcessor(captureLoggers.CreateLogger<ImageProcessor>(), coldPaths, coldFiles,
    new SkiaEncoder(captureLoggers.CreateLogger<SkiaEncoder>(), coldPaths), coldConfiguration);
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" }); builder.Logging.ClearProviders();
builder.Logging.AddProvider(new DiagnosticProvider(diagnostics));
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(coldConfiguration);
builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyImageController()));
builder.Services.Replace(ServiceDescriptor.Transient<ImageController>(_ => new ImageController(
    Stub.Make<IUserManager>((method, _) => Stub.Default(method.ReturnType)), coldLibrary,
    Stub.Make<MediaBrowser.Controller.Providers.IProviderManager>((method, _) => Stub.Default(method.ReturnType)), coldProcessor, coldFiles,
    captureLoggers.CreateLogger<ImageController>(), coldConfiguration, coldPaths)));
var app = builder.Build(); var responses = new List<object>(); var failures = new List<Exception>(); var cleanup = new Dictionary<string, bool>();
using var http = new HttpClient();
try {
    app.UseMiddleware<ExceptionMiddleware>();
    app.UseRequestLocalization(new RequestLocalizationOptions { DefaultRequestCulture = new RequestCulture("en-US"),
        SupportedCultures = [CultureInfo.GetCultureInfo("en-US")], SupportedUICultures = [CultureInfo.GetCultureInfo("en-US")],
        ApplyCurrentCultureToResponseHeaders = true });
    app.MapControllers(); await app.StartAsync();
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    foreach (var sample in input.RootElement.GetProperty("cases").EnumerateArray()) {
        using var request = new HttpRequestMessage(new HttpMethod(sample.GetProperty("method").GetString()!),
            address + "/Items/" + id.ToString("N") + "/Images/Primary" + sample.GetProperty("query").GetString());
        request.Headers.TryAddWithoutValidation("Accept", "image/png");
        foreach (var header in sample.GetProperty("headers").EnumerateObject()) request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
        using var response = await http.SendAsync(request); var bytes = await response.Content.ReadAsByteArrayAsync();
        var headers = response.Headers.Concat(response.Content.Headers).ToDictionary(value => value.Key.ToLowerInvariant(), value => string.Join(", ", value.Value));
        responses.Add(new { name = sample.GetProperty("name").GetString(), status = (int)response.StatusCode, headers,
            body = new { bytes = bytes.Length, sha256 = Hash(bytes), base64 = Convert.ToBase64String(bytes) } });
    }
} catch (Exception error) { failures.Add(error); }
finally {
    try { await app.StopAsync(); cleanup["httpStopped"] = true; } catch (Exception error) { failures.Add(error); }
    try { await app.DisposeAsync(); cleanup["httpDisposed"] = true; } catch (Exception error) { failures.Add(error); }
    try { coldProcessor.Dispose(); cleanup["imageProcessorDisposed"] = true; } catch (Exception error) { failures.Add(error); }
    try { using var exclusive = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.None);
        if (exclusive.ReadByte() != picture[0]) throw new IOException("The saved image changed after HTTP close.");
        cleanup["imageExclusiveReadAfterClose"] = true;
    } catch (Exception error) { failures.Add(error); }
}
using (var final = factory.CreateDbContext()) {
    var rows = final.BaseItemImageInfos.AsNoTracking().Where(value => value.ItemId == id).ToArray();
    var cold = coldRepository.RetrieveItem(id)!;
    string? Project(string? value) => value?.Replace(root, "$STATE", StringComparison.Ordinal).Replace(Path.DirectorySeparatorChar, '/');
    var business = new { metadataPath = Project(coldPaths.InternalMetadataPath), itemPath = Project(cold.Path),
        images = rows.Select(value => new { path = Project(value.Path), value.Width, value.Height,
            blurhash = value.Blurhash is null ? null : System.Text.Encoding.UTF8.GetString(value.Blurhash),
            modified = value.DateModified?.ToUniversalTime().ToString("O") }),
        oldImage = new { path = Project(imagePath), bytes = new FileInfo(imagePath).Length, sha256 = Hash(File.ReadAllBytes(imagePath)) },
        newRootImages = Directory.EnumerateFiles(second, "*.png", SearchOption.AllDirectories).Select(Project).OrderBy(value => value, StringComparer.Ordinal).ToArray() };
    File.WriteAllText(output, JsonSerializer.Serialize(new { inputSha256 = Hash(inputBytes), imageSha256 = Hash(picture), business, responses,
        raw = new { configurationXml = Convert.ToBase64String(savedConfiguration), coldConfiguration.Configuration.MetadataPath, cold.Path,
            images = rows.Select(value => new { value.Path, value.Width, value.Height, value.DateModified, value.Blurhash }) }, cleanup,
        failures = failures.Select(Failure), diagnostics = diagnostics.ToArray(), scope = "Actual ProviderManager/ImageSaver A save, ImageProcessor/Skia and LibraryManager.UpdateImagesAsync/EF SQLite, actual ServerConfigurationManager persisted B and fresh configuration/paths/BaseItemRepository deserialization, actual ImageController/ProcessImage/PhysicalFile via Kestrel. Library lookup gateway serves fresh real repository values. Unconstructed ApplicationHost is used only for real virtual path methods. This is not a complete native server boot or third-party storage claim.",
        nativeLibraries = nativeLibraries.Select(value => new { value.Name, filename = value.Filename, runtimeIdentifier = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier,
            sha256 = Hash(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, value.Filename))) }),
        assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location)
            && (value.GetName().Name == "jellyfin" || value.GetName().Name!.StartsWith("MediaBrowser.", StringComparison.Ordinal)
                || value.GetName().Name!.StartsWith("Jellyfin.", StringComparison.Ordinal) || value.GetName().Name!.StartsWith("Emby.", StringComparison.Ordinal)))
            .Select(value => new { name = value.GetName().Name, sha256 = Hash(File.ReadAllBytes(value.Location)) }),
        frameworkAssemblies = new[] { typeof(Microsoft.AspNetCore.Mvc.ControllerBase).Assembly, typeof(WebApplication).Assembly }
            .Distinct().Select(value => new { name = value.GetName().Name, filename = value.Location, sha256 = Hash(File.ReadAllBytes(value.Location)) })
        }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
}
if (failures.Count > 0) throw new AggregateException("Cold metadata image HTTP capture failed.", failures);
static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));
static object Failure(Exception error) => new { error.Message, error.StackTrace, type = error.GetType().FullName,
    cause = error.InnerException is null ? null : Failure(error.InnerException), errors = error is AggregateException group ? group.InnerExceptions.Select(Failure).ToArray() : null };
public class DiagnosticProvider(ConcurrentQueue<object> values) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new Logger(category, values); public void Dispose() { }
    public class Logger(string category, ConcurrentQueue<object> values) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null || level >= LogLevel.Error) values.Enqueue(new { category, level = level.ToString(), message = formatter(state, error), error = error is null ? null : Details(error) });
        }
        private static object Details(Exception error) => new { error.Message, error.StackTrace, type = error.GetType().FullName,
            cause = error.InnerException is null ? null : Details(error.InnerException), errors = error is AggregateException group ? group.InnerExceptions.Select(Details).ToArray() : null };
    }
}
public class OnlyImageController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) {
        foreach (var type in feature.Controllers.Where(value => value.AsType() != typeof(ImageController)).ToArray()) feature.Controllers.Remove(type);
    }
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
