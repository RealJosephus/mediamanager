using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.IO;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Recordings;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var json = new JsonSerializerOptions(JsonDefaults.Options) { WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var results = new List<object>();
foreach (var sample in input.EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.GetFullPath(Path.Combine(args[1], name));
    var data = Path.Combine(root, "data");
    Directory.CreateDirectory(data);
    string Map(string value) => value.Replace("{data}", data, StringComparison.Ordinal).Replace('/', Path.DirectorySeparatorChar);
    foreach (var value in sample.GetProperty("directories").EnumerateArray()) Directory.CreateDirectory(Map(value.GetString()!));
    var configuration = sample.GetProperty("configuration").Deserialize<LiveTvOptions>(JsonDefaults.Options)!;
    if (configuration.RecordingPath is not null) configuration.RecordingPath = Map(configuration.RecordingPath);
    if (configuration.MovieRecordingPath is not null) configuration.MovieRecordingPath = Map(configuration.MovieRecordingPath);
    if (configuration.SeriesRecordingPath is not null) configuration.SeriesRecordingPath = Map(configuration.SeriesRecordingPath);
    if (configuration.MediaLocationsCreated is not null) configuration.MediaLocationsCreated = configuration.MediaLocationsCreated.Select(value => value is null ? null! : Map(value)).ToArray();
    var folders = sample.GetProperty("folders").Deserialize<VirtualFolderInfo[]>(JsonDefaults.Options)!.ToList();
    foreach (var folder in folders) folder.Locations = folder.Locations.Select(Map).ToArray();
    var calls = new List<object>();
    void Trace(string action, object? value = null) => calls.Add(new { action, value = JsonSerializer.SerializeToElement(value, json) });
    var failure = sample.TryGetProperty("failure", out var failureValue) ? failureValue.GetString() : null;
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name == "get_DataPath" ? data : Stub.Default(method.ReturnType));
    var configurationManager = Stub.Make<IServerConfigurationManager>((method, parameters) =>
    {
        if (method.Name is "get_ApplicationPaths" or "get_CommonApplicationPaths") return paths;
        if (method.Name == "GetConfiguration") return configuration;
        if (method.Name == "SaveConfiguration")
        {
            Trace("save", new { key = parameters![0], configuration });
            if (failure == "save") throw new IOException("Controlled save failure.");
        }
        return Stub.Default(method.ReturnType);
    });
    var manager = Stub.Make<ILibraryManager>((method, parameters) =>
    {
        if (method.Name == "GetVirtualFolders")
        {
            Trace("get-folders");
            if (failure == "get-folders") throw new IOException("Controlled listing failure.");
            return folders.ToList();
        }
        if (method.Name == "AddVirtualFolder")
        {
            var libraryName = (string)parameters![0]!;
            var type = parameters[1];
            var options = (LibraryOptions)parameters[2]!;
            Trace("add", new { name = libraryName, type, options, refresh = parameters[3] });
            if (failure == "add") throw new IOException("Controlled add failure.");
            folders.Add(new VirtualFolderInfo { Name = libraryName, CollectionType = (CollectionTypeOptions?)type,
                Locations = options.PathInfos.Select(info => info.Path).ToArray() });
            return Task.CompletedTask;
        }
        if (method.Name == "RemoveVirtualFolder")
        {
            var libraryName = (string)parameters![0]!;
            Trace("remove-folder", new { name = libraryName, refresh = parameters[1] });
            if (failure == "remove-folder") throw new IOException("Controlled removal failure.");
            folders.RemoveAll(folder => folder.Name == libraryName);
            return Task.CompletedTask;
        }
        if (method.Name == "RemoveMediaPath")
        {
            var libraryName = (string)parameters![0]!;
            var location = (string)parameters[1]!;
            Trace("remove-path", new { name = libraryName, path = location });
            if (failure == "remove-path") throw new IOException("Controlled path removal failure.");
            var folder = folders.First(value => value.Name == libraryName);
            folder.Locations = folder.Locations.Where(value => value != location).ToArray();
        }
        if (method.Name == "QueueLibraryScan") Trace("scan");
        return Stub.Default(method.ReturnType);
    });
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var errors = new List<string>();
    using var recordings = new RecordingsManager(new ControlledLogger(errors), configurationManager, null!, fileSystem,
        manager, null!, null!, null!, null!, null!, null!, null!, null!);
    await recordings.CreateRecordingFolders();
    results.Add(new { name, root, calls, configuration, folders, errors = errors.Count,
        existing = Directory.EnumerateDirectories(data, "*", SearchOption.AllDirectories).Select(value => Path.GetRelativePath(data, value)).Order(StringComparer.Ordinal).ToArray() });
}
var assemblies = new[] { typeof(RecordingsManager).Assembly, typeof(LiveTvOptions).Assembly, typeof(ManagedFileSystem).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualRecordingsManager = true, realDirectoryExistence = true, controlledConfigurationAndLibraryManager = true, results, assemblies }, json));

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask
        : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class ControlledLogger(List<string> errors) : ILogger<RecordingsManager>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    { if (level >= LogLevel.Error) errors.Add(formatter(state, exception)); }
}
