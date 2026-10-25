using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Naming.Common;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Serialization;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;

if (args[0] == "hold-file") { FileSharingProbe.Hold(args); return; }

SynchronizationContext.SetSynchronizationContext(new InlineContext());
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    CollectionFolder.OnCollectionFolderChange();
    var key = sample.GetProperty("key").GetString()!;
    var consume = sample.TryGetProperty("consumerState", out var consumerState);
    string state = Path.GetFullPath(consume ? consumerState.GetString()! : Path.Combine(args[1], key)), program = Path.Combine(state, "program"), data = Path.Combine(program, "data"),
        metadata = Path.Combine(program, "metadata"), views = Path.Combine(program, "root", "default"), media = Path.Combine(state, "media");
    if (!consume) { Directory.CreateDirectory(views); Directory.CreateDirectory(media); Directory.CreateDirectory(data); }
    string Map(string value) => value.Replace("{views}", views, StringComparison.Ordinal).Replace("{media}", media, StringComparison.Ordinal)
        .Replace("{data}", data, StringComparison.Ordinal).Replace("{metadata}", metadata, StringComparison.Ordinal)
        .Replace('\\', Path.DirectorySeparatorChar);
    if (!consume) foreach (var value in sample.GetProperty("directories").EnumerateArray()) Directory.CreateDirectory(Map(value.GetString()!));
    if (!consume && sample.TryGetProperty("files", out var initialFiles)) foreach (var pair in initialFiles.EnumerateObject()) File.WriteAllText(Map(pair.Name), Map(pair.Value.GetString()!));
    var calls = new ConcurrentQueue<object>();
    var failure = sample.TryGetProperty("failure", out var failureValue) ? failureValue.GetString() : null;
    void Trace(string action, object? value = null) => calls.Enqueue(new { action, value });
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => program, "get_DataPath" => data, "get_InternalMetadataPath" => metadata,
        "get_DefaultUserViewsPath" => views, "get_TempDirectory" => Path.Combine(state, "temp"), _ => Stub.Default(method.ReturnType)
    });
    var configuration = new ServerConfiguration { CacheSize = 64 };
    if (sample.TryGetProperty("contentTypes", out var overrides)) configuration.ContentTypes = overrides.ValueKind == JsonValueKind.Null ? null! : overrides.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.Null ? null! : new NameValuePair {
        Name = value.TryGetProperty("Name", out var name) && name.ValueKind != JsonValueKind.Null ? Map(name.GetString()!) : null!,
        Value = value.TryGetProperty("Value", out var contentType) ? contentType.GetString()! : null!
    }).ToArray();
    var config = Stub.Make<IServerConfigurationManager>((method, _) => {
        if (method.Name == "get_Configuration") return configuration;
        if (method.Name == "get_ApplicationPaths") return paths;
        if (method.Name == "SaveConfiguration") { Trace("configuration-save", configuration.ContentTypes); if (failure == "configuration-save") throw new IOException("Controlled configuration failure."); }
        return Stub.Default(method.ReturnType);
    });
    var appHost = Stub.Make<IServerApplicationHost>((method, parameters) => {
        if (method.Name == "ReverseVirtualPath") {
            var value = (string)parameters![0]!; Trace("reverse-path", value);
            return value.Replace(data, "%AppDataPath%", StringComparison.OrdinalIgnoreCase).Replace(metadata, "%MetadataPath%", StringComparison.OrdinalIgnoreCase);
        }
        if (method.Name == "ExpandVirtualPath") return ((string)parameters![0]!).Replace("%AppDataPath%", data, StringComparison.OrdinalIgnoreCase).Replace("%MetadataPath%", metadata, StringComparison.OrdinalIgnoreCase);
        return Stub.Default(method.ReturnType);
    });
    var enumerationInputs = sample.TryGetProperty("files", out var declaredFiles)
        ? declaredFiles.EnumerateObject().Select(pair => Path.GetFullPath(Map(pair.Name))).ToArray() : Array.Empty<string>();
    var fileSystem = new TracedFileSystem(paths, (action, value) => Trace(action, value),
        sample.TryGetProperty("failShortcut", out var shortcutFailure) ? shortcutFailure.GetInt32() : 0, enumerationInputs);
    var directoryService = new DirectoryService(fileSystem);
    var directories = Stub.Make<IDirectoryService>((method, parameters) => {
        if (method.Name == "Invalidate") { Trace("invalidate", parameters![0]); if (failure == "invalidate" || sample.TryGetProperty("failInvalidate", out var failInvalidate) && failInvalidate.GetBoolean()) throw new IOException("Controlled invalidation failure."); }
        return method.Invoke(directoryService, parameters);
    });
    var monitor = Stub.Make<ILibraryMonitor>((method, _) => {
        if (method.Name is "Stop" or "Start") { var action = "monitor-" + method.Name.ToLowerInvariant(); Trace(action); if (failure == action) throw new IOException("Controlled monitor failure."); }
        return Stub.Default(method.ReturnType);
    });
    var provider = Stub.Make<IProviderManager>((method, parameters) => {
        if (method.Name == "RefreshSingleItem") { var item = (BaseItem)parameters![0]!; Trace("refresh", item.Name);
            if (failure == "refresh-aggregate" && item.Name == "aggregate") throw new IOException("Controlled metadata failure."); return Task.FromResult(ItemUpdateType.None); }
        if (method.Name == "GetRefreshQueue") return new HashSet<Guid>();
        return Stub.Default(method.ReturnType);
    });
    var queued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var taskManager = Stub.Make<ITaskManager>((method, _) => { Trace("task-" + method.Name); if (method.Name == "QueueScheduledTask") queued.TrySetResult(); return Stub.Default(method.ReturnType); });
    var aggregate = new ControlledAggregate { Name = "aggregate", Id = Guid.Parse("967d0000-0000-0000-0000-000000000001"), Path = Path.Combine(program, "root"), Children = [] };
    var userRoot = new ControlledUserRoot { Name = "user-root", Id = Guid.Parse("967d0000-0000-0000-0000-000000000002"), Path = views, Children = [] };
    BaseItem.ConfigurationManager = config; BaseItem.ProviderManager = provider; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = fileSystem; CollectionFolder.ApplicationHost = appHost; CollectionFolder.XmlSerializer = new MyXmlSerializer();
    var manager = new LibraryManager(appHost, NullLoggerFactory.Instance, taskManager, null!, config, null!, new(() => monitor), fileSystem,
        new(() => provider), new(() => null!), null!, Stub.Make<IItemPersistenceService>((method, _) => Stub.Default(method.ReturnType)),
        null!, null!, null!, null!, new NamingOptions(), directories, null!, null!, new DotIgnoreIgnoreRule(),
        Stub.Make<ILocalizationManager>((method, _) => Stub.Default(method.ReturnType)), null!, new(() => null!));
    typeof(LibraryManager).GetField("_rootFolder", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(manager, aggregate);
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(manager, userRoot);
    BaseItem.LibraryManager = manager;
    bool validated = false;
    void Rebuild() => userRoot.Children = Directory.EnumerateDirectories(views).Select(directory => new CollectionFolder {
        Id = manager.GetNewItemId(directory, typeof(CollectionFolder)), Name = Path.GetFileName(directory), Path = directory }).ToArray();
    Rebuild();
    aggregate.Control = () => { Trace("validate-aggregate"); if (failure == "validate-aggregate") throw new IOException("Controlled aggregate validation failure."); aggregate.Children = []; return Task.CompletedTask; };
    userRoot.Control = () => { Trace("validate-user-root"); if (failure == "validate-user-root") throw new IOException("Controlled user-root validation failure."); Rebuild(); validated = true; return Task.CompletedTask; };
    var scanRunning = sample.TryGetProperty("scanRunning", out var scanning) && scanning.GetBoolean();
    typeof(LibraryManager).GetProperty("IsScanRunning")!.SetValue(manager, scanRunning);
    EventHandler<LibraryOptionsUpdatedEventArgs> updated = (_, value) => { Trace("options-updated", new { path = value.LibraryPath, options = JsonSerializer.SerializeToElement(value.LibraryOptions, json) });
        if (failure == "options-updated") throw new IOException("Controlled options observer failure."); };
    string? exception = null;
    var refresh = sample.TryGetProperty("refreshLibrary", out var refreshValue) && refreshValue.GetBoolean();
    var name = sample.TryGetProperty("name", out var libraryName) ? libraryName.GetString()! : "Library";
    var operation = sample.GetProperty("operation").GetString()!;
    var target = name is null ? null : Path.Combine(views, name);
    var options = sample.TryGetProperty("options", out var optionValues) ? JsonSerializer.Deserialize<LibraryOptions>(optionValues.GetRawText(), json)! : new LibraryOptions();
    if (options.PathInfos != null) foreach (var info in options.PathInfos) if (info?.Path != null) info.Path = Map(info.Path);
    if (!consume && target != null && Directory.Exists(target)) {
        CollectionFolder.SaveLibraryOptions(target, options);
        if (sample.TryGetProperty("livePathInfos", out var livePathInfos)) options.PathInfos = livePathInfos.ValueKind == JsonValueKind.Null ? null! : JsonSerializer.Deserialize<MediaPathInfo[]>(livePathInfos.GetRawText(), json)!;
        if (options.PathInfos != null) foreach (var info in options.PathInfos) if (info?.Path != null) info.Path = Map(info.Path);
        if (sample.TryGetProperty("optionsDirectory", out var optionsDirectory) && optionsDirectory.GetBoolean()) { File.Delete(Path.Combine(target, "options.xml")); Directory.CreateDirectory(Path.Combine(target, "options.xml")); }
        if (sample.TryGetProperty("deleteOnlyLocked", out var deleteOnlyLocked) && deleteOnlyLocked.GetBoolean()) foreach (var filename in Directory.EnumerateFiles(target)) if (Path.GetFileName(filename) != "locked.bin") File.Delete(filename);
    }
    var before = target != null && Directory.Exists(target) ? CollectionFolder.GetLibraryOptions(target) : null;
    CollectionFolder.LibraryOptionsUpdated += updated;
    while (calls.TryDequeue(out _)) {}
    fileSystem.FailResolve = !consume && failure == "resolve-shortcut";
    var beforeFiles = Files(views);
    var beforeDirectories = Directories(views);
    var beforeFolders = JsonSerializer.SerializeToElement(manager.GetVirtualFolders(true), json);
    var beforeOptions = before == null ? (JsonElement?)null : JsonSerializer.SerializeToElement(before, json);
    while (calls.TryDequeue(out _)) {}
    FileSharingProbe? held = null;
    if (!consume && sample.TryGetProperty("lockOptions", out var lockOptions) && lockOptions.GetBoolean()) held = new FileSharingProbe(Path.Combine(target!, "options.xml"), "write");
    if (!consume && sample.TryGetProperty("lockDelete", out var lockDelete) && lockDelete.GetBoolean()) held = new FileSharingProbe(Path.Combine(target!, "locked.bin"), "delete");
    var admission = held?.Access();
    if (!consume) try {
        var mediaPath = sample.TryGetProperty("mediaPath", out var mediaPathValue) ? JsonSerializer.Deserialize<MediaPathInfo?>(mediaPathValue.GetRawText(), json) : null;
        if (mediaPath?.Path != null) mediaPath.Path = Map(mediaPath.Path);
        switch (operation) {
            case "add": manager.AddMediaPath(name, mediaPath!); break;
            case "update": manager.UpdateMediaPath(name, mediaPath!); break;
            case "removePath": manager.RemoveMediaPath(name, sample.TryGetProperty("path", out var pathValue) && pathValue.ValueKind != JsonValueKind.Null ? Map(pathValue.GetString()!) : null!); break;
            case "removeLibrary": await manager.RemoveVirtualFolder(name, refresh); break;
            default: throw new InvalidOperationException("Unknown mutation operation.");
        }
    } catch (Exception error) { exception = error.GetType().Name; }
    finally { held?.Dispose(); fileSystem.FailResolve = false; }
    CollectionFolder.LibraryOptionsUpdated -= updated;
    if (refresh && !scanRunning && validated) await queued.Task.WaitAsync(TimeSpan.FromSeconds(2));
    var folders = manager.GetVirtualFolders(true);
    var files = Files(views);
    var after = target != null && Directory.Exists(target) ? CollectionFolder.GetLibraryOptions(target) : null;
    var operationCalls = calls.ToArray();
    var operationOptions = after == null ? (JsonElement?)null : JsonSerializer.SerializeToElement(after, json);
    CollectionFolder.OnCollectionFolderChange();
    Rebuild();
    var reopenedFolders = manager.GetVirtualFolders(true);
    var coldOptions = target != null && Directory.Exists(target) ? JsonSerializer.SerializeToElement(CollectionFolder.GetLibraryOptions(target), json) : (JsonElement?)null;
    results.Add(new { key, state, views, exception, operationFailed = exception != null, admission, beforeFiles, beforeFolders, beforeOptions,
        enumerationInputs, enumerationReads = fileSystem.Enumerations,
        calls = operationCalls, folders, reopenedFolders, files, directories = Directories(views), beforeDirectories,
        contentTypes = configuration.ContentTypes, options = operationOptions, coldOptions,
        cache = new { wasPrimed = before != null, sameAfterOperation = before != null && ReferenceEquals(before, after) },
        identities = userRoot.Children.Select(item => new { item.Name, item.Path, program = paths.ProgramDataPath,
            id = item.Id.ToString("N"), recalculated = manager.GetNewItemId(item.Path, typeof(CollectionFolder)).ToString("N") }).ToArray() });
}
var assemblies = new[] { typeof(LibraryManager).Assembly, typeof(CollectionFolder).Assembly, typeof(LibraryOptions).Assembly, typeof(MyXmlSerializer).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(), actualLibraryManager = true,
    actualLibraryOptionsStore = true, actualXmlSerializer = true, realFiles = true, structuralRootsControlled = true, providerMonitorTaskManagerControlled = true,
    fileEnumerationControlled = true,
    defaultLibraryOptions = new LibraryOptions(), results, assemblies }, json));

static object[] Files(string views) => Directory.EnumerateFiles(views, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
    .Select(filename => (object)new { path = Path.GetRelativePath(views, filename), bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }).ToArray();
static string[] Directories(string views) => Directory.EnumerateDirectories(views, "*", SearchOption.AllDirectories)
    .Select(directory => Path.GetRelativePath(views, directory)).Order(StringComparer.Ordinal).ToArray();

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class ControlledAggregate : AggregateFolder {
    public Func<Task> Control = null!;
    protected override Task ValidateChildrenInternal(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot, MetadataRefreshOptions options, IDirectoryService service, CancellationToken token) => Control();
}
public class ControlledUserRoot : UserRootFolder {
    public Func<Task> Control = null!;
    private IEnumerable<BaseItem> children = [];
    public override IEnumerable<BaseItem> Children { get => children; set => children = value ?? []; }
    protected override Task ValidateChildrenInternal(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot, MetadataRefreshOptions options, IDirectoryService service, CancellationToken token) => Control();
}
public class InlineContext : SynchronizationContext { public override void Post(SendOrPostCallback callback, object? state) => callback(state); }
public class TracedFileSystem(IServerApplicationPaths paths, Action<string, object?> trace, int failureAt, string[] enumerationInputs)
    : ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, [new MbLinkShortcutHandler()]) {
    private int count;
    public bool FailResolve;
    public List<object> Enumerations = [];
    public override IEnumerable<string> GetFilePaths(string path, bool recursive = false) {
        var raw = base.GetFilePaths(path, recursive).ToArray();
        int Rank(string filename) { var index = Array.IndexOf(enumerationInputs, filename); return index < 0 ? int.MaxValue : index; }
        var ordered = raw.OrderBy(Rank).ToArray();
        Enumerations.Add(new { path, recursive, raw, ordered });
        return ordered;
    }
    public override string? ResolveShortcut(string filename) {
        if (FailResolve) throw new IOException("Controlled shortcut read failure.");
        return base.ResolveShortcut(filename);
    }
    public override void CreateShortcut(string shortcutPath, string target) {
        trace("shortcut", new { path = shortcutPath, target });
        if (++count == failureAt) throw new IOException("Controlled shortcut failure.");
        base.CreateShortcut(shortcutPath, target);
    }
}
