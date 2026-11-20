using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Configuration;

var json = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
var cases = JsonSerializer.Deserialize<VideoCase[]>(File.ReadAllText(args[0]), json)!;
var results = cases.Select(row =>
{
    var encoder = DispatchProxy.Create<IMediaEncoder, EncoderCapabilities>();
    ((EncoderCapabilities)(object)encoder).Capabilities = row.Capabilities;
    var helper = new HardwareEncodingHelper(encoder);
    var state = new EncodingJobInfo(TranscodingJobType.Hls)
    {
        BaseRequest = row.Request,
        IsVideoRequest = true,
        IsInputVideo = true,
        MediaSource = new MediaSourceInfo { VideoType = row.VideoType, MediaStreams = [row.Video] },
        VideoType = row.VideoType,
        VideoStream = row.Video,
        OutputVideoCodec = row.OutputCodec,
        OutputAudioCodec = "aac",
    };
    return new
    {
        row.Name,
        Encoder = helper.GetVideoEncoder(state, row.Options),
        Decoder = helper.Decoder(state, row.Options) ?? string.Empty,
        Input = helper.GetInputVideoHwaccelArgs(state, row.Options),
    };
});
File.WriteAllText(args[1], JsonSerializer.Serialize(results, json));

public record VideoCase(string Name, MediaStream Video, VideoType VideoType, string OutputCodec,
    BaseEncodingJobOptions Request, EncodingOptions Options, Capabilities Capabilities);

public record Capabilities(string[] Encoders, string[] Decoders, string[] Filters, string[] Hwaccels,
    Dictionary<string, bool> FilterOptions, string? VaapiDriver, bool VaapiVulkanInterop, bool VideotoolboxAv1,
    string Version);

public class HardwareEncodingHelper(IMediaEncoder mediaEncoder) :
    EncodingHelper(null!, mediaEncoder, null!, new ConfigurationBuilder().Build(), null!, null!)
{
    public string Decoder(EncodingJobInfo state, EncodingOptions options) => GetHardwareVideoDecoder(state, options);
}

public class EncoderCapabilities : DispatchProxy
{
    public Capabilities Capabilities { get; set; } = null!;

    protected override object? Invoke(MethodInfo? method, object?[]? arguments)
    {
        var caps = Capabilities;
        var name = arguments is { Length: > 0 } ? arguments[0]?.ToString() ?? string.Empty : string.Empty;
        return method?.Name switch
        {
            "get_EncoderVersion" => Version.Parse(caps.Version),
            "SupportsEncoder" => caps.Encoders.Contains(name, StringComparer.OrdinalIgnoreCase),
            "SupportsDecoder" => caps.Decoders.Contains(name, StringComparer.OrdinalIgnoreCase),
            "SupportsFilter" => caps.Filters.Contains(name, StringComparer.OrdinalIgnoreCase),
            "SupportsHwaccel" => caps.Hwaccels.Contains(name, StringComparer.OrdinalIgnoreCase),
            "SupportsFilterWithOption" => caps.FilterOptions.GetValueOrDefault(name),
            "get_IsVaapiDeviceInteliHD" => caps.VaapiDriver == "iHD",
            "get_IsVaapiDeviceInteli965" => caps.VaapiDriver == "i965",
            "get_IsVaapiDeviceAmd" => caps.VaapiDriver == "amd",
            "get_IsVaapiDeviceSupportVulkanDrmInterop" => caps.VaapiVulkanInterop,
            "get_IsVideoToolboxAv1DecodeAvailable" => caps.VideotoolboxAv1,
            _ when method?.ReturnType == typeof(bool) => false,
            _ => throw new InvalidOperationException(method?.Name),
        };
    }
}
