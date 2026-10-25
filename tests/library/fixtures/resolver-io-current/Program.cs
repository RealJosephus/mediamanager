using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;

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
var input = File.ReadAllBytes(args[0]);
var scenarios = JsonSerializer.Deserialize<Scenario[]>(input, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var results = new List<object>();
foreach (var scenario in scenarios) {
    await using var host = await NativeScanHost.CreateAsync(Path.Combine(args[2], scenario.Name), scenario);
    Folder parent = scenario.UseAggregateParent ? host.Manager.RootFolder : new Folder {
        Id = host.Manager.GetNewItemId(host.MediaPath("parent"), typeof(Folder)), Name = "Parent", Path = host.MediaPath("parent")
    };
    if (!scenario.UseAggregateParent) host.Manager.CreateItem(parent, null);
    File.WriteAllText(host.MediaPath("parent/Broken/VIDEO_TS/VTS_01_1.VOB"), "controlled unread media bytes");
    var files = new[] { "Before", "Broken", "After" }.Select(name => host.FileSystem.GetDirectoryInfo(host.MediaPath("parent/" + name))).ToArray();
    host.BeginObservation();
    object[] items = [];
    string? exception = null;
    try {
        items = host.Manager.ResolvePaths(files, host.DirectoryService, parent, new LibraryOptions(), CollectionType.movies)
            .Select(item => (object)new {
                item.Id, derivedId = host.Manager.GetNewItemId(item.Path, item.GetType()),
                type = item.GetType().FullName, item.Name, item.Path, item.IsFolder, videoType = (item as Video)?.VideoType.ToString()
            }).ToArray();
    } catch (Exception error) { exception = error.ToString(); }
    finally { host.EndObservation(); }
    results.Add(new {
        scenario.Name, caseRoot = host.CaseRoot, programDataPath = host.Paths.ProgramDataPath, mediaRoot = host.MediaRoot,
        parentId = parent.Id, parentType = parent.GetType().FullName, parentPath = parent.Path,
        parentIsPhysicalRoot = parent.IsPhysicalRoot, parentIsRoot = parent.IsRoot,
        host.ResolverTypes, items, exception, trace = host.Trace
    });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.FullName, StringComparer.Ordinal).Select(assembly => new {
        name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location))
    }).ToArray();
await using var output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write, FileShare.Read);
await JsonSerializer.SerializeAsync(output, new {
    actualExecution = true, inputSha256 = Hash(input), results, assemblies,
    sqlite = new { rid = RuntimeInformation.RuntimeIdentifier, filename = sqlitePath,
        sha256 = Hash(File.ReadAllBytes(sqlitePath)), actualResolverUsed = sqliteUsed }
}, new JsonSerializerOptions { WriteIndented = true });
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
