using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.ScheduledTasks;
using Emby.Server.Implementations.ScheduledTasks.Tasks;
using Emby.Server.Implementations.ScheduledTasks.Triggers;
using Jellyfin.Api.Controllers;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Guide;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var privateRoot = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "private-guide-task");
var configPath = Path.Combine(privateRoot, "config"); var dataPath = Path.Combine(privateRoot, "data");
Directory.CreateDirectory(configPath); Directory.CreateDirectory(dataPath);
var paths = Stub.Make<IApplicationPaths>((method, _) => method.Name switch {
    "get_ConfigurationDirectoryPath" => configPath, "get_DataPath" => dataPath,
    "get_ProgramDataPath" => privateRoot, _ => Stub.Default(method.ReturnType) });
var serviceCount = 1; var configurationReads = 0; var configurationFailure = false;
var liveOptions = new LiveTvOptions();
var configuration = Stub.Make<IConfigurationManager>((method, _) => {
    if (method.Name != "GetConfiguration") return Stub.Default(method.ReturnType);
    configurationReads++;
    if (configurationFailure) throw new IOException("Controlled guide configuration failure.");
    return liveOptions;
});
var liveTv = Stub.Make<ILiveTvManager>((method, _) => method.Name == "get_Services"
    ? Enumerable.Repeat<ILiveTvService>(null!, serviceCount).ToArray() : Stub.Default(method.ReturnType));
var mode = "completed"; var calls = new List<object>();
var guide = Stub.Make<IGuideManager>((method, values) => {
    if (method.Name != "RefreshGuide") return Stub.Default(method.ReturnType);
    var progress = (IProgress<double>)values![0]!; var signal = (CancellationToken)values[1]!;
    calls.Add(new { mode, canBeCanceled = signal.CanBeCanceled, canceled = signal.IsCancellationRequested });
    progress.Report(12.5); progress.Report(100);
    return mode switch {
        "failed" => Task.FromException(new IOException("Controlled guide refresh failure.")),
        "canceled" => Task.FromCanceled(new CancellationToken(true)), _ => Task.CompletedTask
    };
});
var library = Stub.Make<ILibraryManager>((method, _) => Stub.Default(method.ReturnType));
var text = new Dictionary<string, string> { ["TaskRefreshLibrary"] = "Scan Media Library",
    ["TaskRefreshLibraryDescription"] = "Scans your media library for new files and refreshes metadata.", ["TasksLibraryCategory"] = "Library" };
var localization = Stub.Make<ILocalizationManager>((method, values) => method.Name == "GetLocalizedString"
    ? text[(string)values![0]!] : Stub.Default(method.ReturnType));
var task = new RefreshGuideScheduledTask(liveTv, guide, configuration);
var observations = new List<object>(); var executions = new List<object>(); object? disabledTrigger = null;
try {
    using (var manager = new TaskManager(paths, NullLogger<TaskManager>.Instance)) {
        var disabled = new DisabledTask();
        manager.AddTasks([new RefreshMediaLibraryTask(library, localization), task, disabled]);
        var controller = new ScheduledTasksController(manager);
        foreach (var state in input.GetProperty("states").EnumerateArray()) {
            serviceCount = state.GetProperty("serviceCount").GetInt32();
            liveOptions.TunerHosts = state.GetProperty("tunerHosts").Deserialize<TunerHostInfo[]>(JsonDefaults.Options)!;
            configurationFailure = state.TryGetProperty("configurationFailure", out var fail) && fail.GetBoolean();
            foreach (var filter in input.GetProperty("filters").EnumerateArray()) {
                bool? hidden = filter.TryGetProperty("isHidden", out var h) ? h.GetBoolean() : null;
                bool? enabled = filter.TryGetProperty("isEnabled", out var e) ? e.GetBoolean() : null;
                object? value = null; string? error = null; configurationReads = 0;
                try { value = controller.GetTasks(hidden, enabled).ToArray(); } catch (Exception cause) { error = cause.GetType().Name; }
                observations.Add(new { name = state.GetProperty("name").GetString(), filter, value, error, configurationReads });
            }
        }
        serviceCount = 1; liveOptions.TunerHosts = []; configurationFailure = false;
        var worker = (ScheduledTaskWorker)manager.ScheduledTasks.Single(value => value.ScheduledTask == task);
        foreach (var selected in input.GetProperty("executionModes").EnumerateArray()) {
            mode = selected.GetString()!; calls.Clear();
            await worker.Execute(new TaskOptions());
            var historyFile = Path.Combine(dataPath, "ScheduledTasks", new Guid(worker.Id) + ".js");
            var historyBytes = File.ReadAllBytes(historyFile);
            executions.Add(new { mode, calls = calls.ToArray(), info = ScheduledTaskHelpers.GetTaskInfo(worker),
                history = JsonDocument.Parse(historyBytes).RootElement.Clone(), historySha256 = Hash(historyBytes) });
        }
        var disabledWorker = (ScheduledTaskWorker)manager.ScheduledTasks.Single(value => value.ScheduledTask == disabled);
        disabledWorker.Triggers = [new TaskTriggerInfo { Type = TaskTriggerInfoType.IntervalTrigger, IntervalTicks = TimeSpan.FromDays(1).Ticks }];
        var entries = (Array)typeof(ScheduledTaskWorker).GetField("_triggers", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(disabledWorker)!;
        var tuple = entries.GetValue(0)!;
        var trigger = (IntervalTrigger)tuple.GetType().GetProperty("Item2")!.GetValue(tuple)!;
        disabled.EnabledReads = 0;
        typeof(IntervalTrigger).GetMethod("OnTriggered", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(trigger, null);
        disabledTrigger = new { enabledReads = disabled.EnabledReads, executionCalls = disabled.ExecutionCalls,
            timerReleased = typeof(IntervalTrigger).GetField("_timer", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(trigger) is null };
    }
} finally { Directory.Delete(privateRoot, true); }
var assemblies = new[] { typeof(RefreshGuideScheduledTask).Assembly, typeof(ScheduledTaskWorker).Assembly,
    typeof(ScheduledTasksController).Assembly, typeof(ScheduledTaskHelpers).Assembly }.Distinct().Select(assembly => new {
        filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Hash(bytes), actualRefreshGuideScheduledTask = true,
    actualScheduledTaskWorker = true, actualScheduledTasksController = true,
    task = new { type = task.GetType().FullName, task.Name, task.Description, task.Category, task.Key, task.IsEnabled, task.IsLogged,
        triggers = task.GetDefaultTriggers() }, observations, executions, disabledTrigger, assemblies, privateInputsRemoved = !Directory.Exists(privateRoot) }, JsonDefaults.Options));
static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));

public sealed class DisabledTask : IScheduledTask, IConfigurableScheduledTask {
    public string Name => "Disabled controlled task"; public string Description => "Controlled configurable filtering.";
    public string Category => "Controlled"; public string Key => "ControlledDisabled";
    public int EnabledReads { get; set; } public int ExecutionCalls { get; private set; }
    public bool IsEnabled { get { EnabledReads++; return false; } } public bool IsHidden => false; public bool IsLogged => true;
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => [];
    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken) { ExecutionCalls++; return Task.CompletedTask; }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
