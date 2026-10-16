using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

if (args.Length != 2) throw new ArgumentException("Usage: Oracle <input.json> <new-output-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var scenarios = JsonSerializer.Deserialize<Scenario[]>(inputBytes,
    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var outputRoot = Path.GetFullPath(args[1]);
var caseRoot = Path.Combine(outputRoot, "cases");
if (Directory.Exists(caseRoot) || File.Exists(caseRoot)) throw new IOException("The case root must be fresh.");
Directory.CreateDirectory(caseRoot);
SynchronizationContext.SetSynchronizationContext(new InlineContext());
var results = new List<object>();
foreach (var scenario in scenarios)
{
    var startedAt = DateTime.UtcNow;
    var host = await NativeScanHost.CreateAsync(Path.Combine(caseRoot, scenario.Name), scenario);
    object? result = null;
    try
    {
        ScanObservation? warmup = null;
        if (scenario.Warmup)
        {
            warmup = await host.RunAsync(observe: false);
            if (warmup.Exception is not null) throw new InvalidOperationException("Warmup failed: " + warmup.ExceptionMessage);
            host.ApplyChanges();
        }
        var observation = await host.RunAsync();
        var completedAt = DateTime.UtcNow;
        var reader = scenario.Name is "one-ordinary-directory-tree" or "deep-enumeration-after-baseline"
            ? ReadAggregate(host) : null;
        result = new { scenario, programRoot = host.Paths.ProgramDataPath, mediaRoot = host.MediaRoot,
            caseRoot = host.CaseRoot, startedAt, completedAt, warmup, observation, reader };
        await File.WriteAllTextAsync(Path.Combine(host.CaseRoot, "observation.json"),
            JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    }
    finally
    {
        await host.DisposeAsync();
        await File.WriteAllTextAsync(Path.Combine(host.CaseRoot, "release.json"),
            JsonSerializer.Serialize(new { completed = true, resources = host.ReleasedResources }));
    }
    results.Add(result!);
}
var assemblies = new[] { typeof(NativeScanHost).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly,
    typeof(Folder).Assembly, typeof(MediaBrowser.Providers.Manager.ProviderManager).Assembly,
    typeof(ItemPersistenceService).Assembly, typeof(Jellyfin.Server.CoreAppHost).Assembly, typeof(object).Assembly }
    .Distinct().Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
await File.WriteAllTextAsync(Path.Combine(outputRoot, "native.json"), JsonSerializer.Serialize(new {
    actualGlobalScan = true, actualBaseItemReader = true, inputSha256 = Hash(inputBytes), results, assemblies,
    platform = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription
}, new JsonSerializerOptions { WriteIndented = true }));

static object ReadAggregate(NativeScanHost host)
{
    using var db = host.Factory.CreateDbContext();
    var aggregate = db.BaseItems.AsNoTracking().Single(item => item.Type == typeof(AggregateFolder).FullName);
    var original = aggregate.Data!;
    var variants = new List<(string Name, string Data)> { ("actual-persisted-aggregate", original) };
    var extra = JsonNode.Parse(original)!.AsObject();
    foreach (var child in extra["VirtualChildren"]!.AsArray()) child!.AsObject()["IsRoot"] = false;
    variants.Add(("folder-IsRoot-extra", extra.ToJsonString()));
    var ignored = JsonNode.Parse(original)!.AsObject();
    ignored["VirtualChildren"] = "not an array";
    variants.Add(("readonly-container-invalid-token", ignored.ToJsonString()));
    var results = new List<object>();
    foreach (var variant in variants)
    {
        aggregate.Data = variant.Data;
        var cold = (AggregateFolder)BaseItemRepository.DeserializeBaseItem(aggregate, NullLogger.Instance, null)!;
        results.Add(new { variant.Name, virtualChildren = cold.VirtualChildren.Count, cold.Id, cold.Path, cold.IsRoot,
            physicalLocations = cold.PhysicalLocations,
            serializedData = JsonSerializer.Serialize(cold, Jellyfin.Extensions.Json.JsonDefaults.Options) });
    }
    return new { actualBaseItemRepositoryReader = true, actualSqliteSource = true, results };
}

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

public sealed class InlineContext : SynchronizationContext
{
    public override void Post(SendOrPostCallback callback, object? state) => callback(state);
}
