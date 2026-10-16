using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;

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
    List<BaseItem> sources = [source];
    List<BaseItem> dead = [
        new Genre { Id = Id(2), Name = seed.DeadGenre, Path = Path.Combine(host.Paths.GenrePath, seed.DeadGenre) },
        new Studio { Id = Id(3), Name = seed.DeadStudio, Path = Path.Combine(host.Paths.StudioPath, seed.DeadStudio) }
    ];
    List<string> createdDirectories = [Genre.GetPath(seed.Genre), Studio.GetPath(seed.Studio)];
    if (seed.Music is { } music)
    {
        sources.AddRange(music.Tracks.Select((track, index) => new Audio {
            Id = Id(10 + index), Name = track.Name, Artists = track.Artists, AlbumArtists = track.AlbumArtists,
            Genres = track.Genres, RunTimeTicks = track.RunTimeTicks
        }));
        dead.Add(new MusicArtist { Id = Id(5), Name = music.DeadArtist,
            Path = MusicArtist.GetPath(music.DeadArtist) });
        createdDirectories.AddRange(music.Tracks.SelectMany(track => track.Artists.Concat(track.AlbumArtists))
            .Distinct(StringComparer.Ordinal).Select(name => MusicArtist.GetPath(name)));
        createdDirectories.AddRange(music.Tracks.SelectMany(track => track.Genres)
            .Distinct(StringComparer.Ordinal).Select(name => MusicGenre.GetPath(name)));
    }
    // Real persistence builds the initial complete rows and value relations.
    // Detached source rows survive empty-root validation; the Audio rows are
    // metadata children, never substituted audio-probe or file-scan results.
    host.Persistence.SaveItems([..sources, ..dead], CancellationToken.None);
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
    // Retain the actual operation even if a later disposal fails or hangs.
    await File.WriteAllTextAsync(Path.Combine(root, "scan-observation.json"), JsonSerializer.Serialize(
        new { scenario.Name, scenario.Cancel, inputSha256 = Hash(inputBytes), before, observation, startedAt, completedAt },
        new JsonSerializerOptions { WriteIndented = true }));
    await host.DisposeAsync();
    results.Add(new { scenario.Name, scenario.Cancel, seed, root, programRoot = host.Paths.ProgramDataPath,
        fixtureIds = sources.Concat(dead).Select(item => item.Id).ToArray(), orphanValueId = Id(4),
        discovered = host.DiscoveredPostScanTaskTypes, instantiated = host.PostScanTaskTypes,
        before, observation, startedAt, completedAt, files = Files(host.Paths.ProgramDataPath),
        release = new { completed = host.DisposalCompleted, resources = host.ReleasedResources.ToArray() },
        createdDirectories = createdDirectories
            .Select(filename => new { path = Path.GetRelativePath(host.Paths.ProgramDataPath, filename).Replace('\\', '/'),
                exists = Directory.Exists(filename) }).ToArray() });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.FullName, StringComparer.Ordinal)
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
await using var output = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write, FileShare.Read);
await JsonSerializer.SerializeAsync(output, new {
    scope = "Actual CoreAppHost.GetExports constructs all eight built-in post-scan services; actual LibraryManager.ValidateMediaLibraryInternal dispatches them. Real Genre/Studio and, for the music input, Artist/MusicGenre MetadataService, ItemPersistenceService, SQLite, PathManager and ExternalDataManager execute nonempty creation, child aggregation and file cleanup. No external metadata/image providers, metadata savers, media probe, image composition or watcher are admitted by these scenarios.",
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
