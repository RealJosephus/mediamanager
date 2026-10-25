using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var nodeBytes = File.ReadAllBytes(args[1]);
var neutralOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
var input = JsonSerializer.Deserialize<Sample[]>(inputBytes, neutralOptions) ?? throw new InvalidOperationException("Missing samples.");
var node = JsonSerializer.Deserialize<NodeInput>(nodeBytes, neutralOptions) ?? throw new InvalidOperationException("Missing Node input.");
// Video's mapper queries recording state even when only its persisted Data is observed.
Video.RecordingsManager = new EmptyRecordingsManager();
var results = new List<object>();
var items = new List<object>();
foreach (var sample in input)
{
    var text = string.Concat(sample.CodeUnits.Select(value => (char)value));
    var source = node.Cases.Single(value => value.Name == sample.Name);
    var frame = new Frame {
        UserId = text, Values = [text, null],
        Dictionary = new Dictionary<string, string?> { [text] = text, ["Null"] = null }, Ticks = long.MaxValue
    };
    foreach (var profile in new[] { "Default", "PascalCase", "CamelCase" })
    {
        var options = profile == "Default" ? JsonDefaults.Options
            : profile == "PascalCase" ? JsonDefaults.PascalCaseOptions : JsonDefaults.CamelCaseOptions;
        var body = source.Bodies.Single(value => value.Profile == profile).Body;
        var read = JsonSerializer.Deserialize<Frame>(body, options) ?? throw new InvalidOperationException("Missing Node frame.");
        results.Add(new { name = sample.Name, profile, body = JsonSerializer.Serialize(frame, options),
            nodeReadBody = JsonSerializer.Serialize(read, options) });
    }
    var item = new Video { Container = text, Name = "JSON value", SortName = "json value" };
    var entity = BaseItemMapper.Map(item, null!);
    var data = entity.Data ?? throw new InvalidOperationException("Native item Data is missing.");
    var nativeRead = (Video)(BaseItemMapper.DeserializeBaseItem(entity, NullLogger.Instance, null)
        ?? throw new InvalidOperationException("Native did not read its item Data."));
    entity.Data = source.Data;
    var nodeRead = (Video)(BaseItemMapper.DeserializeBaseItem(entity, NullLogger.Instance, null)
        ?? throw new InvalidOperationException("Native did not read Node item Data."));
    items.Add(new { name = sample.Name, data, nativeReadContainer = nativeRead.Container, nodeReadContainer = nodeRead.Container });
}
File.WriteAllText(args[2], JsonSerializer.Serialize(new {
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    nodeInputSha256 = Convert.ToHexStringLower(SHA256.HashData(nodeBytes)), results, items
}, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));

public sealed class Sample {
    public required string Name { get; init; }
    public required int[] CodeUnits { get; init; }
}
public sealed class NodeInput {
    public required NodeCase[] Cases { get; init; }
}
public sealed class NodeCase {
    public required string Name { get; init; }
    public required string Data { get; init; }
    public required NodeBody[] Bodies { get; init; }
}
public sealed class NodeBody {
    public required string Profile { get; init; }
    public required string Body { get; init; }
}
public sealed class Frame {
    public string UserId { get; set; } = "";
    public string? Missing { get; set; }
    public string?[] Values { get; set; } = [];
    public Dictionary<string, string?> Dictionary { get; set; } = new();
    public long Ticks { get; set; }
}

public sealed class EmptyRecordingsManager : IRecordingsManager {
    public ActiveRecordingInfo? GetActiveRecordingInfo(string path) => null;
    public string? GetActiveRecordingPath(string id) => throw new NotSupportedException("Recording path lookup is outside this JSON probe.");
    public IEnumerable<VirtualFolderInfo> GetRecordingFolders() => throw new NotSupportedException("Recording folders are outside this JSON probe.");
    public Task CreateRecordingFolders() => throw new NotSupportedException("Recording folders are outside this JSON probe.");
    public void CancelRecording(string timerId, TimerInfo? timer) => throw new NotSupportedException("Recording cancellation is outside this JSON probe.");
    public Task RecordStream(ActiveRecordingInfo recordingInfo, BaseItem channel, DateTime recordingEndDate)
        => throw new NotSupportedException("Recording execution is outside this JSON probe.");
}
