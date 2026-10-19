using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.LibraryTaskScheduler;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var results = new List<object>();
await CompareMode("explicit-one", 1, false);
await CompareMode("default", 0, Environment.ProcessorCount >= 4);
await CompareMode("negative-default", -9, Environment.ProcessorCount >= 4);

async Task CompareMode(string name, int fanout, bool pooled)
{
    // The controlled processor count is 3 or 4, so a default pooled limit is 1.
    Check(Environment.ProcessorCount is 3 or 4, "Use an explicit processor-count control of 3 or 4.");
    await using var test = new Harness(fanout);
    var first = new GateSet(1); var second = new GateSet(1);
    var a = Enqueue(test.Scheduler, [0], first.Work, new ProgressTrace());
    await Ready(first.Entered[0].Task);
    var b = Enqueue(test.Scheduler, [0], second.Work, new ProgressTrace());
    var secondStartedBeforeRelease = second.Entered[0].Task.IsCompleted;
    Check(secondStartedBeforeRelease != pooled, name + " execution mode");
    first.Release[0].TrySetResult();
    await Ready(second.Entered[0].Task);
    second.Release[0].TrySetResult();
    await Ready(Task.WhenAll(a, b));
    results.Add(new { name, fanout, processorCount = Environment.ProcessorCount,
        secondStartedBeforeRelease, first = first.Snapshot(), second = second.Snapshot(), errors = test.Errors.Snapshot() });
}

await using (var test = new Harness(2))
{
    var first = new GateSet(3); var second = new GateSet(2);
    var firstProgress = new ProgressTrace(); var secondProgress = new ProgressTrace();
    var a = Enqueue(test.Scheduler, [0, 1, 2], first.Work, firstProgress);
    await Ready(Task.WhenAll(first.Entered[0].Task, first.Entered[1].Task));
    var b = Enqueue(test.Scheduler, [0, 1], second.Work, secondProgress);
    Check(!first.Entered[2].Task.IsCompleted && !second.Entered[0].Task.IsCompleted, "both workers are held");
    first.Release[0].TrySetResult();
    await Ready(first.Entered[2].Task);
    var secondStartedBeforeOlderQueuedItem = second.Entered[0].Task.IsCompleted;
    Check(!secondStartedBeforeOlderQueuedItem, "older queued item must be dispatched first");
    first.Release[1].TrySetResult(); await Ready(second.Entered[0].Task);
    var firstDoneAtSecondStart = a.IsCompleted;
    Check(!firstDoneAtSecondStart, "the next workset may start before all older callbacks finish");
    first.Release[2].TrySetResult(); await Ready(second.Entered[1].Task);
    second.ReleaseAll(); await Ready(Task.WhenAll(a, b));
    results.Add(new { name = "pooled-overlap-fifo", secondStartedBeforeOlderQueuedItem, firstDoneAtSecondStart,
        first = first.Snapshot(), second = second.Snapshot(), firstFinalProgress = firstProgress.Last, secondFinalProgress = secondProgress.Last });
}

foreach (var separateScheduler in new[] { false, true })
{
    await using var outer = new Harness(2); await using var other = new Harness(2);
    var inner = new GateSet(2); var outerProgress = new ProgressTrace();
    var task = Enqueue(outer.Scheduler, [0], async (_, _) =>
        await Enqueue(separateScheduler ? other.Scheduler : outer.Scheduler, [0, 1], inner.Work, new ProgressTrace()), outerProgress);
    await Ready(inner.Entered[0].Task);
    var secondStartedBeforeRelease = inner.Entered[1].Task.IsCompleted;
    Check(!secondStartedBeforeRelease, "nested work must run inline sequentially");
    inner.Release[0].TrySetResult(); await Ready(inner.Entered[1].Task); inner.Release[1].TrySetResult();
    await Ready(task);
    results.Add(new { name = separateScheduler ? "nested-other-instance" : "nested-same-instance",
        secondStartedBeforeRelease, inner = inner.Snapshot(), finalProgress = outerProgress.Last });
}

await using (var test = new Harness(1))
{
    var progress = new ProgressTrace();
    await Ready(Enqueue(test.Scheduler, [0, 1], (item, report) =>
    {
        foreach (var value in item == 0 ? new[] { .5, 1.5, 2.5, -.5, -1.5, 50.5, 51.5, 99.5, 100.5 } : new[] { 25.5 }) report.Report(value);
        return Task.CompletedTask;
    }, progress));
    var values = progress.Snapshot();
    Check(values.SequenceEqual(new double[] { 1, 0, -1, 25, 26, 50, 63, 100 }), "half-even averaging");
    results.Add(new { name = "half-even-progress", progress = values });
}

await using (var test = new Harness(1))
{
    var calls = new List<int>(); var progress = new ProgressTrace();
    await Ready(Enqueue(test.Scheduler, [0, 1, 2], (item, _) =>
    {
        calls.Add(item); if (item == 1) throw new IOException("Controlled worker failure."); return Task.CompletedTask;
    }, progress));
    Check(calls.SequenceEqual(new[] { 0, 1, 2 }) && test.Errors.Snapshot().Length == 1 && progress.Last == 100, "worker failure isolation");
    results.Add(new { name = "worker-failure", calls, progress = progress.Snapshot(), errors = test.Errors.Snapshot() });
}

await using (var test = new Harness(2))
{
    using var cancellation = new CancellationTokenSource(); var progress = new ProgressTrace(); var gates = new GateSet(3);
    var task = Enqueue(test.Scheduler, [0, 1, 2], async (item, report) =>
    {
        await gates.Work(item, report); cancellation.Token.ThrowIfCancellationRequested();
    }, progress, cancellation.Token);
    await Ready(Task.WhenAll(gates.Entered[0].Task, gates.Entered[1].Task)); cancellation.Cancel();
    gates.Release[0].TrySetResult(); await Until(() => progress.Snapshot().Length >= 2);
    Check(!gates.Entered[2].Task.IsCompleted, "queued cancellation must skip the callback");
    gates.Release[1].TrySetResult(); await Ready(task);
    Check(test.Errors.Snapshot().Length == 2 && progress.Last == 100, "active cancellation is logged and drained");
    results.Add(new { name = "cancel-active-and-queued", work = gates.Snapshot(), progress = progress.Snapshot(), errors = test.Errors.Snapshot() });
}

await using (var test = new Harness(2))
{
    var empty = new ProgressTrace(); var cancelled = new ProgressTrace(); var invoked = 0;
    using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
    Task Worker(int _, IProgress<double> __) { invoked++; return Task.CompletedTask; }
    await Ready(Enqueue(test.Scheduler, [], Worker, empty));
    await Ready(Enqueue(test.Scheduler, [0, 1], Worker, cancelled, cancellation.Token));
    Check(invoked == 0 && empty.Snapshot().SequenceEqual(new double[] { 100 }) && cancelled.Snapshot().SequenceEqual(new double[] { 100 }), "early empty/cancelled");
    results.Add(new { name = "empty-and-pre-cancelled", invoked, empty = empty.Snapshot(), cancelled = cancelled.Snapshot() });
}

{
    await using var test = new Harness(2); var work = new GateSet(3); var progress = new ProgressTrace();
    var task = Enqueue(test.Scheduler, [0, 1, 2], work.Work, progress);
    await Ready(Task.WhenAll(work.Entered[0].Task, work.Entered[1].Task));
    await Ready(test.Scheduler.DisposeAsync().AsTask());
    var enqueueCompletedAtDispose = task.IsCompleted;
    var afterDispose = new ProgressTrace(); var calledAfterDispose = false;
    await Ready(Enqueue(test.Scheduler, [9], (_, _) => { calledAfterDispose = true; return Task.CompletedTask; }, afterDispose));
    Check(!enqueueCompletedAtDispose && !calledAfterDispose && afterDispose.Snapshot().Length == 0, "dispose releases queued work but does not wait active callbacks");
    work.Release[0].TrySetResult(); work.Release[1].TrySetResult(); await Ready(task);
    Check(!work.Entered[2].Task.IsCompleted && progress.Last < 100, "dropped queued items do not report progress");
    results.Add(new { name = "dispose-active-and-queued", enqueueCompletedAtDispose, calledAfterDispose,
        work = work.Snapshot(), progress = progress.Snapshot(), afterDisposeProgress = afterDispose.Snapshot() });
}

{
    await using var test = new Harness(2); var work = new GateSet(3); var progress = new ProgressTrace();
    var task = Enqueue(test.Scheduler, [0, 1, 2], work.Work, progress);
    await Ready(Task.WhenAll(work.Entered[0].Task, work.Entered[1].Task)); test.Lifetime.StopApplication();
    work.Release[0].TrySetResult(); work.Release[1].TrySetResult(); await Until(() => test.RunnerCount == 0);
    var enqueueCompletedAtStop = task.IsCompleted;
    Check(!enqueueCompletedAtStop && !work.Entered[2].Task.IsCompleted, "application stop alone leaves queued completion pending");
    await Ready(test.Scheduler.DisposeAsync().AsTask()); await Ready(task);
    results.Add(new { name = "application-stop-then-dispose", enqueueCompletedAtStop, work = work.Snapshot(), progress = progress.Snapshot() });
}

await using (var test = new Harness(2))
{
    var first = new GateSet(2); var second = new GateSet(2);
    var a = Enqueue(test.Scheduler, [0, 1], first.Work, new ProgressTrace());
    await Ready(Task.WhenAll(first.Entered.Select(value => value.Task))); test.Configuration.LibraryScanFanoutConcurrency = 4;
    var b = Enqueue(test.Scheduler, [0, 1], second.Work, new ProgressTrace());
    await Ready(Task.WhenAll(second.Entered.Select(value => value.Task)));
    Check(first.Active + second.Active == 4 && test.RunnerCount == 4, "next pooled enqueue grows existing worker capacity");
    var simultaneous = first.Active + second.Active; first.ReleaseAll(); second.ReleaseAll(); await Ready(Task.WhenAll(a, b));
    results.Add(new { name = "configuration-two-to-four", simultaneous });
}

await using (var test = new Harness(4))
{
    var first = new GateSet(4); var second = new GateSet(4);
    var a = Enqueue(test.Scheduler, [0, 1, 2, 3], first.Work, new ProgressTrace());
    await Ready(Task.WhenAll(first.Entered.Select(value => value.Task))); test.Configuration.LibraryScanFanoutConcurrency = 2;
    var b = Enqueue(test.Scheduler, [0, 1, 2, 3], second.Work, new ProgressTrace()); first.ReleaseAll();
    await Ready(Task.WhenAll(second.Entered.Select(value => value.Task)));
    Check(second.Active == 4 && test.RunnerCount == 4, "lower configuration does not retire existing workers");
    var simultaneous = second.Active; second.ReleaseAll(); await Ready(Task.WhenAll(a, b));
    results.Add(new { name = "configuration-four-to-two", simultaneous });
}

await using (var test = new Harness(2))
{
    var first = new GateSet(3); var second = new GateSet(2);
    var a = Enqueue(test.Scheduler, [0, 1, 2], first.Work, new ProgressTrace());
    await Ready(Task.WhenAll(first.Entered[0].Task, first.Entered[1].Task)); test.Configuration.LibraryScanFanoutConcurrency = 1;
    var b = Enqueue(test.Scheduler, [0, 1], second.Work, new ProgressTrace()); await Ready(second.Entered[0].Task);
    var olderQueuedItemStarted = first.Entered[2].Task.IsCompleted; var simultaneous = first.Active + second.Active;
    Check(!olderQueuedItemStarted && simultaneous == 3, "sequential mode bypasses earlier pooled work");
    second.Release[0].TrySetResult(); await Ready(second.Entered[1].Task); second.Release[1].TrySetResult(); await Ready(b);
    first.ReleaseAll(); await Ready(a);
    results.Add(new { name = "configuration-two-to-one", olderQueuedItemStarted, simultaneous });
}

{
    await using var first = new Harness(2); await using var second = new Harness(2); var work = new GateSet(1);
    var task = Enqueue(first.Scheduler, [0], work.Work, new ProgressTrace()); await Ready(work.Entered[0].Task);
    await Ready(second.Scheduler.DisposeAsync().AsTask());
    var remainedActive = work.Active == 1 && !task.IsCompleted; Check(remainedActive, "scheduler instances own their lifetime");
    work.ReleaseAll(); await Ready(task); results.Add(new { name = "independent-instance-lifetime", remainedActive });
}

File.WriteAllText(args[0], JsonSerializer.Serialize(new { processorCount = Environment.ProcessorCount,
    controlledProgressSynchronizationContext = "Inline Post callback for stable per-slot progress observations; real scheduler queue/workers remain active.",
    scope = "Actual LimitedConcurrencyLibraryScheduler with controlled delegates, gates, live configuration and IHostApplicationLifetime. No library traversal, SQL, metadata providers, HTTP, watcher or release acceptance.",
    assembly = new { name = typeof(LimitedConcurrencyLibraryScheduler).Assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(LimitedConcurrencyLibraryScheduler).Assembly.Location))).ToLowerInvariant() }, results
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static Task Enqueue(LimitedConcurrencyLibraryScheduler scheduler, int[] data, Func<int, IProgress<double>, Task> worker,
    ProgressTrace progress, CancellationToken cancellation = default)
{
    var previous = SynchronizationContext.Current;
    try { SynchronizationContext.SetSynchronizationContext(new InlineContext()); return scheduler.Enqueue(data, worker, progress, cancellation); }
    finally { SynchronizationContext.SetSynchronizationContext(previous); }
}
static Task Ready(Task task) => task.WaitAsync(TimeSpan.FromSeconds(10));
static async Task Until(Func<bool> condition)
{
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    while (!condition()) await Task.Delay(1, timeout.Token);
}
static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

public sealed class GateSet(int count)
{
    private readonly object sync = new(); private readonly List<int> started = []; private int active; private int maximum;
    public TaskCompletionSource[] Entered { get; } = Enumerable.Range(0, count).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
    public TaskCompletionSource[] Release { get; } = Enumerable.Range(0, count).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
    public int Active { get { lock (sync) return active; } }
    public async Task Work(int item, IProgress<double> progress)
    {
        lock (sync) { started.Add(item); maximum = Math.Max(maximum, ++active); }
        Entered[item].TrySetResult();
        try { await Release[item].Task; } finally { lock (sync) active--; }
    }
    public void ReleaseAll() { foreach (var release in Release) release.TrySetResult(); }
    public object Snapshot() { lock (sync) return new { started = started.ToArray(), active, maximum }; }
}
public sealed class ProgressTrace : IProgress<double>
{
    private readonly object sync = new(); private readonly List<double> values = [];
    public void Report(double value) { lock (sync) values.Add(value); }
    public double? Last { get { lock (sync) return values.Count == 0 ? null : values[^1]; } }
    public double[] Snapshot() { lock (sync) return values.ToArray(); }
}
public sealed class ErrorLog : ILogger<LimitedConcurrencyLibraryScheduler>
{
    private readonly object sync = new(); private readonly List<string> errors = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => level >= LogLevel.Error;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    { if (level >= LogLevel.Error) lock (sync) errors.Add(exception?.GetType().Name ?? formatter(state, exception)); }
    public string[] Snapshot() { lock (sync) return errors.ToArray(); }
}
public sealed class Lifetime : IHostApplicationLifetime, IDisposable
{
    private readonly CancellationTokenSource stopping = new();
    public CancellationToken ApplicationStarted => CancellationToken.None;
    public CancellationToken ApplicationStopped => CancellationToken.None;
    public CancellationToken ApplicationStopping => stopping.Token;
    public void StopApplication() => stopping.Cancel();
    public void Dispose() => stopping.Dispose();
}
public sealed class Harness : IAsyncDisposable
{
    public ServerConfiguration Configuration { get; }
    public Lifetime Lifetime { get; } = new(); public ErrorLog Errors { get; } = new();
    public LimitedConcurrencyLibraryScheduler Scheduler { get; }
    public Harness(int fanout)
    {
        Configuration = new ServerConfiguration { LibraryScanFanoutConcurrency = fanout };
        var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
        ((ConfigurationProxy)(object)configuration).Configuration = Configuration;
        Scheduler = new LimitedConcurrencyLibraryScheduler(Lifetime, Errors, configuration);
    }
    public int RunnerCount => (int)typeof(LimitedConcurrencyLibraryScheduler).GetProperty("ActiveRunnerCount", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Scheduler)!;
    public async ValueTask DisposeAsync() { await Scheduler.DisposeAsync(); Lifetime.Dispose(); }
}
public class ConfigurationProxy : DispatchProxy
{
    public ServerConfiguration Configuration = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => method!.Name == "get_Configuration" ? Configuration : throw new NotSupportedException(method.Name);
}
public sealed class InlineContext : SynchronizationContext
{
    public override void Post(SendOrPostCallback callback, object? state) => callback(state);
}
