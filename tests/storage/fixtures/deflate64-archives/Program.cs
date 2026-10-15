using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

static object Failure(Exception error) => new { type = error.GetType().FullName, error.Message, error.HResult };
var archives = new List<object>();
foreach (var filename in args)
{
    var entries = new List<object>();
    object? archiveError = null;
    var archiveOpened = false;
    try
    {
        using var archive = ZipFile.OpenRead(filename);
        archiveOpened = true;
        foreach (var entry in archive.Entries)
        {
            var opened = false;
            string? sha256 = null;
            long? length = null;
            object? openError = null, readError = null;
            Stream? stream = null;
            try { stream = entry.Open(); opened = true; }
            catch (Exception error) { openError = Failure(error); }
            if (stream is not null)
            {
                using (stream)
                try
                {
                    using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    var bytes = new byte[65536];
                    length = 0;
                    int count;
                    while ((count = stream.Read(bytes)) != 0) { hash.AppendData(bytes.AsSpan(0, count)); length += count; }
                    sha256 = Convert.ToHexStringLower(hash.GetHashAndReset());
                }
                catch (Exception error) { readError = Failure(error); }
            }
            entries.Add(new { name = entry.FullName, entry.Length, entry.CompressedLength, opened, openError, readError, actualLength = length, sha256 });
        }
    }
    catch (Exception error) { archiveError = Failure(error); }
    archives.Add(new { filename, archiveOpened, archiveError, entries });
}
Console.WriteLine(JsonSerializer.Serialize(new { runtimeVersion = Environment.Version.ToString(), compressionAssembly = typeof(ZipArchive).Assembly.Location, zipFileAssembly = typeof(ZipFile).Assembly.Location, archives }));
