using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;

if (args.Length != 3) throw new ArgumentException("Oracle <input.json> <new-output.json> <new-case-root>");
if (Directory.Exists(args[2]) || File.Exists(args[2])) throw new IOException("Case root must be new.");
var inputBytes = File.ReadAllBytes(args[0]);
var scenarios = JsonSerializer.Deserialize<Scenario[]>(inputBytes)!;
var results = new List<object>();
foreach (var scenario in scenarios)
{
    var root = Path.GetFullPath(Path.Combine(args[2], scenario.Name));
    await using var host = await NativeScanHost.CreateAsync(root, scenario);
    var seed = scenario.Seed;
    var source = new Folder { Id = Id(1), Name = seed.SourceName, Genres = [seed.Genre], Studios = [seed.Studio] };
    var dead = new BaseItem[] {
        new Genre { Id = Id(2), Name = seed.DeadGenre, Path = Path.Combine(host.Paths.GenrePath, seed.DeadGenre) },
        new Studio { Id = Id(3), Name = seed.DeadStudio, Path = Path.Combine(host.Paths.StudioPath, seed.DeadStudio) }
    };
    // Real persistence builds the initial complete rows and value relations.
    // The detached Folder is not a scanned path and survives empty-root validation.
    host.Persistence.SaveItems([source, ..dead], CancellationToken.None);
    using (var db = host.Factory.CreateDbContext())
    {
        db.ItemValues.Add(new ItemValue { ItemValueId = Id(4), Type = (ItemValueType)2,
            Value = seed.OrphanValue, CleanValue = seed.OrphanValue.ToLowerInvariant() });
        db.SaveChanges();
    }
    foreach (var item in dead)
    {
        Write(Path.Combine(item.Path, "source.txt"), "source marker\n");
        Write(Path.Combine(item.GetInternalMetadataPath(), "internal.txt"), "internal marker\n");
        foreach (var directory in host.PathManager.GetExtractedDataPaths(item))
            Write(Path.Combine(directory, "extracted.txt"), "extracted marker\n");
    }
    var before = new { sql = host.SnapshotSql(), files = Files(host.Paths.ProgramDataPath) };
    var startedAt = DateTime.UtcNow;
    var observation = await host.RunAsync();
    var completedAt = DateTime.UtcNow;
    results.Add(new { scenario.Name, seed, root, programRoot = host.Paths.ProgramDataPath,
        fixtureIds = new[] { source.Id, dead[0].Id, dead[1].Id }, orphanValueId = Id(4),
        discovered = host.DiscoveredPostScanTaskTypes, instantiated = host.PostScanTaskTypes,
        before, observation, startedAt, completedAt, files = Files(host.Paths.ProgramDataPath),
        createdDirectories = new[] { Genre.GetPath(seed.Genre), Studio.GetPath(seed.Studio) }
            .Select(filename => new { path = Path.GetRelativePath(host.Paths.ProgramDataPath, filename).Replace('\\', '/'),
                exists = Directory.Exists(filename) }).ToArray() });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.FullName, StringComparer.Ordinal)
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
await using var output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write, FileShare.Read);
await JsonSerializer.SerializeAsync(output, new {
    scope = "Actual CoreAppHost.GetExports constructs all eight built-in post-scan services; actual LibraryManager.ValidateMediaLibraryInternal dispatches them. Real Genre/Studio MetadataService, ItemPersistenceService, SQLite, PathManager and ExternalDataManager execute nonempty creation and file cleanup. No external metadata/image providers, metadata savers, media streams, image composition or watcher are admitted by this scenario.",
    inputSha256 = Hash(inputBytes), results, assemblies
}, new JsonSerializerOptions { WriteIndented = true });

static Guid Id(int number) => Guid.Parse("ba390000-0000-0000-0000-" + number.ToString("D12"));
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static void Write(string filename, string value)
{
    Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
    File.WriteAllText(filename, value);
}
static object[] Files(string root) => new[] { "metadata", "data" }.Select(folder => Path.Combine(root, folder))
    .Where(Directory.Exists).SelectMany(folder => Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
    .OrderBy(filename => filename, StringComparer.Ordinal).Select(filename => {
        var bytes = File.ReadAllBytes(filename);
        return (object)new { path = Path.GetRelativePath(root, filename).Replace('\\', '/'), bytes = bytes.Length,
            sha256 = Hash(bytes), content = Convert.ToBase64String(bytes) };
    }).ToArray();
