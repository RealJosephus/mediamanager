using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Folders;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var results = new List<object>();
var options = new MetadataRefreshOptions((IDirectoryService)null!) { ForceSave = true };
TaskCompletionSource Gate() => new(TaskCreationOptions.RunContinuationsAsynchronously);
async Task WaitFor(Func<bool> predicate) { var end = DateTime.UtcNow.AddSeconds(10); while (!predicate()) { if (DateTime.UtcNow > end) throw new TimeoutException("Oracle barrier timeout"); await Task.Delay(5); } }
int QueueCount(ProviderManager manager) => (int)manager.GetType().GetField("_refreshQueue", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(manager)!.GetType().GetProperty("Count")!.GetValue(manager.GetType().GetField("_refreshQueue", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(manager))!;
bool Running(ProviderManager manager) => (bool)manager.GetType().GetField("_isProcessingRefreshQueue", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(manager)!;
object Stamp(BaseItem item) => new { item.Id, item.DateLastRefreshed, item.DateLastSaved, item.PresentationUniqueKey };

// Real ProviderManager queue, real BaseItem.RefreshMetadata and real UserView
// ValidateChildren. Only the selected IMetadataService and other dependencies
// are controlled; neither queue nor cancellation result is implemented here.
for (var scenario = 0; scenario < 4; scenario++) {
    var events = new ConcurrentQueue<object>(); var start = Gate(); var release = Gate(); var finished = Gate(); var cancellationObserved = Gate();
    var a = new UserView { Id = Guid.Parse("99500000-0000-0000-0000-000000000001"), Name = "A" };
    var b = new UserView { Id = Guid.Parse("99500000-0000-0000-0000-000000000002"), Name = "B" };
    var c = new UserView { Id = Guid.Parse("99500000-0000-0000-0000-000000000003"), Name = "C" };
    var calls = 0; var active = 0; var peak = 0;
    var service = Stub.Make<IMetadataService>((m, args) => {
        if (m.Name is "CanRefresh" or "CanRefreshPrimary") return true;
        if (m.Name == "get_Order") return 0;
        if (m.Name == "RefreshMetadata") return Refresh((BaseItem)args![0]!, (CancellationToken)args[2]!);
        return Stub.Default(m.ReturnType);
    });
    async Task<ItemUpdateType> Refresh(BaseItem item, CancellationToken token) {
        var call = Interlocked.Increment(ref calls); var count = Interlocked.Increment(ref active); peak = Math.Max(peak, count);
        events.Enqueue(new { kind = "service-start", item.Name, call, token.IsCancellationRequested });
        try {
            if (call == 1) { start.TrySetResult(); using var registration = token.Register(() => { events.Enqueue(new { kind = "token-cancelled", item.Name }); cancellationObserved.TrySetResult(); }); await release.Task; }
            if (scenario == 1 && call == 1) throw new InvalidOperationException("Controlled service failure");
            if (scenario == 2 && call == 1) throw new OperationCanceledException("Controlled provider cancellation", new CancellationToken(true));
            token.ThrowIfCancellationRequested();
            events.Enqueue(new { kind = "service-success", item.Name, call }); return ItemUpdateType.None;
        } finally { Interlocked.Decrement(ref active); events.Enqueue(new { kind = "service-finish", item.Name, call }); if (call == 1) finished.TrySetResult(); }
    }
    var library = Stub.Make<ILibraryManager>((m, args) => {
        if (m.Name == "GetItemById") { var id = (Guid)args![0]!; return id == a.Id ? a : id == b.Id ? b : c; }
        if (m.Name == "ClearIgnoreRuleCache") { events.Enqueue(new { kind = "clear-ignore" }); return null; }
        return Stub.Default(m.ReturnType);
    });
    var config = Stub.Make<IServerConfigurationManager>((m,args) => m.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(m.ReturnType));
    var manager = new ProviderManager(null!,null!,config,null!,new CaptureLogger<ProviderManager>(events),null!,null!,library,null!,null!,null!,null!,null!);
    manager.AddParts([], [service], [], [], [], []); BaseItem.ProviderManager = manager; BaseItem.LibraryManager = library; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    try {
        manager.QueueRefresh(a.Id, options, RefreshPriority.Normal); await start.Task.WaitAsync(TimeSpan.FromSeconds(10));
        if (scenario == 0) { manager.QueueRefresh(a.Id, options, RefreshPriority.Normal); manager.QueueRefresh(a.Id, options, RefreshPriority.Normal); }
        else manager.QueueRefresh(b.Id, options, RefreshPriority.Normal);
        var pendingBeforeRelease = QueueCount(manager); object? disposal = null;
        if (scenario == 3) {
            manager.Dispose(); events.Enqueue(new { kind = "dispose-returned" }); await cancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var pendingBeforeAfterClose = QueueCount(manager); manager.QueueRefresh(c.Id, options, RefreshPriority.Normal);
            disposal = new { finishedAtDisposeReturn = finished.Task.IsCompleted, cancellationObserved = cancellationObserved.Task.IsCompleted,
                pendingBeforeAfterClose, pendingAfterQueueAfterDispose = QueueCount(manager) };
        }
        release.TrySetResult(); await WaitFor(() => !Running(manager));
        results.Add(new { name = new[] { "duplicate-id-while-running", "failure-then-next-item", "provider-own-cancellation-then-next-item", "dispose-cancels-without-wait-and-ignores-new-queue" }[scenario],
            calls, peakConcurrentServices = peak, pendingBeforeRelease, pendingAfterDrain = QueueCount(manager), disposal, events = events.ToArray(), a = Stamp(a), b = Stamp(b) });
    } finally { release.TrySetResult(); manager.Dispose(); }
}

// Real UserViewMetadataService. Controlled custom provider and repository
// expose when the native service attempts persistence, not actual DB writes.
foreach (var failure in new[] { "none", "error", "cancel" }) {
    var events = new ConcurrentQueue<object>();
    var view = new UserView { Id = Guid.Parse("99500000-0000-0000-0000-000000000004"), Name = "Refresh", ViewType = Jellyfin.Data.Enums.CollectionType.books };
    var provider = Stub.Make<ICustomMetadataProvider<UserView>>((m,args) => {
        if (m.Name == "get_Name") return "Controlled native lifecycle provider";
        if (m.Name == "FetchAsync") { events.Enqueue(new { kind = "custom-fetch", item = Stamp(view) });
            return failure == "error" ? Task.FromException<ItemUpdateType>(new InvalidOperationException("Controlled custom failure"))
                : failure == "cancel" ? Task.FromException<ItemUpdateType>(new OperationCanceledException("Controlled custom cancellation")) : Task.FromResult(ItemUpdateType.None); }
        return Stub.Default(m.ReturnType);
    });
    var library = Stub.Make<ILibraryManager>((m,args) => {
        if (m.Name == "GetLibraryOptions") return new LibraryOptions();
        if (m.Name == "GetCollectionFolders") return new List<Folder>();
        if (m.Name == "UpdateItemAsync") { var token=(CancellationToken)args![3]!;events.Enqueue(new { kind = "repository-save-attempt", reason = args[2]!.ToString(), token.IsCancellationRequested, item = Stamp(view) });token.ThrowIfCancellationRequested();return Task.CompletedTask; }
        if (m.Name == "ReattachUserDataAsync") { events.Enqueue(new { kind = "reattach" }); return Task.CompletedTask; }
        return Stub.Default(m.ReturnType);
    });
    var config = Stub.Make<IServerConfigurationManager>((m,args) => m.Name == "get_Configuration" ? new ServerConfiguration { PreferredMetadataLanguage = "en", MetadataCountryCode = "US" } : Stub.Default(m.ReturnType));
    var repo = Stub.Make<IItemRepository>((m,args) => m.Name == "ItemExistsAsync" ? Task.FromResult(true) : Stub.Default(m.ReturnType));
    using var manager = new ProviderManager(null!,null!,config,null!,new CaptureLogger<ProviderManager>(events),null!,null!,library,null!,null!,null!,null!,null!);
    BaseItem.LibraryManager = library; BaseItem.ProviderManager = manager; BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var metadata = new UserViewMetadataService(config,new CaptureLogger<UserViewMetadataService>(events),manager,null!,library,null!,repo);
    manager.AddParts([], [metadata], [provider], [], [], []);
    object? error = null; ItemUpdateType? updateType = null;
    try { updateType = await metadata.RefreshMetadata(view, options, CancellationToken.None); }
    catch (Exception ex) { error = new { type = ex.GetType().FullName, ex.Message }; }
    results.Add(new { name = "actual-metadata-first-refresh-" + failure, updateType, error, events = events.ToArray(), item = Stamp(view) });
}

// QueueRefresh with the real UserViewMetadataService, not a metadata-service proxy.
// The custom provider and persistence calls remain explicit controlled dependencies.
foreach (var scenario in new[] { "all-custom-fail", "first-cancel-then-success", "first-success-already-queued" }) {
    var events = new ConcurrentQueue<object>(); var start = Gate(); var release = Gate(); var calls = 0;
    var view = new UserView { Id = Guid.Parse("99500000-0000-0000-0000-000000000005"), Name = "Queued real metadata", ViewType = Jellyfin.Data.Enums.CollectionType.books };
    async Task<ItemUpdateType> Fetch(CancellationToken token) {
        var call = Interlocked.Increment(ref calls); events.Enqueue(new { kind = "custom-fetch-start", call, item = Stamp(view), token.IsCancellationRequested });
        if (call == 1) { start.TrySetResult(); await release.Task; }
        if (scenario == "all-custom-fail") throw new InvalidOperationException("Controlled queued custom failure");
        if (scenario == "first-cancel-then-success" && call == 1) throw new OperationCanceledException("Controlled queued custom cancellation");
        events.Enqueue(new { kind = "custom-fetch-success", call }); return ItemUpdateType.None;
    }
    var provider = Stub.Make<ICustomMetadataProvider<UserView>>((m,args) => m.Name == "get_Name" ? "Controlled queued lifecycle provider"
        : m.Name == "FetchAsync" ? Fetch((CancellationToken)args![2]!) : Stub.Default(m.ReturnType));
    var library = Stub.Make<ILibraryManager>((m,args) => {
        if (m.Name == "GetItemById") return view;
        if (m.Name == "GetLibraryOptions") return new LibraryOptions();
        if (m.Name == "GetCollectionFolders") return new List<Folder>();
        if (m.Name == "ClearIgnoreRuleCache") { events.Enqueue(new { kind = "clear-ignore" }); return null; }
        if (m.Name == "UpdateItemAsync") { var token = (CancellationToken)args![3]!; events.Enqueue(new { kind = "repository-save-attempt", reason = args[2]!.ToString(), token.IsCancellationRequested, item = Stamp(view) }); token.ThrowIfCancellationRequested(); return Task.CompletedTask; }
        if (m.Name == "ReattachUserDataAsync") { events.Enqueue(new { kind = "reattach" }); return Task.CompletedTask; }
        return Stub.Default(m.ReturnType);
    });
    var config = Stub.Make<IServerConfigurationManager>((m,args) => m.Name == "get_Configuration" ? new ServerConfiguration { PreferredMetadataLanguage = "en", MetadataCountryCode = "US" } : Stub.Default(m.ReturnType));
    var repo = Stub.Make<IItemRepository>((m,args) => m.Name == "ItemExistsAsync" ? Task.FromResult(true) : Stub.Default(m.ReturnType));
    using var manager = new ProviderManager(null!,null!,config,null!,new CaptureLogger<ProviderManager>(events),null!,null!,library,null!,null!,null!,null!,null!);
    BaseItem.LibraryManager = library; BaseItem.ProviderManager = manager; BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var metadata = new UserViewMetadataService(config,new CaptureLogger<UserViewMetadataService>(events),manager,null!,library,null!,repo);
    manager.AddParts([], [metadata], [provider], [], [], []);
    try {
        manager.QueueRefresh(view.Id, options, RefreshPriority.Normal); await start.Task.WaitAsync(TimeSpan.FromSeconds(10));
        manager.QueueRefresh(view.Id, options, RefreshPriority.Normal); manager.QueueRefresh(view.Id, options, RefreshPriority.Normal);
        var pendingBeforeRelease = QueueCount(manager); release.TrySetResult(); await WaitFor(() => !Running(manager));
        results.Add(new { name = "actual-metadata-queue-" + scenario, customCalls = calls, pendingBeforeRelease, pendingAfterDrain = QueueCount(manager), events = events.ToArray(), item = Stamp(view) });
    } finally { release.TrySetResult(); }
}

// Normal priority is used by named views. Distinct ids expose PriorityQueue
// tie behavior without replacing the actual native queue with an oracle sort.
{
    var events = new ConcurrentQueue<object>(); var start = Gate(); var release = Gate(); var calls = 0; var active = 0; var peak = 0;
    var items = Enumerable.Range(1, 9).Select(index => new UserView { Id = Guid.Parse($"99510000-0000-0000-0000-{index:000000000000}"), Name = index.ToString() }).ToDictionary(item => item.Id);
    var service = Stub.Make<IMetadataService>((m,args) => m.Name is "CanRefresh" or "CanRefreshPrimary" ? true : m.Name == "get_Order" ? 0
        : m.Name == "RefreshMetadata" ? Refresh((BaseItem)args![0]!, (CancellationToken)args[2]!) : Stub.Default(m.ReturnType));
    async Task<ItemUpdateType> Refresh(BaseItem item, CancellationToken token) {
        var call = Interlocked.Increment(ref calls); peak = Math.Max(peak, Interlocked.Increment(ref active));
        events.Enqueue(new { kind = "service-start", item.Name, call, token.IsCancellationRequested });
        try { if (call == 1) { start.TrySetResult(); await release.Task; } token.ThrowIfCancellationRequested(); return ItemUpdateType.None; }
        finally { Interlocked.Decrement(ref active); events.Enqueue(new { kind = "service-finish", item.Name, call }); }
    }
    var library = Stub.Make<ILibraryManager>((m,args) => m.Name == "GetItemById" ? items[(Guid)args![0]!] : Stub.Default(m.ReturnType));
    var config = Stub.Make<IServerConfigurationManager>((m,args) => m.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(m.ReturnType));
    using var manager = new ProviderManager(null!,null!,config,null!,new CaptureLogger<ProviderManager>(events),null!,null!,library,null!,null!,null!,null!,null!);
    manager.AddParts([], [service], [], [], [], []); BaseItem.ProviderManager = manager; BaseItem.LibraryManager = library; BaseItem.Logger = NullLogger<BaseItem>.Instance;
    try {
        manager.QueueRefresh(items.Values.First().Id, options, RefreshPriority.Normal); await start.Task.WaitAsync(TimeSpan.FromSeconds(10));
        foreach (var item in items.Values.Skip(1)) manager.QueueRefresh(item.Id, options, RefreshPriority.Normal);
        var pendingBeforeRelease = QueueCount(manager); release.TrySetResult(); await WaitFor(() => !Running(manager));
        results.Add(new { name = "normal-priority-distinct-id-order", calls, peakConcurrentServices = peak, pendingBeforeRelease, pendingAfterDrain = QueueCount(manager), events = events.ToArray() });
    } finally { release.TrySetResult(); }
}

var assemblies = new[] { typeof(ProviderManager).Assembly, typeof(UserViewMetadataService).Assembly, typeof(UserView).Assembly, typeof(object).Assembly }.Distinct().Select(a => new {
    name = a.GetName().Name, path = a.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(a.Location))).ToLowerInvariant() });
File.WriteAllText(args[0],JsonSerializer.Serialize(new { actualFrozenProviderManager=true, actualFrozenUserView=true, actualFrozenUserViewMetadataService=true,
    processId=Environment.ProcessId,runtime=System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,results,assemblies,
    scope="Real frozen DLL queue and metadata orchestration with explicitly controlled IMetadataService/custom provider/library persistence dependencies. No database, HTTP host, filesystem or port. Repository-save-attempt means dependency invocation only, not successful actual SQL or DateLastSaved mutation. Does not prove complete refresh/cancellation/race phase acceptance." },new JsonSerializerOptions {WriteIndented=true}));
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler=null!;
    protected override object? Invoke(MethodInfo? method,object?[]? args)=>Handler(method!,args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var value=Create<T,Stub>();((Stub)(object)value).Handler=handler;return value;}
    public static object? Default(Type t)=>t==typeof(void)?null:t==typeof(Task)?Task.CompletedTask:t.IsValueType?Activator.CreateInstance(t):null;
}
public class CaptureLogger<T>(ConcurrentQueue<object> events) : ILogger<T> {
    public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
    public bool IsEnabled(LogLevel level)=>true;
    public void Log<TState>(LogLevel level,EventId id,TState state,Exception? error,Func<TState,Exception?,string> formatter){if(error!=null)events.Enqueue(new {kind="logged-error",type=error.GetType().FullName,error.Message,text=formatter(state,error)});}
}
