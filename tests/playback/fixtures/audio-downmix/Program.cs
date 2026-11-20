using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;

var json = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
var samples = JsonSerializer.Deserialize<Sample[]>(File.ReadAllText(args[0]), json)!;
var helper = new EncodingHelper(null!, null!, null!, null!, null!, null!);
var results = samples.Select(sample =>
{
    var state = new EncodingJobInfo(TranscodingJobType.Hls)
    {
        IsInputVideo = true,
        IsVideoRequest = true,
        BaseRequest = new BaseEncodingJobOptions { AudioCodec = "ac3", MaxAudioChannels = 2, AudioBitRate = 192000 },
        AudioStream = new MediaStream { Codec = "aac", Channels = sample.Channels, ChannelLayout = sample.Layout },
        OutputAudioCodec = "ac3",
    };
    state.OutputAudioChannels = helper.GetNumAudioChannelsParam(state, state.AudioStream, "ac3");
    return new
    {
        sample.Name,
        Channels = state.OutputAudioChannels,
        Bitrate = helper.GetAudioBitrateParam(state.BaseRequest, state.AudioStream, state.OutputAudioChannels),
        FilterArgs = helper.GetAudioFilterParam(state, sample.Options),
    };
});
File.WriteAllText(args[1], JsonSerializer.Serialize(results, json));

public record Sample(string Name, int Channels, string? Layout, EncodingOptions Options);
