using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 3) throw new ArgumentException("Usage: Oracle <input.json> <new-output.json> <new-case-root>");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Scenario[]>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var caseRoot = Path.GetFullPath(args[2]);
if (Directory.Exists(caseRoot) || File.Exists(caseRoot)) throw new IOException("Case root must not exist: " + caseRoot);
Directory.CreateDirectory(caseRoot);
var output = new List<object>();
SynchronizationContext.SetSynchronizationContext(new InlineContext());
foreach (var scenario in input)
{
    await using var host = await NativeScanHost.CreateAsync(Path.Combine(caseRoot, scenario.Name), scenario);
    ScanObservation? warmup = null;
    if (scenario.Warmup)
    {
        warmup = await host.RunAsync(observe: false);
        if (warmup.Exception is not null) throw new InvalidOperationException("Warmup failed for " + scenario.Name + ": " + warmup.ExceptionMessage);
        host.ApplyChanges();
    }
    var observation = await host.RunAsync();
    await using(var partial = new FileStream(Path.Combine(caseRoot,scenario.Name,"observation.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
        await JsonSerializer.SerializeAsync(partial,observation,new JsonSerializerOptions { WriteIndented=true });
    output.Add(new { scenario.Name, warmup, observation });
}
var assemblies = new[] { typeof(NativeScanHost).Assembly, typeof(Emby.Server.Implementations.Library.LibraryManager).Assembly,
    typeof(MediaBrowser.Controller.Entities.Folder).Assembly, typeof(MediaBrowser.Providers.Manager.ProviderManager).Assembly,
    typeof(Jellyfin.Server.Implementations.Item.ItemPersistenceService).Assembly, typeof(Jellyfin.Server.CoreAppHost).Assembly,
    typeof(object).Assembly }.Distinct().Select(a => new { name = a.GetName().Name, path = a.Location,
        sha256 = Hash(File.ReadAllBytes(a.Location)) }).ToArray();
var result = new { inputSha256 = Hash(inputBytes), results = output, assemblies,
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    scope = "Actual LibraryManager.ValidateMediaLibraryInternal with real CreateRootFolder/GetUserRootFolder, CoreAppHost resolver discovery, ordinary Folder recursion, native scheduler, real Folder/Collection MetadataServices, EF SQLite repository/persistence and native post-task dispatch. Filesystem faults forward actual ManagedFileSystem except named failure; metadata late fault occurs after awaited actual ProviderManager refresh. Two post-task sentinel bodies and watcher lifecycle are controls. No full built-in post-task maintenance, real watcher, HTTP, media decoder or release acceptance." };
await using var stream = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write, FileShare.Read);
await JsonSerializer.SerializeAsync(stream, result, new JsonSerializerOptions { WriteIndented = true });
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

public sealed class InlineContext : SynchronizationContext
{
    public override void Post(SendOrPostCallback callback, object? state) => callback(state);
}
