// Real frozen LibraryManager orchestration. Structural callbacks are explicit controls.
using System.Reflection;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Server.Implementations.Library;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;

SQLitePCL.Batteries_V2.Init();
SynchronizationContext.SetSynchronizationContext(new InlineContext());
var json = new JsonSerializerOptions { WriteIndented = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var directory = Path.GetFullPath(Path.Combine(args[2], name)); Directory.CreateDirectory(directory);
    if (sample.TryGetProperty("mode", out var sqlMode) && sqlMode.GetString() == "inheritance") {
        var factory = new SqlFactory(Path.Combine(directory, "native.db"));
        using (var context = factory.CreateDbContext()) {
            context.Database.EnsureCreated();
            var items = new[] { new BaseItemEntity { Id = Guid.Parse("97020000-0000-0000-0000-000000000001"), Type = "MediaBrowser.Controller.Entities.Folder", Name = "One" },
                new BaseItemEntity { Id = Guid.Parse("97020000-0000-0000-0000-000000000002"), Type = "MediaBrowser.Controller.Entities.Movies.Movie", Name = "Two" } };
            context.BaseItems.AddRange(items);
            foreach (var definition in sample.GetProperty("values").EnumerateArray()) {
                var value = new ItemValue { ItemValueId = Guid.Parse(definition.GetProperty("id").GetString()!), Type = (ItemValueType)definition.GetProperty("type").GetInt32(),
                    Value = definition.GetProperty("value").GetString()!, CleanValue = definition.GetProperty("value").GetString()!.ToLowerInvariant() };
                context.ItemValues.Add(value);
                foreach (var index in definition.GetProperty("items").EnumerateArray()) context.ItemValuesMap.Add(new ItemValueMap { Item = items[index.GetInt32()], ItemId = items[index.GetInt32()].Id,
                    ItemValue = value, ItemValueId = value.ItemValueId });
            }
            context.SaveChanges();
            if (sample.TryGetProperty("sqlFailure", out var sqlFailure) && sqlFailure.GetBoolean()) context.Database.ExecuteSqlRaw("CREATE TRIGGER fail_inherited_delete AFTER DELETE ON ItemValuesMap BEGIN SELECT RAISE(ABORT, 'Controlled inherited delete failure'); END");
        }
        var persistenceService = new ItemPersistenceService(factory, null!, NullLogger<ItemPersistenceService>.Instance);
        string? sqlException = null;
        try { for (var iteration = 0; iteration < (sample.TryGetProperty("repeat", out var repeat) ? repeat.GetInt32() : 1); iteration++) persistenceService.UpdateInheritedValues(); }
        catch (Exception error) { sqlException = error.GetType().Name; }
        using var final = factory.CreateDbContext();
        var finalValues = final.ItemValues.AsEnumerable().OrderBy(value => value.ItemValueId).Select(value => new { id = value.ItemValueId, type = (int)value.Type, value = value.Value, cleanValue = value.CleanValue }).ToArray();
        var maps = final.ItemValuesMap.AsEnumerable().OrderBy(map => map.ItemId).ThenBy(map => map.ItemValueId).Select(map => new { itemId = map.ItemId, itemValueId = map.ItemValueId }).ToArray();
        results.Add(new { name, exception = sqlException, values = finalValues, maps });
        continue;
    }
    var calls = new List<object>(); var values = new List<double>(); var ignore = new DotIgnoreIgnoreRule();
    var directoryCache = typeof(DotIgnoreIgnoreRule).GetField("_directoryCache", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(ignore)!;
    bool EmptyCache() => (int)directoryCache.GetType().GetProperty("Count")!.GetValue(directoryCache)! == 0;
    var seed = 0;
    void SeedCache() { var path = Path.Combine(directory, "cache-" + ++seed, "sample.mkv"); ignore.ShouldIgnore(new FileSystemMetadata { FullName = path }, null); }
    LibraryManager? manager = null;
    void Trace(string action, string? item = null) { calls.Add(new { action, item, scanRunning = manager?.IsScanRunning ?? false, cacheEmpty = EmptyCache() }); }
    using var cancellation = new CancellationTokenSource();
    var failure = sample.TryGetProperty("failure", out var fail) ? fail.GetString() : null;
    var cancelAt = sample.TryGetProperty("cancelAt", out var cancel) ? cancel.GetString() : null;
    void Control(string action, string? item = null) {
        Trace(action, item);
        if (cancelAt == action) cancellation.Cancel();
        cancellation.Token.ThrowIfCancellationRequested();
        if (failure == action) throw new IOException("Controlled " + action + " failure");
        SeedCache();
    }
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(method.ReturnType));
    var provider = Stub.Make<IProviderManager>((method, parameters) => {
        if (method.Name == "RefreshSingleItem") { var item = (BaseItem)parameters![0]!; Control("refresh-" + item.Name, item.Name); return Task.FromResult(ItemUpdateType.None); }
        return Stub.Default(method.ReturnType);
    });
    var monitor = Stub.Make<ILibraryMonitor>((method, _) => {
        if (method.Name is "Stop" or "Start") { Trace("monitor-" + method.Name.ToLowerInvariant());
            if (failure == "monitor-" + method.Name.ToLowerInvariant()) throw new IOException("Controlled monitor failure"); }
        return Stub.Default(method.ReturnType);
    });
    var persistence = Stub.Make<IItemPersistenceService>((method, parameters) => {
        if (method.Name == "DeleteItem") { calls.Add(new { action = "delete-collections", ids = ((Guid[])parameters![0]!).Select(id => id.ToString("D")).ToArray() }); Control("delete-collections"); }
        if (method.Name == "UpdateInheritedValues") Control("update-inherited");
        return Stub.Default(method.ReturnType);
    });
    var taskManager = Stub.Make<MediaBrowser.Model.Tasks.ITaskManager>((method, _) => { Trace("task-" + method.Name); return Stub.Default(method.ReturnType); });
    var aggregate = new ControlledAggregate { Name = "aggregate", Id = Guid.Parse("97000000-0000-0000-0000-000000000001"), Path = directory };
    var userRoot = new ControlledUserRoot { Name = "user-root", Id = Guid.Parse("97000000-0000-0000-0000-000000000002"), Path = directory };
    var children = new List<BaseItem>();
    if (sample.TryGetProperty("collections", out var definitions)) foreach (var definition in definitions.EnumerateArray()) {
        var path = Path.Combine(directory, definition.GetProperty("name").GetString()!);
        if (definition.GetProperty("exists").GetBoolean()) Directory.CreateDirectory(path);
        children.Add(new CollectionFolder { Name = definition.GetProperty("name").GetString()!, Id = Guid.Parse(definition.GetProperty("id").GetString()!), Path = path });
    }
    if (sample.TryGetProperty("ordinaryChild", out var ordinary) && ordinary.GetBoolean()) children.Add(new Folder { Name = "ordinary", Id = Guid.Parse("97000000-0000-0000-0000-000000000003") });
    aggregate.Control = (progress, recursive, refreshChildMetadata, allowRemoveRoot, options, token) => {
        Control(recursive ? "recursive-aggregate" : "validate-aggregate", "aggregate");
        calls.Add(new { action = "validation-options", item = "aggregate", recursive, refreshChildMetadata, allowRemoveRoot,
            options.MetadataRefreshMode, options.ImageRefreshMode, options.IsAutomated, options.ForceSave });
        foreach (var value in recursive ? new[] { 0d, 25d, 100d } : new[] { 50d }) progress.Report(value);
        aggregate.Children = [];
        return Task.CompletedTask;
    };
    userRoot.Control = (progress, recursive, refreshChildMetadata, allowRemoveRoot, options, token) => {
        Control("validate-user-root", "user-root");
        calls.Add(new { action = "validation-options", item = "user-root", recursive, refreshChildMetadata, allowRemoveRoot,
            options.MetadataRefreshMode, options.ImageRefreshMode, options.IsAutomated, options.ForceSave });
        userRoot.Children = children;
        return Task.CompletedTask;
    };
    BaseItem.ProviderManager = provider; BaseItem.ConfigurationManager = config; BaseItem.Logger = Microsoft.Extensions.Logging.Abstractions.NullLogger<BaseItem>.Instance;
    manager = new LibraryManager(null!, new CaptureLoggerFactory(calls), taskManager, null!, config, null!, new(() => monitor), null!,
        new(() => provider), new(() => null!), null!, persistence, null!, null!, null!, null!, new NamingOptions(), null!, null!, null!, ignore, null!, null!, new(() => null!));
    typeof(LibraryManager).GetField("_rootFolder", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(manager, aggregate);
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(manager, userRoot);
    BaseItem.LibraryManager = manager;
    var tasks = new List<ILibraryPostScanTask>();
    if (sample.TryGetProperty("postTasks", out var taskInputs)) foreach (var taskInput in taskInputs.EnumerateArray()) {
        tasks.Add(new ControlledTask((progress, token) => {
            var taskName = taskInput.GetProperty("name").GetString()!; Control("post-" + taskName);
            if (taskInput.TryGetProperty("replaceTasks", out var replace) && replace.GetBoolean()) manager.AddParts([], [], [], [], []);
            if (taskInput.TryGetProperty("progress", out var reports)) foreach (var value in reports.EnumerateArray()) progress.Report(value.GetDouble());
            return Task.CompletedTask;
        }));
    }
    manager.AddParts([], [], [], [], tasks); SeedCache();
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    string? exception = null;
    try {
        var mode = sample.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() : "complete";
        if (mode == "top") await manager.ValidateTopLibraryFolders(cancellation.Token, sample.TryGetProperty("removeRoot", out var removeRoot) && removeRoot.GetBoolean());
        else if (mode == "queue") await manager.ValidateMediaLibrary(new InlineProgress(value => values.Add(value)), cancellation.Token);
        else await manager.ValidateMediaLibraryInternal(new InlineProgress(value => values.Add(value)), cancellation.Token);
    } catch (Exception error) { exception = error.GetType().Name; }
    results.Add(new { name, exception, calls, progress = values, scanRunning = manager.IsScanRunning, cacheEmpty = EmptyCache() });
}
var assemblies = new[] { typeof(LibraryManager).Assembly, typeof(Folder).Assembly, typeof(ItemPersistenceService).Assembly, typeof(SqliteDatabaseProvider).Assembly, typeof(object).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenLibraryManager = true, results, assemblies,
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    scope = "Real ValidateMediaLibraryInternal, ValidateTopLibraryFolders, PerformLibraryValidation and RunPostScanTasks. Controlled aggregate/user-root ValidateChildrenInternal, metadata provider, lifecycle persistence and monitor. Real ignore cache and collection-directory existence. Four independent real ItemPersistenceService/EF SQLite inherited-link cleanup controls. No production recursive scanner, watcher or socket." }, json));

public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T : class { var value = Create<T,Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public delegate Task Validation(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot, MetadataRefreshOptions options, CancellationToken token);
public class ControlledAggregate : AggregateFolder {
    public Validation Control = null!;
    protected override Task ValidateChildrenInternal(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot, MetadataRefreshOptions options, IDirectoryService service, CancellationToken token) => Control(progress, recursive, refreshChildMetadata, allowRemoveRoot, options, token);
}
public class ControlledUserRoot : UserRootFolder {
    public Validation Control = null!;
    protected override Task ValidateChildrenInternal(IProgress<double> progress, bool recursive, bool refreshChildMetadata, bool allowRemoveRoot, MetadataRefreshOptions options, IDirectoryService service, CancellationToken token) => Control(progress, recursive, refreshChildMetadata, allowRemoveRoot, options, token);
}
public class ControlledTask(Func<IProgress<double>,CancellationToken,Task> run) : ILibraryPostScanTask { public Task Run(IProgress<double> progress, CancellationToken token) => run(progress, token); }
public class InlineProgress(Action<double> report) : IProgress<double> { public void Report(double value) => report(value); }
public class InlineContext : SynchronizationContext { public override void Post(SendOrPostCallback callback, object? state) => callback(state); }
public class CaptureLogger(List<object> calls) : ILogger {
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => true;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState,Exception?,string> formatter) { if (error is not null) calls.Add(new { action = "logged-error", exception = error.GetType().Name }); }
}
public class CaptureLoggerFactory(List<object> calls) : ILoggerFactory { public ILogger CreateLogger(string category) => new CaptureLogger(calls); public void AddProvider(ILoggerProvider provider) {} public void Dispose() {} }
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
