// Executes the baseline ProviderManager queue; dependencies are controlled, with no SQL or HTTP server.
using System.Reflection;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Logging.Abstractions;

var samples = new[]
{
    new Sample("equal-high", [0, 0, 0, 0, 0, 0, 0, 0, 0], []),
    new Sample("mixed-priorities", [2, 1, 0, 2, 0, 1, 0, 2, 1, 0, 1, 2, 0], []),
    new Sample("provider-cancellation", [0, 0, 0, 0], ["item-1"]),
    new Sample("shutdown", [0, 0, 0], [], true)
};
var results = new List<object>();
foreach (var sample in samples)
{
    var items = Enumerable.Range(0, sample.Priorities.Length).Select(index => new QueueItem
    {
        Id = Guid.Parse($"01111111-1111-1111-1111-{index + 1:D12}"), Name = $"item-{index}"
    }).ToDictionary(item => item.Id);
    var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var trace = new List<string>();
    var failures = new List<string>();
    var concurrent = 0;
    var maximumConcurrency = 0;
    var service = Stub.Create<IMetadataService>((method, arguments) => method.Name switch
    {
        "CanRefreshPrimary" or "CanRefresh" => true,
        "get_Order" => 0,
        "RefreshMetadata" => Run((BaseItem)arguments![0]!, (CancellationToken)arguments[2]!),
        _ => Stub.Default(method.ReturnType)
    });
    var library = Stub.Create<ILibraryManager>((method, arguments) => method.Name == "GetItemById"
        ? items.GetValueOrDefault((Guid)arguments![0]!) : Stub.Default(method.ReturnType));
    var configuration = Stub.Create<IServerConfigurationManager>((method, _) => Stub.Default(method.ReturnType));
    using var manager = new ProviderManager(null!, null!, configuration, null!, NullLogger<ProviderManager>.Instance,
        null!, null!, library, null!, null!, null!, null!, null!);
    BaseItem.ProviderManager = manager;
    BaseItem.LibraryManager = library;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    manager.AddParts([], [service], [], [], [], []);
    var refreshEvents = 0;
    manager.RefreshStarted += (_, _) => refreshEvents++;
    manager.RefreshCompleted += (_, _) => refreshEvents++;
    var options = new MetadataRefreshOptions((IDirectoryService)null!);
    manager.QueueRefresh(items.Values.First().Id, options, (RefreshPriority)sample.Priorities[0]);
    await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
    for (var index = 1; index < sample.Priorities.Length; index++)
        manager.QueueRefresh(items.Values.ElementAt(index).Id, options, (RefreshPriority)sample.Priorities[index]);
    var beforeRelease = trace.ToArray();
    if (sample.Shutdown) manager.Dispose();
    else release.SetResult();
    var processing = typeof(ProviderManager).GetField("_isProcessingRefreshQueue", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var deadline = DateTime.UtcNow.AddSeconds(10);
    while ((bool)processing.GetValue(manager)!)
    {
        if (DateTime.UtcNow > deadline) throw new TimeoutException("The native refresh queue did not drain.");
        await Task.Delay(10);
    }
    results.Add(new { name = sample.Name, beforeRelease, order = trace.ToArray(), failures = failures.ToArray(), maximumConcurrency, refreshEvents });

    async Task<ItemUpdateType> Run(BaseItem item, CancellationToken cancellationToken)
    {
        lock (trace)
        {
            concurrent++;
            maximumConcurrency = Math.Max(maximumConcurrency, concurrent);
            trace.Add(item.Name);
        }
        try
        {
            if (item.Name == "item-0")
            {
                started.SetResult();
                await release.Task.WaitAsync(cancellationToken);
            }
            if (sample.CancelItems.Contains(item.Name))
            {
                failures.Add(item.Name);
                throw new OperationCanceledException("Controlled provider cancellation.");
            }
            return ItemUpdateType.None;
        }
        finally { lock (trace) concurrent--; }
    }
}
Console.WriteLine(JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));

record Sample(string Name, int[] Priorities, string[] CancelItems, bool Shutdown = false);
class QueueItem : BaseItem { }
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => Handler(targetMethod!, args);
    public static T Create<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var instance = Create<T, Stub>();
        ((Stub)(object)instance).Handler = handler;
        return instance;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
