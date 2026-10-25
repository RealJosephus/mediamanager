using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.IO;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(input.GetProperty("root").GetString()!);
var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var rows = new List<object>();
foreach (var sample in input.GetProperty("samples").EnumerateArray()) {
    var filename = Path.GetFullPath(sample.GetProperty("filename").GetString()!);
    var relative = Path.GetRelativePath(root, filename);
    if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar))
        throw new InvalidOperationException("The sampled file must stay in its controlled directory.");
    var directory = sample.GetProperty("kind").GetString() == "directory";
    FileSystemInfo info = directory ? new DirectoryInfo(filename) : new FileInfo(filename);
    info.Refresh();
    if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
        throw new InvalidOperationException("A same-files observation requires an existing regular file or directory.");
    var metadata = directory ? fileSystem.GetDirectoryInfo(filename) : fileSystem.GetFileInfo(filename);
    var before = directory ? null : Bytes(filename);
    var actualCreation = fileSystem.GetCreationTimeUtc(info);
    var actualModified = fileSystem.GetLastWriteTimeUtc(info);
    rows.Add(new {
        name = sample.GetProperty("name").GetString(), filename, kind = directory ? "directory" : "file",
        bytesBefore = before, bytesAfter = directory ? null : Bytes(filename),
        publicInfo = new { info.Exists, creation = Date(info.CreationTimeUtc), modified = Date(info.LastWriteTimeUtc), accessed = Date(info.LastAccessTimeUtc) },
        managedPublicInfo = new { creation = Date(actualCreation), modified = Date(actualModified) },
        // The directory metadata wrapper has its own public default values.
        // Retain them separately from GetCreationTimeUtc(FileSystemInfo).
        managedMetadata = new { metadata.Exists, metadata.IsDirectory, metadata.Length,
            creation = Date(metadata.CreationTimeUtc), modified = Date(metadata.LastWriteTimeUtc) },
        managedMetadataOverload = new { creation = Date(fileSystem.GetCreationTimeUtc(metadata)), modified = Date(fileSystem.GetLastWriteTimeUtc(metadata)) },
        managedPathOverload = new { creation = Date(fileSystem.GetCreationTimeUtc(filename)), modified = Date(fileSystem.GetLastWriteTimeUtc(filename)) }
    });
}
var coreLib = typeof(object).Assembly;
var informational = coreLib.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
var sourceCommit = informational?.Split('+', 2).ElementAtOrDefault(1)?.Split('.', 2)[0];
var result = new {
    schemaVersion = 1, inputSha256 = Hash(inputBytes), actualManagedFileSystem = true,
    runtime = new { framework = RuntimeInformation.FrameworkDescription, version = Environment.Version.ToString(),
        runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, RuntimeInformation.OSDescription, RuntimeInformation.ProcessArchitecture,
        coreLib = AssemblyValue(coreLib), coreLibInformationalVersion = informational, sourceCommit },
    assemblies = new[] { AssemblyValue(typeof(ManagedFileSystem).Assembly), AssemblyValue(typeof(FileSystemMetadata).Assembly),
        AssemblyValue(typeof(MediaBrowser.Common.Configuration.IApplicationPaths).Assembly) },
    samples = rows
};
File.WriteAllText(args[1], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static object Date(DateTime value) => new { utc = value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture), ticks = value.Ticks.ToString(CultureInfo.InvariantCulture) };
static object Bytes(string filename) { var bytes = File.ReadAllBytes(filename); return new { length = bytes.Length, sha256 = Hash(bytes) }; }
static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
static object AssemblyValue(Assembly assembly) => new { name = assembly.GetName().Name, filename = assembly.Location,
    version = assembly.GetName().Version?.ToString(), informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
    metadata = assembly.GetCustomAttributes<AssemblyMetadataAttribute>().Select(value => new { key = value.Key, value = value.Value }).ToArray(),
    bytes = new FileInfo(assembly.Location).Length, sha256 = Hash(File.ReadAllBytes(assembly.Location)) };
