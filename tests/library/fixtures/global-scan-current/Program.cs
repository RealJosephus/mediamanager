using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 3) throw new ArgumentException("Oracle <input.json> <new-output.json> <new-case-root>");
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqlitePath = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqlitePath);
var sqliteUsed = false;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => {
    if (name != "e_sqlite3") return IntPtr.Zero;
    sqliteUsed = true;
    return sqliteHandle;
});
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Scenario[]>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var caseRoot = Path.GetFullPath(args[2]);
if (Directory.Exists(caseRoot) || File.Exists(caseRoot)) throw new IOException("Case root must be fresh: " + caseRoot);
Directory.CreateDirectory(caseRoot);
SynchronizationContext.SetSynchronizationContext(new InlineContext());
var results = new List<object>();
foreach (var scenario in input) {
    var startedAt = DateTimeOffset.UtcNow;
    await using var host = await NativeScanHost.CreateAsync(Path.Combine(caseRoot, scenario.Name), scenario);
    ScanObservation? warmup = null;
    if (scenario.Warmup) {
        warmup = await host.RunAsync(observe: false);
        if (warmup.Exception is not null) throw new InvalidOperationException("Warmup failed: " + warmup.ExceptionMessage);
        host.ApplyChanges();
    }
    var observation = await host.RunAsync();
    var finishedAt = DateTimeOffset.UtcNow;
    await using (var partial = new FileStream(Path.Combine(host.CaseRoot, "observation.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        await JsonSerializer.SerializeAsync(partial, observation, new JsonSerializerOptions { WriteIndented = true });
    results.Add(new { scenario.Name, caseRoot = host.CaseRoot, programDataPath = host.Paths.ProgramDataPath,
        mediaRoot = host.MediaRoot, startedAt, finishedAt, warmup, observation });
}
var readerFilename = Path.Combine(caseRoot, "one-ordinary-directory-tree", "native.db");
var readerBefore = Hash(File.ReadAllBytes(readerFilename));
var reader = Readback.Run(readerFilename);
var readerAfter = Hash(File.ReadAllBytes(readerFilename));
if (readerBefore != readerAfter) throw new IOException("The cold reader changed its source database.");
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.FullName, StringComparer.Ordinal).Select(assembly => new {
        name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location))
    }).ToArray();
await using var output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write, FileShare.Read);
await JsonSerializer.SerializeAsync(output, new {
    actualGlobalScan = true, inputSha256 = Hash(inputBytes), results, assemblies, reader,
    readerDatabase = new { filename = readerFilename, beforeSha256 = readerBefore, afterSha256 = readerAfter },
    sqlite = new { rid = RuntimeInformation.RuntimeIdentifier, filename = sqlitePath,
        sha256 = Hash(File.ReadAllBytes(sqlitePath)), actualResolverUsed = sqliteUsed }
}, new JsonSerializerOptions { WriteIndented = true });
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

public sealed class InlineContext : SynchronizationContext {
    public override void Post(SendOrPostCallback callback, object? state) => callback(state);
}
