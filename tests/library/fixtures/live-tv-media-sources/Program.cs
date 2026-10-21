using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.TunerHosts;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var sourceFields = input.GetProperty("sourceFields").EnumerateArray().Select(value => value.GetString()!).ToArray();
var streamFields = input.GetProperty("streamFields").EnumerateArray().Select(value => value.GetString()!).ToArray();
object Project(MediaSourceInfo source) {
    var fields = sourceFields.ToDictionary(name => name, name => typeof(MediaSourceInfo).GetProperty(name)!.GetValue(source));
    fields["DefaultAudioIndexSource"] = (int)source.DefaultAudioIndexSource;
    fields["MediaStreams"] = source.MediaStreams?.Select(stream => streamFields.ToDictionary(name => name,
        name => typeof(MediaStream).GetProperty(name)!.GetValue(stream))).ToArray();
    return fields;
}
var settings = new ServerConfiguration();
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? settings : Stub.Default(method.ReturnType));
BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
var localization = Stub.Make<ILocalizationManager>((method, values) => method.Name == "FindLanguageInfo" ? Language((string)values![0]!) : Stub.Default(method.ReturnType));
BaseItem.LocalizationManager = localization;
CultureDto? Language(string language) => language.ToLowerInvariant() switch {
    "en" or "eng" or "english" => new("English", "English", "en", ["eng"]),
    "zh" or "zho" or "chi" or "chinese" => new("Chinese", "Chinese", "zh", ["zho", "chi"]),
    "ja" or "jpn" or "japanese" => new("Japanese", "Japanese", "ja", ["jpn"]), _ => null
};
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
    "GetApiUrlForLocalAccess" => input.GetProperty("localApiUrl").GetString(),
    "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], _ => Stub.Default(method.ReturnType)
});
var dynamicMethod = typeof(MediaSourceManager).GetMethod("GetDynamicMediaSources", BindingFlags.Instance | BindingFlags.NonPublic,
    null, [typeof(BaseItem), typeof(IMediaSourceProvider), typeof(CancellationToken)], null)!;
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var item = new LiveTvChannel();
    // BaseItem marks repository fields JsonIgnore. Assign the declared typed
    // fixture inputs through their actual setters, then capture the real mapper.
    foreach (var property in sample.GetProperty("item").EnumerateObject()) {
        var field = typeof(LiveTvChannel).GetProperty(property.Name)!;
        field.SetValue(item, property.Value.Deserialize(field.PropertyType, JsonDefaults.Options));
    }
    var row = BaseItemMapper.Map(item, appHost);
    var prepared = sample.GetProperty("sources").Deserialize<List<MediaSourceInfo>>(JsonDefaults.Options)!;
    // Snapshot real DTO constructor/deserializer values before Normalize can
    // mutate them. Node consumes these same input objects at its tuner boundary.
    var preparedSources = JsonSerializer.SerializeToElement(prepared, options);
    using var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("preCancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    var calls = new List<object>(); var errors = new List<string>(); var stage = "direct";
    var recordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo"
        ? null : throw new InvalidOperationException("Recording executor is outside discovery: " + method.Name));
    var library = Stub.Make<ILibraryManager>((method, _) => method.Name == "GetItemById"
        ? item : throw new InvalidOperationException("Unexpected library operation: " + method.Name));
    var data = sample.TryGetProperty("userData", out var dataInput)
        ? dataInput.Deserialize<UserItemData>(JsonDefaults.Options)! : new UserItemData { Key = item.Id.ToString("D") };
    var userData = Stub.Make<IUserDataManager>((method, _) => method.Name == "GetUserData"
        ? data : throw new InvalidOperationException("Unexpected user-data operation: " + method.Name));
    var tuner = Stub.Make<ITunerHost>((method, values) => method.Name switch {
        "get_IsSupported" => true, "get_Type" or "get_Name" => "controlled-discovery",
        "GetChannelStreamMediaSources" => Sources((string)values![0]!, (CancellationToken)values[1]!),
        _ => throw new InvalidOperationException("Tuner executor is outside discovery: " + method.Name)
    });
    Task<List<MediaSourceInfo>> Sources(string id, CancellationToken token) {
        calls.Add(new { stage, id, cancelled = token.IsCancellationRequested });
        if (sample.TryGetProperty("failure", out var failure)) return Task.FromException<List<MediaSourceInfo>>(failure.GetString() switch {
            "NotImplementedException" => new NotImplementedException(), "NotSupportedException" => new NotSupportedException(),
            "OperationCanceledException" => new OperationCanceledException(token), "IOException" => new IOException("Controlled discovery failure."),
            _ => throw new InvalidOperationException("Unknown controlled failure.")
        });
        return Task.FromResult(sample.GetProperty("sources").Deserialize<List<MediaSourceInfo>>(JsonDefaults.Options)!);
    }
    var tunerManager = new TunerHostManager(NullLogger<TunerHostManager>.Instance, config,
        Stub.Make<ITaskManager>((method, _) => Stub.Default(method.ReturnType)), [tuner]);
    // Its constructor subscribes to TimerFired. Initialize only the real reader
    // dependency, so this fixture cannot create a recording timer/executor.
    var service = (DefaultLiveTvService)RuntimeHelpers.GetUninitializedObject(typeof(DefaultLiveTvService));
    typeof(DefaultLiveTvService).GetField("_tunerHostManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, tunerManager);
    typeof(DefaultLiveTvService).GetField("_logger", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, NullLogger<DefaultLiveTvService>.Instance);
    using var manager = new MediaSourceManager(appHost, null!, null!, localization, null!, library,
        new CaptureLogger<MediaSourceManager>(error => errors.Add(error.GetType().Name)), null!, userData, null!, null!, null!, null!);
    BaseItem.MediaSourceManager = manager;
    var provider = new LiveTvMediaSourceProvider(NullLogger<LiveTvMediaSourceProvider>.Instance, appHost, recordings, manager, library, [service]);
    manager.AddParts([provider]);
    User? user = null;
    if (sample.TryGetProperty("user", out var userInput)) {
        user = new User("discovery", "controlled", "controlled") { Id = Guid.Parse(input.GetProperty("userId").GetString()!) };
        foreach (var property in userInput.GetProperty("configuration").EnumerateObject()) {
            var field = typeof(User).GetProperty(property.Name)!;
            field.SetValue(user, property.Value.Deserialize(field.PropertyType, JsonDefaults.Options));
        }
        foreach (var permission in userInput.GetProperty("policy").EnumerateObject())
            user.Permissions.Add(new Permission(Enum.Parse<PermissionKind>(permission.Name), permission.Value.GetBoolean()));
    }
    var staticSources = manager.GetStaticMediaSources(item, true, user).Select(Project).ToArray();
    object[]? direct = null; string? directError = null;
    try { direct = (await provider.GetMediaSources(item, cancellation.Token)).Select(Project).ToArray(); }
    catch (Exception error) { directError = error.GetType().Name; }
    stage = "dynamic";
    var dynamicSources = await (Task<IEnumerable<MediaSourceInfo>>)dynamicMethod.Invoke(manager, [item, provider, cancellation.Token])!;
    var dynamicSnapshot = dynamicSources.Select(Project).ToArray();
    var dynamicErrors = errors.ToArray(); errors.Clear(); stage = "playback";
    var playback = await manager.GetPlaybackMediaSources(item, user, false, true, cancellation.Token);
    results.Add(new { name = sample.GetProperty("name").GetString(), preparedSources, row,
        enableRememberingTrackSelections = item.EnableRememberingTrackSelections,
        staticSources, direct, directError, dynamicSources = dynamicSnapshot, dynamicErrors,
        playbackSources = playback.Select(Project).ToArray(), playbackErrors = errors.ToArray(), calls });
}
// Third-party normalization is measured as a native-only boundary. This task's
// Node producer is the default service; no plugin execution is implied.
var thirdPartySource = input.GetProperty("thirdPartySource").Deserialize<MediaSourceInfo>(JsonDefaults.Options)!;
var thirdParty = Stub.Make<ILiveTvService>((method, _) => method.Name == "get_Name" ? "Controlled plugin" : throw new InvalidOperationException("Third-party execution is forbidden."));
typeof(LiveTvMediaSourceProvider).GetMethod("Normalize", BindingFlags.Static | BindingFlags.NonPublic)!
    .Invoke(null, [thirdPartySource, thirdParty, true]);
var assemblies = new[] { typeof(LiveTvMediaSourceProvider).Assembly, typeof(MediaSourceManager).Assembly,
    typeof(BaseItemMapper).Assembly, typeof(LiveTvChannel).Assembly, typeof(MediaSourceInfo).Assembly, typeof(User).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    actualDefaultService = true, actualLiveTvMediaSourceProvider = true, actualMediaSourceManager = true,
    actualChannelAndBaseItemMapper = true, constructorTimerSubscriptionBypassed = true,
    tunerResponsesControlled = true, userDataLookupControlled = true, nativePersistenceOpened = false,
    recordingExecutorsStarted = false, mediaStreamsOpened = false, mediaProbeEnabled = false,
    results, thirdPartyNativeOnly = Project(thirdPartySource), assemblies }, options));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class CaptureLogger<T>(Action<Exception> observe) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
        if (level >= LogLevel.Error && error is not null) observe(error);
    }
}
