using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Providers;
using Microsoft.EntityFrameworkCore;

// Preparation only: not compiled or executed. The shared host invokes actual
// native discovery/global traversal and persistence; this runner supplies inputs
// and records observations, never traversal/provider expected return values.
if (args.Length != 3) throw new ArgumentException("Usage: Oracle matrix.json NEW_RUN_ROOT NEW_NATIVE_JSON");
var matrixPath = Path.GetFullPath(args[0]);
var runRoot = Path.GetFullPath(args[1]);
if (Directory.Exists(runRoot) || File.Exists(runRoot)) throw new IOException("The run root must be new.");
var output = Path.GetFullPath(args[2]);
if (File.Exists(output) || Directory.Exists(output)) throw new IOException("The recording must be new.");
var inputBytes = File.ReadAllBytes(matrixPath);
var matrix = JsonSerializer.Deserialize<Matrix>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(matrix.Culture);
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(matrix.Culture);
var assets = matrix.Assets.ToDictionary(value => value.Id, StringComparer.Ordinal);
foreach (var asset in assets.Values)
{
    var bytes = File.ReadAllBytes(asset.Filename);
    if (bytes.Length != asset.Bytes || Hash(bytes) != asset.Sha256) throw new IOException("Bound input changed: " + asset.Id);
}
Directory.CreateDirectory(runRoot);
var results = new List<object>();
foreach (var sample in matrix.Cases)
{
    if (sample.Name != Path.GetFileName(sample.Name) || string.IsNullOrWhiteSpace(sample.Name)) throw new IOException("Invalid case name.");
    var caseRoot = Path.Combine(runRoot, sample.Name);
    var scenario = new Scenario
    {
        Name = sample.Name, Fanout = 1,
        Libraries = [new LibrarySeed { Name = "Subjects", Locations = ["Subjects"],
            CollectionType = sample.CollectionType, SaveLocalMetadata = sample.SaveLocalMetadata, EnablePhotos = sample.EnablePhotos }]
    };
    await using var host = await NativeScanHost.CreateAsync(caseRoot, scenario, BookPhotoProviders.CreateImageProcessor);
    var registrations = BookPhotoProviders.Install(host);
    var observations = new List<object>();
    observations.Add(new { phase = "empty-subject-library", snapshot = Snapshot(host, caseRoot), trace = host.Trace });
    foreach (var step in sample.Steps)
    {
        var startedAt = DateTime.UtcNow;
        foreach (var change in step.Changes) ApplyChange(host, change);
        object? scan = null; string? error = null;
        try { scan = await host.RunAsync(); }
        catch (Exception exception) { error = exception.ToString(); }
        observations.Add(new { phase = step.Name, startedAt, endedAt = DateTime.UtcNow, scan, error,
            snapshot = Snapshot(host, caseRoot), trace = host.Trace, providerLogs = BookPhotoProviders.Logs.Snapshot() });
    }
    results.Add(new { sample.Name, sample.CollectionType, sample.SaveLocalMetadata, sample.EnablePhotos,
        root = caseRoot, registrations, observations });
}
var record = new
{
    actualExecution = true, inputSha256 = Hash(inputBytes), culture = matrix.Culture,
    intendedBoundary = "Actual CoreAppHost resolver discovery -> real LibraryManager roots/ValidateChildren/CreateItems -> real local Book/Photo services/providers -> actual image save/Skia/repository. Shared host exact source must be bound in the execution receipt.",
    httpExecuted = false, nativePostgresExecuted = false,
    declaredSeams = matrix.DeclaredSeams, results,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
        .Select(value => new { value.FullName, path = value.Location, sha256 = Hash(File.ReadAllBytes(value.Location)) }).ToArray()
};
using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    JsonSerializer.Serialize(stream, record, new JsonSerializerOptions { WriteIndented = true });
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count, output }));

void ApplyChange(NativeScanHost host, Change change)
{
    // All mutations are confined to the new host media tree. No entry key or
    // sidecar metadata value is promoted into an unvalidated access path.
    var target = CheckedMediaPath(host, change.Path);
    switch (change.Kind)
    {
        case "mkdir": Directory.CreateDirectory(target); break;
        case "remove-file": File.Delete(target); break;
        case "remove-directory": if (Directory.Exists(target)) Directory.Delete(target, true); break;
        case "move-file":
            var destination = CheckedMediaPath(host, change.Destination!);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!); File.Move(target, destination); break;
        case "copy":
            Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.Copy(assets[change.Asset!].Filename, target, true);
            File.SetLastWriteTimeUtc(target, DateTime.UtcNow); break;
        case "text":
            Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.WriteAllText(target, change.Text ?? "", new UTF8Encoding(false));
            File.SetLastWriteTimeUtc(target, DateTime.UtcNow); break;
        case "comic":
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using (var file = File.Create(target)) using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
            {
                using (var xml = archive.CreateEntry("ComicInfo.xml").Open()) xml.Write(Encoding.UTF8.GetBytes(change.Text ?? "<ComicInfo/>"));
                using (var cover = archive.CreateEntry("cover.png").Open()) cover.Write(File.ReadAllBytes(assets[change.Asset!].Filename));
            }
            File.SetLastWriteTimeUtc(target, DateTime.UtcNow); break;
        default: throw new InvalidOperationException("Undeclared input mutation: " + change.Kind);
    }
}
static string CheckedMediaPath(NativeScanHost host, string relative)
{
    if (Path.IsPathRooted(relative)) throw new IOException("Expected a relative media path.");
    var root = Path.GetFullPath(host.MediaPath(""));
    var filename = Path.GetFullPath(host.MediaPath(relative.Replace('/', Path.DirectorySeparatorChar)));
    if (!filename.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new IOException("The input mutation escapes its new media root.");
    return filename;
}
static object Snapshot(NativeScanHost host, string caseRoot)
{
    using var db = host.Factory.CreateDbContext();
    var connection = db.Database.GetDbConnection(); connection.Open();
    var tables = new List<string>();
    using (var command = connection.CreateCommand())
    {
        command.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        using var reader = command.ExecuteReader(); while (reader.Read()) tables.Add(reader.GetString(0));
    }
    var sql = new Dictionary<string, object>();
    foreach (var table in tables)
    {
        using var command = connection.CreateCommand(); command.CommandText = "SELECT * FROM \"" + table.Replace("\"", "\"\"") + "\"";
        using var reader = command.ExecuteReader(); var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var index = 0; index < reader.FieldCount; index++)
            {
                var value = reader.IsDBNull(index) ? null : reader.GetValue(index);
                row[reader.GetName(index)] = value is byte[] bytes ? new { binaryBase64 = Convert.ToBase64String(bytes) } : value;
            }
            rows.Add(row);
        }
        sql[table] = rows;
    }
    // Actual repository hydration, separate from the live manager cache.
    var ids = db.BaseItems.AsNoTracking().Select(value => value.Id).ToArray();
    var cold = host.Repository.GetItemList(new InternalItemsQuery { ItemIds = ids }).Select(item => new
    {
        item.Id, nativeType = item.GetType().FullName, item.Name, item.Path, item.ParentId, item.OwnerId,
        item.IsFolder, item.MediaType, seriesName = item.GetType().GetProperty("SeriesName")?.GetValue(item), item.IndexNumber, item.ParentIndexNumber,
        item.DateLastRefreshed, item.DateLastSaved, item.ProviderIds,
        imagePaths = item.ImageInfos.Select(image => new { image.Path, image.Type, image.Width, image.Height, image.BlurHash,
            sha256 = File.Exists(image.Path) ? Hash(File.ReadAllBytes(image.Path)) : null }).ToArray()
    }).ToArray();
    connection.Close();
    var files = Directory.EnumerateFiles(caseRoot, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
        .Select(filename => new { path = filename, bytes = new FileInfo(filename).Length,
            sha256 = FileHash(filename) }).ToArray();
    return new { sql, cold, files };
}
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static string FileHash(string filename)
{
    using var file = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
}
public sealed class Matrix { public string Culture { get; set; } = "en-US"; public Asset[] Assets { get; set; } = []; public Case[] Cases { get; set; } = []; public string[] DeclaredSeams { get; set; } = []; }
public sealed class Asset { public string Id { get; set; } = ""; public string Filename { get; set; } = ""; public long Bytes { get; set; } public string Sha256 { get; set; } = ""; }
public sealed class Case { public string Name { get; set; } = ""; public string CollectionType { get; set; } = ""; public bool SaveLocalMetadata { get; set; } public bool EnablePhotos { get; set; } = true; public Step[] Steps { get; set; } = []; }
public sealed class Step { public string Name { get; set; } = ""; public Change[] Changes { get; set; } = []; }
public sealed class Change { public string Kind { get; set; } = ""; public string Path { get; set; } = ""; public string? Destination { get; set; } public string? Asset { get; set; } public string? Text { get; set; } }
