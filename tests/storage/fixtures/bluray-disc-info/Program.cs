using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using BDInfo;
using Emby.Server.Implementations;
using Emby.Server.Implementations.IO;
using MediaBrowser.MediaEncoding.BdInfo;
using Microsoft.Extensions.Logging.Abstractions;

if (args.Length != 3) throw new ArgumentException("Usage: Oracle <input.json> <disc-directory> <output-directory>");
var input = File.ReadAllBytes(args[0]);
using var scenario = JsonDocument.Parse(input);
var packageVersion = scenario.RootElement.GetProperty("referencePackage").GetProperty("version").GetString();
if (typeof(BDROM).Assembly.GetName().Version?.ToString(3) != packageVersion)
    throw new InvalidOperationException("The supplied BDInfo assembly does not match the controlled reference package.");
var root = Path.GetFullPath(args[1]);
var output = Path.GetFullPath(args[2]);
var paths = new ServerApplicationPaths(output, output, output, output, output);
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
var directory = BdInfoDirectoryInfo.FromFileSystemPath(fileSystem, root);
var disc = new BDROM(directory);
disc.Scan();
var expectedClips = scenario.RootElement.GetProperty("clips").EnumerateArray().Select(c => c.GetProperty("id").GetString() + ".CLPI").Order().ToArray();
var expectedPlaylists = scenario.RootElement.GetProperty("playlists").EnumerateArray().Select(p => p.GetProperty("id").GetString() + ".MPLS").Order().ToArray();
if (!disc.StreamClipFiles.Keys.Order().SequenceEqual(expectedClips) || !disc.PlaylistFiles.Keys.Order().SequenceEqual(expectedPlaylists))
    throw new InvalidOperationException("The materialized disc does not contain the declared input records.");
var selected = disc.PlaylistFiles.Values.OrderByDescending(p => p.TotalLength).FirstOrDefault(p => p.IsValid);
if (selected is null) throw new InvalidOperationException("The controlled disc must have a valid playlist.");
// Capture the actual examiner result without removing fields. The separate
// projection compares only fields implemented by the Node planning helper.
var actual = new BdInfoExaminer(fileSystem).GetDiscInfo(root);
string Relative(string value) => Path.GetRelativePath(root, value).Replace('\\', '/');
object Baseline(TSStream stream)
{
    var fields = new Dictionary<string, object?>();
    if (stream is TSVideoStream video) {
        fields["Type"] = "Video";
        fields["Height"] = video.Height;
        fields["IsInterlaced"] = video.IsInterlaced;
        if (video.FrameRateDenominator > 0) {
            fields["AverageFrameRate"] = (float)video.FrameRateEnumerator / video.FrameRateDenominator;
            fields["RealFrameRate"] = (float)video.FrameRateEnumerator / video.FrameRateDenominator;
        }
    } else if (stream is TSAudioStream audio) {
        fields["Type"] = "Audio"; fields["Language"] = audio.LanguageCode; fields["SampleRate"] = audio.SampleRate;
    } else { fields["Type"] = "Subtitle"; fields["Language"] = stream.LanguageCode; }
    // Use the fork's public conversion rather than a second codec-name table.
    var converted = actual.MediaStreams[Array.FindIndex(selected.SortedStreams.ToArray(), s => ReferenceEquals(s, stream))];
    fields["Codec"] = converted.Codec;
    return fields;
}
var baselines = selected.SortedStreams.Select(stream => new {
    pid = stream.PID, streamType = (byte)stream.StreamType, angleIndex = stream.AngleIndex, mediaStream = Baseline(stream)
}).ToArray();
Assembly.Load("jellyfin");
var assemblies = new[] { typeof(BDROM).Assembly, typeof(BdInfoExaminer).Assembly, Assembly.Load("jellyfin") }
    .Select(assembly => new { name = assembly.GetName().Name, version = assembly.GetName().Version?.ToString(),
        informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
var observation = new {
    inputSha256 = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(), assemblies,
    actual,
    plan = new { playlistName = selected.Name, runTimeTicks = actual.RunTimeTicks, chapters = selected.Chapters,
        files = selected.StreamClips.Where(c => c.AngleIndex == 0).Select(c => new { virtualPath = Relative(c.StreamFile.FileInfo.FullName), timeIn = c.TimeIn, timeOut = c.TimeOut, relativeTimeIn = c.RelativeTimeIn }),
        streams = baselines },
    playlists = disc.PlaylistFiles.Values.Select(p => new { p.Name, p.IsValid, p.HasLoops, p.TotalLength }),
    sourceFiles = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Select(filename => new {
        path = Relative(filename), size = new FileInfo(filename).Length,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filename))).ToLowerInvariant() })
};
File.WriteAllText(Path.Combine(output, "native.json"), JsonSerializer.Serialize(observation, new JsonSerializerOptions { WriteIndented = true }));
