using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Providers;
using Microsoft.EntityFrameworkCore;

// The unchanged matrix supplies all fourteen cases and sixty-one mutations.
// Its historical absolute asset names are descriptive only: the separately
// bound asset directory supplies the exact original bytes on this runner.
if (args.Length != 4) throw new ArgumentException("Usage: Oracle matrix.json ASSET_DIRECTORY NEW_RUN_ROOT NEW_NATIVE_JSON");
var matrixPath = Path.GetFullPath(args[0]);
var assetRoot = Path.GetFullPath(args[1]);
var runRoot = Path.GetFullPath(args[2]);
var output = Path.GetFullPath(args[3]);
if (Directory.Exists(runRoot) || File.Exists(runRoot) || File.Exists(output) || Directory.Exists(output))
    throw new IOException("The recording and case root must be new.");
var inputBytes = File.ReadAllBytes(matrixPath);
var matrix = JsonSerializer.Deserialize<Matrix>(inputBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(matrix.Culture);
CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(matrix.Culture);
var assets = matrix.Assets.ToDictionary(value => value.Id, StringComparer.Ordinal);
var assetBindings = new List<object>();
foreach (var asset in assets.Values)
{
    var declaredFilename = asset.Filename;
    var basename = Path.GetFileName(declaredFilename.Replace('\\', '/'));
    if (string.IsNullOrWhiteSpace(basename) || basename is "." or "..") throw new IOException("Invalid asset filename.");
    asset.Filename = Path.Combine(assetRoot, basename);
    var bytes = File.ReadAllBytes(asset.Filename);
    if (bytes.Length != asset.Bytes || Hash(bytes) != asset.Sha256) throw new IOException("Bound input changed: " + asset.Id);
    assetBindings.Add(new { asset.Id, declaredFilename, actualFilename = asset.Filename, bytes = bytes.Length, sha256 = Hash(bytes) });
}
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var skiaName = OperatingSystem.IsWindows() ? "libSkiaSharp.dll" : OperatingSystem.IsMacOS() ? "libSkiaSharp.dylib" : "libSkiaSharp.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var skiaFilename = Path.Combine(AppContext.BaseDirectory, skiaName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
var skiaHandle = NativeLibrary.Load(skiaFilename);
var sqliteObserved = false; var skiaObserved = false;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
{
    if (name != "e_sqlite3") return IntPtr.Zero;
    sqliteObserved = true; return sqliteHandle;
});
NativeLibrary.SetDllImportResolver(typeof(SkiaSharp.SKBitmap).Assembly, (name, _, _) =>
{
    if (name != "libSkiaSharp") return IntPtr.Zero;
    skiaObserved = true; return skiaHandle;
});
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
    var host = await NativeScanHost.CreateAsync(caseRoot, scenario, BookPhotoProviders.CreateImageProcessor);
    try
    {
        var registrations = BookPhotoProviders.Install(host);
        var observations = new List<object>();
        observations.Add(new { phase = "empty-subject-library", snapshot = Snapshot(host, caseRoot), trace = host.Trace });
        foreach (var step in sample.Steps)
        {
            var startedAt = DateTime.UtcNow;
            var mutations = new List<object>();
            foreach (var change in step.Changes) mutations.Add(await ApplyChange(host, change));
            var beforeScan = Snapshot(host, caseRoot);
            ScanObservation? scan = null; string? error = null;
            var scanStartedAt = DateTime.UtcNow;
            try { scan = await host.RunAsync(); }
            catch (Exception exception) { error = exception.ToString(); }
            var scanEndedAt = DateTime.UtcNow;
            observations.Add(new { phase = step.Name, startedAt, scanStartedAt, scanEndedAt,
                mutations, beforeScan, scan, error, succeeded = error is null && scan?.Exception is null,
                snapshot = Snapshot(host, caseRoot), trace = host.Trace, providerLogs = BookPhotoProviders.Logs.Snapshot() });
            // Overwrite only this new diagnostic file. A process failure leaves
            // the last completed public/SQL/file prefix and its real timestamps.
            File.WriteAllText(Path.Combine(caseRoot, "current-prefix.json"), JsonSerializer.Serialize(new {
                sample.Name, root = caseRoot, registrations, observations }));
        }
        results.Add(new { sample.Name, sample.CollectionType, sample.SaveLocalMetadata, sample.EnablePhotos,
            root = caseRoot, registrations, observations });
    }
    finally
    {
        await host.DisposeAsync();
        File.WriteAllText(Path.Combine(caseRoot, "release.json"), JsonSerializer.Serialize(new { completed = true }));
    }
}
var record = new
{
    actualExecution = true, inputSha256 = Hash(inputBytes), culture = matrix.Culture,
    intendedBoundary = "Actual designated CoreAppHost discovery, LibraryManager complete traversal, Book/Photo local providers, SQLite persistence, cold repository hydration, image saving and Skia. This preserves the historical real write-time and Native empty-saver controls; the Node candidate retains its default plugins.",
    httpExecuted = false, nativePostgresExecuted = false,
    declaredSeams = matrix.DeclaredSeams, assetBindings, results,
    nativeLibraries = new[] {
        new { name = sqliteName, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, path = sqliteFilename,
            sha256 = FileHash(sqliteFilename), resolverObserved = sqliteObserved },
        new { name = skiaName, runtimeIdentifier = OperatingSystem.IsMacOS() ? "osx" : RuntimeInformation.RuntimeIdentifier,
            path = skiaFilename, sha256 = FileHash(skiaFilename), resolverObserved = skiaObserved }
    },
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
        .Select(value => new { name = value.GetName().Name, value.FullName, path = value.Location, sha256 = FileHash(value.Location) }).ToArray()
};
using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    JsonSerializer.Serialize(stream, record, new JsonSerializerOptions { WriteIndented = true });
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count, output }));

async Task<object> ApplyChange(NativeScanHost host, Change change)
{
    var target = CheckedMediaPath(host, change.Path);
    var startedAt = DateTime.UtcNow;
    object? photoReplacementTiming = null;
    DateTime? previousModified = null;
    if (change.Kind == "copy" && new[] { ".jpg", ".jpeg", ".png", ".tiff", ".cr2", ".webp", ".avif" }
        .Contains(Path.GetExtension(target), StringComparer.OrdinalIgnoreCase) && File.Exists(target))
    {
        previousModified = File.GetLastWriteTimeUtc(target);
        var notBefore = previousModified.Value.AddMilliseconds(1100);
        var waitStartedAt = DateTime.UtcNow;
        var waiting = System.Diagnostics.Stopwatch.StartNew();
        while (DateTime.UtcNow < notBefore)
        {
            if (waiting.Elapsed > TimeSpan.FromSeconds(10)) throw new IOException("Real photo replacement time did not become observable.");
            await Task.Delay(TimeSpan.FromMilliseconds(Math.Clamp((notBefore - DateTime.UtcNow).TotalMilliseconds, 1, 100)));
        }
        photoReplacementTiming = new { previousModified, waitStartedAt, notBefore, waitEndedAt = DateTime.UtcNow };
    }
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
    var observed = change.Kind == "move-file" ? CheckedMediaPath(host, change.Destination!) : target;
    if (previousModified is not null && File.GetLastWriteTimeUtc(observed) - previousModified.Value <= TimeSpan.FromSeconds(1))
        throw new IOException("The actual photo overwrite did not cross the public one-second change window.");
    return new { change.Kind, change.Path, change.Destination, startedAt, endedAt = DateTime.UtcNow,
        exists = File.Exists(observed) || Directory.Exists(observed),
        lastWriteTimeUtc = File.Exists(observed) ? (DateTime?)File.GetLastWriteTimeUtc(observed) : null,
        sha256 = File.Exists(observed) ? FileHash(observed) : null, photoReplacementTiming };
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
    // Read each item through the real repository, independently of live cache.
    var ids = db.BaseItems.AsNoTracking().Select(value => value.Id).ToArray();
    var cold = host.Repository.GetItemList(new InternalItemsQuery { ItemIds = ids }).Select(item => new
    {
        item.Id, nativeType = item.GetType().FullName, item.Name, item.Path, item.ParentId, item.OwnerId,
        item.IsFolder, item.MediaType, seriesName = item.GetType().GetProperty("SeriesName")?.GetValue(item), item.IndexNumber, item.ParentIndexNumber,
        item.DateCreated, item.DateModified, item.DateLastRefreshed, item.DateLastSaved, item.ProviderIds,
        imagePaths = item.ImageInfos.Select(image => new { image.Path, image.Type, image.Width, image.Height, image.BlurHash,
            sha256 = File.Exists(image.Path) ? FileHash(image.Path) : null,
            base64 = File.Exists(image.Path) ? Convert.ToBase64String(File.ReadAllBytes(image.Path)) : null }).ToArray()
    }).ToArray();
    connection.Close();
    var media = Path.Combine(caseRoot, "media") + Path.DirectorySeparatorChar;
    var metadata = Path.Combine(caseRoot, "program", "metadata") + Path.DirectorySeparatorChar;
    var files = Directory.EnumerateFiles(caseRoot, "*", SearchOption.AllDirectories)
        .Where(filename => Path.GetFileName(filename) != "current-prefix.json")
        .Order(StringComparer.Ordinal).Select(filename => new { path = filename, bytes = new FileInfo(filename).Length,
            lastWriteTimeUtc = File.GetLastWriteTimeUtc(filename), sha256 = FileHash(filename),
            base64 = filename.StartsWith(media, StringComparison.Ordinal) || filename.StartsWith(metadata, StringComparison.Ordinal)
                ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null }).ToArray();
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
