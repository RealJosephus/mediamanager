using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var directory = Path.GetFullPath(Path.Combine(args[2], name));
    Directory.CreateDirectory(directory);
    string Expand(string path) => Path.Combine(directory, path.Replace('/', Path.DirectorySeparatorChar));
    string Normalize(string path) => path.Replace(directory, "$ROOT", StringComparison.Ordinal);
    var calls = new List<Trace>();
    void Trace(string action, string path) => calls.Add(new(action, Normalize(path)));
    foreach (var change in sample.GetProperty("changes").EnumerateArray()) Directory.CreateDirectory(Expand(change.GetString()!));
    if (sample.TryGetProperty("ignoreDirectories", out var ignored))
        foreach (var value in ignored.EnumerateArray()) File.WriteAllText(Path.Combine(Expand(value.GetString()!), ".ignore"), "");
    var appPaths = Stub.Make<IApplicationPaths>((method, _) => method.Name == "get_TempDirectory" ? directory : Stub.Default(method.ReturnType));
    var fileSystem = new RecordingFileSystem(appPaths, path => Trace("info", path));
    var directoryService = Stub.Make<IDirectoryService>((method, values) => {
        if (method.Name == "Invalidate") Trace("invalidate", (string)values![0]!);
        return Stub.Default(method.ReturnType);
    });
    var logger = new RecordingLogger((error) => Trace("error", error.Message));
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "FindByPath") {
            var path = (string)values![0]!; Trace("lookup", path);
            if (sample.TryGetProperty("lookupFailure", out var fail) && path == Expand(fail.GetString()!)) throw new IOException("lookup");
            var sameId = sample.TryGetProperty("sameItemId", out var same) && same.GetBoolean();
            var id = new Guid(MD5.HashData(Encoding.UTF8.GetBytes(sameId ? "same" : path.ToUpperInvariant())));
            if (sample.TryGetProperty("aggregateItem", out var aggregate) && path == Expand(aggregate.GetString()!))
                return new AggregateFolder { Id = id, Path = path };
            return new RecordingFolder { Id = id, Path = path, Name = path,
                Changed = () => {
                    Trace("refresh", path);
                    if (sample.TryGetProperty("refreshFailure", out var refreshFailure) && path == Expand(refreshFailure.GetString()!)) throw new IOException("refresh");
                } };
        }
        return Stub.Default(method.ReturnType);
    });
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration"
        ? new ServerConfiguration { LibraryMonitorDelay = 3600 } : Stub.Default(method.ReturnType));
    var lifetime = Stub.Make<IHostApplicationLifetime>((method, _) => method.ReturnType == typeof(CancellationToken) ? CancellationToken.None : Stub.Default(method.ReturnType));
    using var monitor = new LibraryMonitor(logger, library, config, fileSystem, directoryService, lifetime, new DotIgnoreIgnoreRule());
    if (sample.TryGetProperty("begin", out var beginnings)) foreach (var value in beginnings.EnumerateArray()) monitor.ReportFileSystemChangeBeginning(Expand(value.GetString()!));
    foreach (var change in sample.GetProperty("changes").EnumerateArray()) monitor.ReportFileSystemChanged(Expand(change.GetString()!));
    if (sample.TryGetProperty("stop", out var stop) && stop.GetBoolean()) monitor.Stop();
    var refreshers = ((IEnumerable)typeof(LibraryMonitor).GetField("_activeRefreshers", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(monitor)!).Cast<FileRefresher>().ToArray();
    var fire = typeof(FileRefresher).GetMethod("OnTimerCallback", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var eventCalls = calls.ToArray(); calls.Clear();
    var batches = new List<Trace[]>();
    foreach (var refresher in refreshers) { fire.Invoke(refresher, [null]); batches.Add(calls.ToArray()); calls.Clear(); }
    results.Add(new { name, eventCalls, batches });
}
var assemblies = new[] { typeof(LibraryMonitor).Assembly, typeof(BaseItem).Assembly, typeof(object).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualLibraryMonitor = true, actualFileRefresher = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    windows = OperatingSystem.IsWindows(), assemblies, results,
    scope = "Actual LibraryMonitor ReportFileSystemChanged, temporary suppression, core/.ignore filtering, affected-path coalescing, Stop, FileRefresher timer completion, lookup failure continuation, ID deduplication, AggregateFolder exclusion and per-item refresh failure continuation. ManagedFileSystem and .ignore read real isolated directories. Timer callbacks are invoked directly after events; library lookup and ChangedExternally are controlled. No native watcher, forty-five-second wall-clock wait, production SQL/provider dispatch, or release acceptance."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public record Trace(string action, string path);
public class RecordingFolder : Folder { public Action Changed = null!; public override void ChangedExternally() => Changed(); }
public class RecordingFileSystem(IApplicationPaths paths, Action<string> info) : ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []) {
    public override FileSystemMetadata GetFileSystemInfo(string path) { info(path); return base.GetFileSystemInfo(path); }
}
public class RecordingLogger(Action<Exception> onError) : ILogger<LibraryMonitor> {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState,Exception?,string> formatter) { if (error is not null) onError(error); }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T : class { var value = Create<T,Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
