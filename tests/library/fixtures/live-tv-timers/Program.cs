using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Timers;
using MediaBrowser.Common;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var options = JsonDefaults.Options;
var output = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
var privateRoot = Path.Combine(output, "private-timer-inputs");
Directory.CreateDirectory(privateRoot);
void Set(object target, string name, object value) => target.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(target, value);
object Blank(Type type) => RuntimeHelpers.GetUninitializedObject(type);
var bindings = new Dictionary<string, string>();
Guid ItemId(string external, Type type) => (type.FullName + ("Emby" + external + "4").ToLowerInvariant()).GetMD5();
var channelId = ItemId("A", typeof(LiveTvChannel));
var programId = ItemId("P1", typeof(LiveTvProgram));
bindings["channel-A"] = channelId.ToString("N");
bindings["program-P1"] = programId.ToString("N");
var results = new List<object>();
try
{
    foreach (var sample in input.GetProperty("cases").EnumerateArray())
    {
        var directory = Path.Combine(privateRoot, results.Count.ToString());
        Directory.CreateDirectory(Path.Combine(directory, "livetv"));
        File.WriteAllText(Path.Combine(directory, "livetv", "timers.json"), sample.GetProperty("timers").GetRawText());
        File.WriteAllText(Path.Combine(directory, "livetv", "seriestimers.json"), sample.GetProperty("seriesTimers").GetRawText());
        var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_DataPath" ? directory : Stub.Default(method.ReturnType));
        var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
        {
            "get_CommonApplicationPaths" => paths,
            "GetConfiguration" => new LiveTvOptions { PrePaddingSeconds = -3, PostPaddingSeconds = 12 },
            _ => Stub.Default(method.ReturnType)
        });
        var channel = new LiveTvChannel { Id = channelId, Name = "Controlled channel", ExternalId = "A", ServiceName = "Emby" };
        var program = new LiveTvProgram { Id = programId, Name = "Controlled program", ExternalId = "P1", ChannelId = channelId,
            StartDate = new DateTime(2500, 1, 1, 1, 2, 3, DateTimeKind.Utc), EndDate = new DateTime(2500, 1, 1, 2, 2, 3, DateTimeKind.Utc), Overview = "Program overview" };
        var library = Stub.Make<ILibraryManager>((method, values) =>
        {
            if (method.Name == "GetNewItemId") return (((Type)values![1]!).FullName + (string)values[0]!).GetMD5();
            if (method.Name == "GetItemById")
            {
                var key = values![0] is Guid guid ? guid : Guid.Parse((string)values[0]!);
                return key == channelId ? channel : key == programId ? program : null;
            }
            if (method.Name == "GetItemList") return Array.Empty<BaseItem>();
            return Stub.Default(method.ReturnType);
        });
        var appHost = Stub.Make<IApplicationHost>((method, _) => method.Name == "get_SystemId" ? "timer-component-server" : Stub.Default(method.ReturnType));
        var baseDto = new BaseItemDto { Id = programId, Name = "Controlled program", ChannelId = channelId, ChannelName = channel.Name,
            Status = "New", TimerId = "initial-timer", SeriesTimerId = "initial-series" };
        var baseDtoJson = JsonSerializer.SerializeToElement(baseDto, options);
        var dto = Stub.Make<IDtoService>((method, _) => method.Name == "GetBaseItemDto"
            ? baseDtoJson.Deserialize<BaseItemDto>(options) : Stub.Default(method.ReturnType));
        var tvDto = new LiveTvDtoService(dto, null!, NullLogger<LiveTvDtoService>.Instance, appHost, library);
        var service = (DefaultLiveTvService)Blank(typeof(DefaultLiveTvService));
        Set(service, "_timerManager", new TimerManager(NullLogger<TimerManager>.Instance, config));
        Set(service, "_seriesTimerManager", new SeriesTimerManager(NullLogger<SeriesTimerManager>.Instance, config));
        Set(service, "_config", config);
        var manager = (LiveTvManager)Blank(typeof(LiveTvManager));
        Set(manager, "_services", new ILiveTvService[] { service });
        Set(manager, "_logger", NullLogger<LiveTvManager>.Instance);
        Set(manager, "_tvDtoService", tvDto);
        Set(manager, "_libraryManager", library);
        Set(manager, "_dtoService", dto);
        string Resolve(string value)
        {
            if (value.StartsWith("@timer:")) return tvDto.GetInternalTimerId(value[7..]);
            if (value.StartsWith("@series:")) return tvDto.GetInternalSeriesTimerId(value[8..]).ToString("N");
            if (value == "@channel:A") return channelId.ToString("N");
            if (value == "@program:P1") return programId.ToString("N");
            return value;
        }
        var observations = new List<object>();
        foreach (var request in sample.GetProperty("requests").EnumerateArray())
        {
            object? value = null;
            string? error = null;
            var operation = request.GetProperty("operation").GetString();
            try
            {
                if (operation == "timers")
                {
                    var query = request.TryGetProperty("query", out var source) ? source.Deserialize<TimerQuery>(options)! : new TimerQuery();
                    if (query.ChannelId is not null) query.ChannelId = Resolve(query.ChannelId);
                    if (query.SeriesTimerId is not null) query.SeriesTimerId = Resolve(query.SeriesTimerId);
                    value = await manager.GetTimers(query, CancellationToken.None);
                }
                else if (operation == "timer") value = await manager.GetTimer(Resolve(request.GetProperty("id").GetString()!), CancellationToken.None);
                else if (operation == "series") value = await manager.GetSeriesTimers(request.TryGetProperty("query", out var seriesQuery)
                    ? seriesQuery.Deserialize<SeriesTimerQuery>(options)! : new SeriesTimerQuery(), CancellationToken.None);
                else if (operation == "seriesTimer") value = await manager.GetSeriesTimer(Resolve(request.GetProperty("id").GetString()!), CancellationToken.None);
                else if (operation == "defaults") value = request.TryGetProperty("id", out var defaultProgram)
                    ? await manager.GetNewTimerDefaults(Resolve(defaultProgram.GetString()!), CancellationToken.None)
                    : await manager.GetNewTimerDefaults(CancellationToken.None);
                else throw new InvalidOperationException("Unknown component request.");
            }
            catch (Exception caught) { error = caught.GetType().Name; }
            observations.Add(new { name = request.GetProperty("name").GetString(), value, error });
        }
        results.Add(new { name = sample.GetProperty("name").GetString(), programDtoInput = baseDtoJson, observations });
    }
}
finally { Directory.Delete(privateRoot, true); }
var assemblies = new[] { typeof(LiveTvManager).Assembly, typeof(LiveTvDtoService).Assembly, typeof(TimerInfo).Assembly,
    typeof(JsonDefaults).Assembly }.Distinct().Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualLiveTvManager = true, actualTimerDtoService = true, actualItemDataProvider = true, recordingExecutorsStarted = false,
    programDtoAndImageQueryControlled = true, privateInputsRemoved = !Directory.Exists(privateRoot), bindings, results, assemblies }, options));

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
