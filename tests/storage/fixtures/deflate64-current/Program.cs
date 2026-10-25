using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

static object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.HResult };
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var archives = new List<object>();
foreach (var sample in input.RootElement.GetProperty("archives").EnumerateArray()) {
    var name = sample.GetProperty("name").GetString()!;
    var filename = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, sample.GetProperty("filename").GetString()!));
    var entries = new List<object>();
    object? archiveError = null;
    var archiveOpened = false;
    try {
        using var archive = ZipFile.OpenRead(filename);
        archiveOpened = true;
        foreach (var entry in archive.Entries) {
            var opened = false;
            string? sha256 = null;
            long? length = null;
            object? openError = null, readError = null;
            Stream? stream = null;
            try { stream = entry.Open(); opened = true; }
            catch (Exception error) { openError = Failure(error); }
            if (stream is not null) {
                using (stream)
                try {
                    using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    var bytes = new byte[65536];
                    length = 0;
                    int count;
                    while ((count = stream.Read(bytes)) != 0) { hash.AppendData(bytes.AsSpan(0, count)); length += count; }
                    sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                } catch (Exception error) { readError = Failure(error); }
            }
            entries.Add(new { name = entry.FullName, entry.Length, entry.CompressedLength, opened, openError, readError, actualLength = length, sha256 });
        }
    } catch (Exception error) { archiveError = Failure(error); }
    archives.Add(new { name, inputSha256 = Hash(File.ReadAllBytes(filename)), filename, archiveOpened, archiveError, entries });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualExecution = true, inputSha256 = Hash(inputBytes), archives,
    assemblies = new[] { typeof(ZipArchive).Assembly, typeof(ZipFile).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location))
    })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
