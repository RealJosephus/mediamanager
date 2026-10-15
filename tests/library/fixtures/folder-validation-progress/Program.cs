using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging.Abstractions;

var input = File.ReadAllBytes(args[0]);
var results = new List<object>();
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) =>
    method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
foreach (var sample in JsonDocument.Parse(input).RootElement.EnumerateArray())
{
    var progress = new List<double>();
    var providerProgress = new List<double>();
    var calls = new List<string>();
    using var cancellation = new CancellationTokenSource();
    var failure = sample.TryGetProperty("failAt", out var fail) ? fail.GetString() : null;
    void Observe(string operation)
    {
        calls.Add(operation);
        if (failure == operation) throw new IOException("Controlled " + operation + " failure.");
    }
    var parent = new ProbeFolder { Id = Id(1), Name = "Parent", Path = "Z:\\Progress" };
    var children = Enumerable.Range(0, sample.GetProperty("childCount").GetInt32()).Select(index =>
        (BaseItem)new Video { Id = Id(index + 2), ParentId = parent.Id, Name = "Child " + index,
            Path = "Z:\\Progress\\" + index + ".mkv" }).ToArray();
    var current = sample.TryGetProperty("currentCount", out var count) ? Enumerable.Range(0, count.GetInt32())
        .Select(index => (BaseItem)new Photo { Id = Id(index + 1000), ParentId = parent.Id,
            Name = "Removed " + index, Path = "Z:\\Progress\\removed-" + index + ".mkv" }).ToArray() : [];
    IEnumerable<BaseItem> Enumerate()
    {
        Observe("enumeration");
        foreach (var child in children) yield return child;
    }
    parent.Resolve = () => { Observe("retrieval"); return Enumerate(); };
    BaseItem.ItemRepository = Stub.Make<IItemRepository>((method, _) =>
    {
        if (method.Name != "GetItemList") return Stub.Default(method.ReturnType);
        Observe("load");
        return current;
    });
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) =>
    {
        if (method.Name == "GetItemById") return (Guid)values![0]! == parent.Id ? parent : null;
        if (method.Name == "CreateItems") Observe("create");
        if (method.Name == "DeleteItem") Observe("delete");
        return Stub.Default(method.ReturnType);
    });
    BaseItem.ProviderManager = Stub.Make<IProviderManager>((method, values) =>
    {
        if (method.Name == "OnRefreshStart") calls.Add("start");
        if (method.Name == "OnRefreshComplete") calls.Add("complete");
        if (method.Name == "OnRefreshProgress") providerProgress.Add((double)values![1]!);
        return Stub.Default(method.ReturnType);
    });
    if (sample.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
    var reporter = new InlineProgress(value =>
    {
        progress.Add(value);
        if (sample.TryGetProperty("cancelAt", out var at) && at.GetDouble() == value) cancellation.Cancel();
    });
    string? exception = null;
    Exception? caught = null;
    try
    {
        var recursive = sample.TryGetProperty("recursive", out var recur) && recur.GetBoolean();
        await parent.Validate(reporter, recursive, cancellation.Token);
    }
    catch (Exception error) { exception = error.GetType().Name; caught = error; }
    var expectedException = failure is "load" or "create" or "delete" ? "IOException"
        : failure is "retrieval" or "enumeration" ? null
        : sample.TryGetProperty("cancelAt", out _) || sample.TryGetProperty("cancelled", out _) ? "OperationCanceledException" : null;
    if (exception != expectedException) throw new InvalidOperationException(
        sample.GetProperty("name").GetString() + ": unexpected exception " + exception, caught);
    results.Add(new { name = sample.GetProperty("name").GetString(), progress, providerProgress, calls, exception });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    inputSha256 = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),
    assembly = new { name = typeof(Folder).Assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(Folder).Assembly.Location))).ToLowerInvariant() },
    results
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static Guid Id(int index) => Guid.Parse($"81000000-0000-0000-0000-{index:000000000000}");

public sealed class ProbeFolder : Folder
{
    public Func<IEnumerable<BaseItem>> Resolve = null!;
    public override string GetClientTypeName() => "Folder";
    protected override IEnumerable<BaseItem> GetNonCachedChildren(IDirectoryService directoryService) => Resolve();
    public Task Validate(IProgress<double> progress, bool recursive, CancellationToken token) =>
        base.ValidateChildrenInternal(progress, recursive, false, false, null!, null!, token);
}

public sealed class InlineProgress(Action<double> report) : IProgress<double>
{
    public void Report(double value) => report(value);
}

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>();
        ((Stub)(object)value).Handler = handler;
        return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null
        : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
