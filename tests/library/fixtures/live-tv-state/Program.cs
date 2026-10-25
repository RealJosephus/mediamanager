using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv;
using Jellyfin.LiveTv.Timers;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var outputRoot = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
var privateRoot = Path.Combine(outputRoot, "private-inputs");
Directory.CreateDirectory(privateRoot);
var documents = new List<object>();
var lookups = new List<object>();
string Wall(DateTime value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
object? Project(TimerInfo? item) => item is null ? null : new { id = item.Id, name = item.Name, programId = item.ProgramId,
    seriesId = item.SeriesId, seriesTimerId = item.SeriesTimerId, startDate = Wall(item.StartDate), status = item.Status.ToString() };
object? ProjectSeries(SeriesTimerInfo? item) => item is null ? null : new { id = item.Id, name = item.Name, programId = item.ProgramId,
    seriesId = item.SeriesId, seriesTimerId = (string?)null, startDate = Wall(item.StartDate), status = "New" };
void Set(object target, string field, object value) => target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
object Blank(Type type) => RuntimeHelpers.GetUninitializedObject(type);
byte[] Bytes(JsonElement sample, string text, string hex) => sample.TryGetProperty(hex, out var raw)
    ? Convert.FromHexString(raw.GetString()!) : Encoding.UTF8.GetBytes(sample.GetProperty(text).GetString()!);
try
{
    foreach (var sample in input.GetProperty("documents").EnumerateArray())
    {
        var filename = Path.Combine(privateRoot, "document.json");
        File.WriteAllBytes(filename, Bytes(sample, "text", "bytesHex"));
        object? entries = null;
        string? error = null;
        try
        {
            if (sample.GetProperty("kind").GetString() == "timers")
                entries = new ItemDataProvider<TimerInfo>(NullLogger.Instance, filename, (_, _) => false).GetAll().Select(Project).ToArray();
            else entries = new ItemDataProvider<SeriesTimerInfo>(NullLogger.Instance, filename, (_, _) => false).GetAll().Select(ProjectSeries).ToArray();
        }
        catch (Exception caught) { error = caught.GetType().Name; }
        documents.Add(new { name = sample.GetProperty("name").GetString(), entries, error });
    }
    foreach (var sample in input.GetProperty("lookups").EnumerateArray())
    {
        var directory = Path.Combine(privateRoot, "lookup-" + lookups.Count);
        Directory.CreateDirectory(Path.Combine(directory, "livetv"));
        File.WriteAllBytes(Path.Combine(directory, "livetv/timers.json"), Bytes(sample, "timers", "timersHex"));
        File.WriteAllBytes(Path.Combine(directory, "livetv/seriestimers.json"), Bytes(sample, "seriesTimers", "seriesTimersHex"));
        var paths = DispatchProxy.Create<IApplicationPaths, ValueProxy>();
        ((ValueProxy)(object)paths).Values["get_DataPath"] = directory;
        var config = DispatchProxy.Create<IConfigurationManager, ValueProxy>();
        ((ValueProxy)(object)config).Values["get_CommonApplicationPaths"] = paths;
        var service = (DefaultLiveTvService)Blank(typeof(DefaultLiveTvService));
        Set(service, "_timerManager", new TimerManager(NullLogger<TimerManager>.Instance, config));
        Set(service, "_seriesTimerManager", new SeriesTimerManager(NullLogger<SeriesTimerManager>.Instance, config));
        var manager = (LiveTvManager)Blank(typeof(LiveTvManager));
        Set(manager, "_services", new ILiveTvService[] { service });
        Set(manager, "_logger", NullLogger<LiveTvManager>.Instance);
        Set(manager, "_tvDtoService", Blank(typeof(LiveTvDtoService)));
        var tuples = sample.GetProperty("programs").EnumerateArray().Select(program => (
            ItemDto: new BaseItemDto { Id = Guid.Parse(program.GetProperty("id").GetString()!) },
            ExternalId: program.GetProperty("externalId").GetString()!,
            ExternalSeriesId: program.GetProperty("externalSeriesId").GetString()!)).ToArray();
        string? error = null;
        try
        {
            await (Task)typeof(LiveTvManager).GetMethod("AddRecordingInfo", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(manager, new object[] { tuples, CancellationToken.None })!;
        }
        catch (Exception caught)
        {
            while (caught is TargetInvocationException && caught.InnerException is not null) caught = caught.InnerException;
            error = caught.GetType().Name;
        }
        lookups.Add(new { name = sample.GetProperty("name").GetString(), error, items = tuples.Select(tuple => new {
            id = tuple.ItemDto.Id.ToString("N"), tuple.ItemDto.TimerId, tuple.ItemDto.SeriesTimerId, tuple.ItemDto.Status }).ToArray() });
    }
}
finally
{
    if (Path.GetDirectoryName(privateRoot) != outputRoot || Path.GetFileName(privateRoot) != "private-inputs") throw new Exception("Private input path escaped its output root.");
    Directory.Delete(privateRoot, true);
}
var assemblies = new[] { typeof(TimerInfo).Assembly, typeof(LiveTvManager).Assembly, typeof(JsonDefaults).Assembly, typeof(BaseItemDto).Assembly }
    .Distinct().Select(assembly => new { assembly.FullName, filename = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualItemDataProvider = true, actualRecordingInfo = true, recordingExecutorsStarted = false, privateInputsRemoved = !Directory.Exists(privateRoot),
    caseInsensitiveProperties = JsonDefaults.Options.PropertyNameCaseInsensitive, assemblies, documents, lookups }, JsonDefaults.Options));

public class ValueProxy : DispatchProxy
{
    public Dictionary<string, object> Values { get; } = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Values.TryGetValue(method!.Name, out var value)
        ? value : throw new NotSupportedException(method.Name);
}
