using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var name = Text(sample, "name")!;
    var root = Path.GetFullPath(Path.Combine(args[1], name)); Directory.CreateDirectory(root);
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_InternalMetadataPath" => Path.Combine(root, "metadata"), "get_ProgramDataPath" => root,
        "get_DataPath" => Path.Combine(root, "data"), _ => Stub.Default(method.ReturnType) });
    var options = new MetadataOptions { ItemType = "Book", ImageFetcherOrder = Strings(sample, "order"), DisabledImageFetchers = Strings(sample, "disabled") };
    var configuration = new ServerConfiguration { MetadataOptions = [options], ImageSavingConvention = ImageSavingConvention.Compatible };
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths, _ => Stub.Default(method.ReturnType) });
    var actualFs = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var fs = Stub.Make<IFileSystem>((method, values) => {
        if (Bool(sample, "saveFailure") && method.Name == "SetAttributes") throw new IOException("Controlled image write failure");
        if (Bool(sample, "deleteFailure") && method.Name == "DeleteFile") throw new IOException("Controlled previous image deletion failure");
        return Stub.Forward(actualFs, method, values);
    });
    BaseItem.ConfigurationManager = config; BaseItem.FileSystem = fs; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
    var type = new TypeOptions { Type = "Book", ImageFetchers = Strings(sample, "enabled", ["A", "B", "R"]),
        ImageOptions = [new ImageOption { Type = ImageType.Primary, Limit = sample.TryGetProperty("limit", out var limit) ? limit.GetInt32() : 1,
            MinWidth = sample.TryGetProperty("minWidth", out var width) ? width.GetInt32() : 0 }] };
    var libraryOptions = new LibraryOptions { SaveLocalMetadata = Bool(sample, "local"), TypeOptions = Bool(sample, "noType") ? [] : [type] };
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetLibraryOptions" ? libraryOptions : Stub.Default(method.ReturnType));
    BaseItem.LibraryManager = library;
    var book = new Book { Id = Guid.Parse("db120000-0000-0000-0000-000000000001"), Name = "Book", Path = Path.Combine(root, "media", "book.cbz"),
        IsLocked = Bool(sample, "locked"), DateLastRefreshed = Bool(sample, "first") ? DateTime.MinValue : new DateTime(2026, 1, 1) };
    if (Bool(sample, "extra")) book.ExtraType = ExtraType.Trailer;
    Directory.CreateDirectory(Path.GetDirectoryName(book.Path)!); File.WriteAllText(book.Path, "original archive");
    if (Bool(sample, "existing")) {
        var old = Path.Combine(book.GetInternalMetadataPath(), "old.jpg"); Directory.CreateDirectory(Path.GetDirectoryName(old)!); File.WriteAllText(old, "OLD");
        book.SetImage(new ItemImageInfo { Path = old, Type = ImageType.Primary, Width = 4, Height = 3, BlurHash = "old-hash" }, 0);
    }
    var calls = new List<string>(); var saves = new List<object>(); var streams = new List<OwnedStream>();
    using var cancellation = new CancellationTokenSource();
    var dynamicA = new DynamicProvider("A", () => Action("A", Text(sample, "a") ?? "bytes"));
    var dynamicB = new DynamicProvider("B", () => Action("B", Text(sample, "b") ?? "bytes"));
    var remote = new RemoteProvider("R");
    var manager = (ProviderManager)RuntimeHelpers.GetUninitializedObject(typeof(ProviderManager));
    foreach (var (field, value) in new (string, object)[] { ("_configurationManager", config), ("_fileSystem", fs),
        ("_libraryMonitor", Stub.Make<ILibraryMonitor>((method, values) => Stub.Default(method.ReturnType))),
        ("_logger", NullLogger<ProviderManager>.Instance), ("_libraryManager", library), ("_baseItemManager", new BaseItemManager(config)),
        ("_imageProviders", Strings(sample, "providers", ["A", "B"]).Select(value => value == "R" ? (IImageProvider)remote : value == "B" ? dynamicB : dynamicA).ToArray()) })
        typeof(ProviderManager).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, value);
    var dispatch = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name == "GetAvailableRemoteImages") { calls.Add("R:list"); return Task.FromResult<IEnumerable<RemoteImageInfo>>([new RemoteImageInfo { Type = ImageType.Primary, Url = "https://controlled.invalid/remote", Width = 8 }]); }
        if (method.Name == "SaveImage") {
            var stream = (Stream)values![1]!; var position = stream.Position; using var bytes = new MemoryStream(); stream.CopyTo(bytes); stream.Position = position;
            saves.Add(new { mimeType = values[2], type = values[3]!.ToString(), bytes = Convert.ToBase64String(bytes.ToArray()) });
            return Stub.Forward(manager, method, values);
        }
        return Stub.Default(method.ReturnType);
    });
    var mode = Enum.Parse<MetadataRefreshMode>(Text(sample, "mode") ?? "FullRefresh");
    var refresh = new MetadataRefreshOptions((IDirectoryService)null!) { ImageRefreshMode = mode, ReplaceAllImages = Bool(sample, "replace") };
    if (Text(sample, "search") is string search) refresh.SearchResult = new RemoteSearchResult { SearchProviderName = search };
    var selected = manager.GetImageProviders(book, refresh).ToArray();
    var service = new BookMetadataService(config, NullLogger<BookMetadataService>.Instance, dispatch, fs, library, null!, null!);
    var eligible = ((IEnumerable<IImageProvider>)typeof(BookMetadataService).GetMethod("GetNonLocalImageProviders", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service, [book, selected, refresh])!).ToArray();
    RefreshResult? result = null; string? exception = null;
    try { result = await new ItemImageProvider(NullLogger<ItemImageProvider>.Instance, dispatch, fs).RefreshImages(book, libraryOptions, eligible, refresh, cancellation.Token); }
    catch (Exception error) { exception = error is OperationCanceledException ? "cancelled" : error.GetType().Name; }
    string Project(string value) => value.Replace(root, "$STATE").Replace('\\', '/');
    results.Add(new { name, selected = selected.Select(value => value.Name).ToArray(), eligible = eligible.Select(value => value.Name).ToArray(), calls, saves,
        changed = result is not null && result.UpdateType.HasFlag(ItemUpdateType.ImageUpdate), failures = result?.Failures, errorMessage = result?.ErrorMessage, exception,
        images = book.ImageInfos.Select(image => new { type = image.Type.ToString(), path = Project(image.Path), image.Width, image.Height, image.BlurHash,
            bytes = File.Exists(image.Path) ? Convert.ToBase64String(File.ReadAllBytes(image.Path)) : null }).ToArray(),
        files = Directory.Exists(book.GetInternalMetadataPath()) ? Directory.GetFiles(book.GetInternalMetadataPath()).Order().Select(filename => new { path = Project(filename), bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }).ToArray() : [],
        streams = streams.Select(value => value.Disposed).ToArray() });
    DynamicImageResponse Action(string provider, string action) {
        calls.Add(provider + ":Primary");
        if (action == "cancel-empty") { cancellation.Cancel(); return new DynamicImageResponse(); }
        if (action == "cancel-throw") { cancellation.Cancel(); throw new IOException("Controlled provider failure"); }
        if (action == "none") return new DynamicImageResponse();
        if (action == "throw") throw new IOException("Controlled provider failure");
        if (action == "cancel") throw new OperationCanceledException();
        if (action == "cancel-return") cancellation.Cancel();
        var stream = new OwnedStream(System.Text.Encoding.UTF8.GetBytes(provider)); streams.Add(stream);
        return new DynamicImageResponse { HasImage = true, Stream = stream, Format = ImageFormat.Png };
    }
}
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Hash(inputBytes), results,
    scope = "Actual ProviderManager image selection and BaseItemManager enablement, BookMetadataService.GetNonLocalImageProviders and ItemImageProvider.RefreshImages. Actual ProviderManager stream SaveImage and ImageSaver operate real isolated files. Dynamic/remote provider payloads, logger/config/library interfaces are controlled seams; no book archive decoding, SQL or HTTP is claimed.",
    assemblies = new[] { typeof(Book).Assembly, typeof(BookMetadataService).Assembly, typeof(ManagedFileSystem).Assembly }.Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }) }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var property) ? property.GetString() : null;
static bool Bool(JsonElement value, string key) => value.TryGetProperty(key, out var property) && property.GetBoolean();
static string[] Strings(JsonElement value, string key, string[]? fallback = null) => value.TryGetProperty(key, out var property) ? property.EnumerateArray().Select(value => value.GetString()!).ToArray() : fallback ?? [];
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) { try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public sealed class DynamicProvider(string name, Func<DynamicImageResponse> fetch) : IDynamicImageProvider {
    public string Name => name;
    public bool Supports(BaseItem item) => item is Book;
    public IEnumerable<ImageType> GetSupportedImages(BaseItem item) => [ImageType.Primary];
    public Task<DynamicImageResponse> GetImage(BaseItem item, ImageType type, CancellationToken token) => Task.FromResult(fetch());
}
public sealed class RemoteProvider(string name) : IRemoteImageProvider {
    public string Name => name;
    public bool Supports(BaseItem item) => item is Book;
    public IEnumerable<ImageType> GetSupportedImages(BaseItem item) => [ImageType.Primary];
    public Task<IEnumerable<RemoteImageInfo>> GetImages(BaseItem item, CancellationToken token) => throw new InvalidOperationException("Remote listing belongs to the controlled ProviderManager seam.");
    public Task<HttpResponseMessage> GetImageResponse(string url, CancellationToken token) => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes("R")) { Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png") } } });
}
public sealed class OwnedStream(byte[] bytes) : MemoryStream(bytes) {
    public bool Disposed { get; private set; }
    protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
}
