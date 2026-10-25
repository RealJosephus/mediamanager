// Invoke the frozen DLL comparer; no copied JavaScript rules are used here.
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.InteropServices;
using Emby.Server.Implementations.Sorting;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var options = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
var episodes = input.GetProperty("episodes").EnumerateArray().Select(fields =>
{
    var episode = new Episode();
    foreach (var field in fields.EnumerateObject())
    {
        var property = typeof(Episode).GetProperty(field.Name) ?? throw new InvalidOperationException(field.Name);
        var value = field.Value.Deserialize(property.PropertyType, options);
        property.SetValue(episode, value);
        if (!Equals(value, property.GetValue(episode))) throw new InvalidOperationException($"Episode property did not bind: {field.Name}");
    }
    return episode;
}).ToArray();
var sources = input.GetProperty("mediaSources").Deserialize<MediaSourceInfo?[]>(options)!;
foreach (var (source, index) in sources.Select((value, index) => (value, index)))
{
    var fields = input.GetProperty("mediaSources")[index];
    if (source is null) { if (fields.ValueKind != JsonValueKind.Null) throw new InvalidOperationException("Unexpected null source."); continue; }
    if (source.Path != fields.GetProperty("Path").Deserialize<string>(options)) throw new InvalidOperationException("Source Path did not bind.");
    if (source.Id != fields.GetProperty("Id").Deserialize<string>(options)
        || source.VideoType != fields.GetProperty("VideoType").Deserialize<VideoType?>(options)
        || source.Video3DFormat != fields.GetProperty("Video3DFormat").Deserialize<Video3DFormat?>(options))
        throw new InvalidOperationException("Source ordering fields did not bind.");
    var streams = fields.GetProperty("MediaStreams").EnumerateArray().ToArray();
    if (source.MediaStreams.Count != streams.Length) throw new InvalidOperationException("Source streams did not bind.");
    for (var streamIndex = 0; streamIndex < streams.Length; streamIndex++)
    {
        if (source.MediaStreams[streamIndex].Type.ToString() != streams[streamIndex].GetProperty("Type").GetString()
            || source.MediaStreams[streamIndex].Width != streams[streamIndex].GetProperty("Width").Deserialize<int?>(options))
            throw new InvalidOperationException("Source stream fields did not bind.");
    }
}
var comparer = new AiredEpisodeOrderComparer();
var comparisons = episodes.Select(left => episodes.Select(right => Math.Sign(comparer.Compare(left, right))).ToArray()).ToArray();
var widthComparer = new MediaSourceWidthComparator();
var widthComparisons = sources.Select(left => sources.Select(right => widthComparer.Compare(left, right)).ToArray()).ToArray();
var widthDescendingPairOrder = sources.Select((left, leftIndex) => sources.Select((right, rightIndex) =>
    new[] { (Source: left, Index: leftIndex), (Source: right, Index: rightIndex) }
        .OrderByDescending(entry => entry.Source, widthComparer).Select(entry => entry.Index).ToArray()).ToArray()).ToArray();
var widthSequenceOrder = input.GetProperty("widthSequences").EnumerateArray().Select(sequence => sequence.EnumerateArray()
    .Select((entry, index) => (Source: sources[entry.GetInt32()], Index: index))
    .OrderByDescending(entry => entry.Source, widthComparer).Select(entry => entry.Index).ToArray()).ToArray();
var fullSourceSequenceOrder = input.GetProperty("fullSourceSequences").EnumerateArray().Select(sequence => sequence.GetProperty("indices").EnumerateArray()
    .Select((entry, index) => (Source: sources[entry.GetInt32()]!, Index: index))
    .OrderByDescending(entry => string.Equals(entry.Source.Id, sequence.GetProperty("preferredId").GetString(), StringComparison.OrdinalIgnoreCase))
    .ThenBy(entry => entry.Source.VideoType == VideoType.VideoFile ? 0 : 1)
    .ThenBy(entry => entry.Source.Video3DFormat.HasValue ? 1 : 0)
    .ThenByDescending(entry => entry.Source, widthComparer).Select(entry => entry.Index).ToArray()).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { comparisons, widthComparisons, widthDescendingPairOrder, widthSequenceOrder, fullSourceSequenceOrder,
    runtime = new { frameworkDescription = RuntimeInformation.FrameworkDescription, version = Environment.Version.ToString(),
        coreAssembly = typeof(object).Assembly.Location, linqAssembly = typeof(Enumerable).Assembly.Location },
    bindingValidation = new { episodes = episodes.Length, mediaSources = sources.Length } }) + "\n");
