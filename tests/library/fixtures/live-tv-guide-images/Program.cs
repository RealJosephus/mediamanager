using System.Globalization;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Library;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Guide;
using Jellyfin.LiveTv.Listings;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var outputRoot = Path.GetDirectoryName(args[1])!; Directory.CreateDirectory(outputRoot);
var parallel = (ParallelOptions)typeof(GuideManager).GetField("_cacheParallelOptions", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
var nativeParallelism = parallel.MaxDegreeOfParallelism; parallel.MaxDegreeOfParallelism = 1;
var precache = typeof(GuideManager).GetMethod("PreCacheImages", BindingFlags.Instance | BindingFlags.NonPublic)!;
var results = new List<object>(); using var client = new HttpClient();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    // BaseItem's public serializer intentionally ignores repository fields.
    // Populate declared CLR properties, as a real repository materializer does.
    var programs = sample.GetProperty("items").EnumerateArray().Select(value => {
        var item = new LiveTvProgram();
        foreach (var pair in value.EnumerateObject()) {
            var property = typeof(LiveTvProgram).GetProperty(pair.Name)!;
            property.SetValue(item, pair.Value.Deserialize(property.PropertyType, JsonDefaults.Options));
        }
        return item;
    }).ToArray();
    if (sample.TryGetProperty("repeatSlot", out var repeat)) programs = [.. programs, programs[repeat.GetInt32()]];
    var initialized = programs.Select(item => new { Id = item.Id.ToString("N"), EndDateTicks = item.EndDate?.Ticks.ToString(CultureInfo.InvariantCulture), ImageCount = item.ImageInfos?.Length }).ToArray();
    var original = programs.Select(p => p.ImageInfos?.ToArray()).ToArray();
    var requests = new List<string>(); var updates = new List<object>(); var calls = 0; var errors = new List<string>();
    var limits = sample.GetProperty("limits").EnumerateArray().Select(value => value.GetBoolean()).ToArray();
    var sd = Stub.Make<ISchedulesDirectService>((method, _) => method.Name == "IsImageDailyLimitActive" ? limits[Math.Min(calls++, limits.Length - 1)] : Stub.Default(method.ReturnType));
    var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetField("_logger", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(library, NullLogger<LibraryManager>.Instance);
    var provider = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name != "SaveImage") return Stub.Default(method.ReturnType);
        return Save((BaseItem)values![0]!, (string)values[1]!, (ImageType)values[2]!, (int?)values[3], (CancellationToken)values[4]!);
    });
    async Task Save(BaseItem item, string url, ImageType type, int? index, CancellationToken token) {
        if (token.CanBeCanceled || index != 0) throw new InvalidOperationException("ConvertImageToLocal must use index zero and no request token.");
        requests.Add(new Uri(url).PathAndQuery);
        using var response = await client.GetAsync(url, token);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("Controlled image HTTP failure", null, response.StatusCode);
        var file = Path.Combine(outputRoot, "images", item.Id.ToString("N"), type + ".png"); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllBytes(file, await response.Content.ReadAsByteArrayAsync(token));
        item.SetImagePath(type, index ?? 0, new FileSystemMetadata { FullName = file, LastWriteTimeUtc = DateTime.UnixEpoch });
    }
    typeof(LibraryManager).GetField("_providerManagerFactory", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(library, new Lazy<IProviderManager>(() => provider));
    object[] Images(BaseItem item) => item.ImageInfos.Select(image => image is null ? null! : (object)new { Path = image.Path is null || image.Path.StartsWith("http", StringComparison.OrdinalIgnoreCase) || image.Path.StartsWith("/keep/")
        ? image.Path : "$LOCAL/" + image.Type, Type = image.Type.ToString(), image.Width, image.Height, image.BlurHash }).ToArray();
    var proxy = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "ConvertImageToLocal" => library.ConvertImageToLocal((BaseItem)values![0]!, (ItemImageInfo)values[1]!, (int)values[2]!, (bool)values[3]!),
        "UpdateItemAsync" => Update((BaseItem)values![0]!, (ItemUpdateType)values[2]!, (CancellationToken)values[3]!),
        _ => Stub.Default(method.ReturnType)
    });
    Task Update(BaseItem item, ItemUpdateType reason, CancellationToken token) {
        if (token.CanBeCanceled || reason != ItemUpdateType.ImageUpdate) throw new InvalidOperationException("Independent image save contract changed.");
        updates.Add(new { Id = item.Id.ToString("N"), Images = Images(item) }); return Task.CompletedTask;
    }
    BaseItem.LibraryManager = proxy;
    BaseItem.FileSystem = Stub.Make<IFileSystem>((method, _) => method.Name == "GetLastWriteTimeUtc" ? DateTime.UnixEpoch : Stub.Default(method.ReturnType));
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var logger = new CaptureLogger<GuideManager>(errors);
    var manager = new GuideManager(logger, null!, null!, null!, proxy, null!, null!, null!, sd, null!);
    string? error = null;
    try { await (Task)precache.Invoke(manager, [programs, DateTime.Parse(input.GetProperty("maxCacheDate").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)])!; }
    catch (TargetInvocationException caught) { error = caught.InnerException!.GetType().Name; }
    catch (Exception caught) { error = caught.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), initialized, error, requests, updates, limits = calls, errors,
        items = programs.Select((item, index) => new { Id = item.Id.ToString("N"), Images = item.ImageInfos is null ? null : Images(item),
            aliases = item.ImageInfos?.Select(image => Array.IndexOf(item.ImageInfos, image)).ToArray(),
            originals = original[index]?.Select(image => Array.IndexOf(item.ImageInfos!, image)).ToArray() }).ToArray() });
}
string MetadataPath(BaseItem item) => ((string)item.GetType().GetMethod("GetInternalMetadataPath", BindingFlags.Instance | BindingFlags.NonPublic, null, [typeof(string)], null)!.Invoke(item, ["/METADATA"])!).Replace('\\', '/');
var sampleId = Guid.Parse("a9800000000000000000000000000001");
var assemblies = new[] { typeof(GuideManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly }.Distinct()
    .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualPrivatePreCacheImages = true, actualConvertImageToLocal = true,
    actualNativeEntities = true, actualLoopbackHttp = true, controlledProviderImageWriter = true, controlledRepositorySave = true,
    controlledSdLimit = true, databaseOwnersOpened = false, executorsStarted = false, nativeParallelism, selectedParallelism = parallel.MaxDegreeOfParallelism,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), assemblies,
    programMetadataPath = MetadataPath(new LiveTvProgram { Id = sampleId }), channelMetadataPath = MetadataPath(new LiveTvChannel { Id = sampleId }), results }, options));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class CaptureLogger<T>(List<string> errors) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter) { if (exception is not null) errors.Add(exception.GetType().Name); }
}
