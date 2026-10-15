using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using MediaBrowser.MediaEncoding.Probing;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Dlna;
using Emby.Naming.Common;
using Emby.Naming.ExternalFiles;
using Microsoft.Extensions.Logging.Abstractions;
using Jellyfin.Extensions.Json;
using MediaBrowser.Providers.MediaInfo;
using MediaBrowser.Controller.Entities;
using System.Runtime.CompilerServices;

if (args[0] == "read-db") { NativeReader.Run(args[1], args[2]); return; }
var input = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(args[0]));
var local = DispatchProxy.Create<ILocalizationManager, LocalizationProxy>();
LocalizationProxy.Cultures = File.ReadAllLines(args[2]).Where(line => !string.IsNullOrWhiteSpace(line)).Select(line => line.Split('|')).Select(parts => new CultureDto(parts[2].Contains('-') ? parts[2] : parts[3], parts[3], parts[2], string.IsNullOrEmpty(parts[1]) ? [parts[0]] : [parts[0], parts[1]])).ToArray();
var normalizer = new ProbeResultNormalizer(NullLogger.Instance, local);
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var results = new List<object>();
foreach (var sample in input.EnumerateArray())
{
    object result;
    if (sample.TryGetProperty("chapterNames", out var chapterNames))
    {
        var provider = RuntimeHelpers.GetUninitializedObject(typeof(FFProbeVideoInfo));
        typeof(FFProbeVideoInfo).GetField("_localization",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(provider,local);
        var chapters = chapterNames.EnumerateArray().Select(value=>new ChapterInfo {Name=value.ValueKind==JsonValueKind.Null?null:value.GetString()}).ToArray();
        typeof(FFProbeVideoInfo).GetMethod("NormalizeChapterNames",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(provider,[chapters]);
        result = chapters.Select(chapter=>chapter.Name).ToArray();
    }
    else if (sample.TryGetProperty("filename", out var filename))
    {
        result = new ExternalPathParser(new NamingOptions(), local, Enum.Parse<DlnaProfileType>(sample.GetProperty("type").GetString()!)).ParseFile(filename.GetString()!, sample.GetProperty("extra").GetString())!;
    }
    else
    {
        var raw = JsonSerializer.Deserialize<InternalMediaInfoResult>(sample.GetProperty("raw").GetRawText(), JsonDefaults.Options)!;
        var info = normalizer.GetMediaInfo(raw, VideoType.VideoFile, sample.GetProperty("isAudio").GetBoolean(), "/fixture.mkv", MediaProtocol.Http);
        result = new { info.Name, info.ForcedSortName, info.Overview, info.ParentIndexNumber, info.IndexNumber, info.ShowName, info.ProductionYear, info.PremiereDate, info.Album, info.Artists, info.AlbumArtists, info.Genres, info.Studios, info.People, info.ProviderIds, info.OfficialRating, info.OfficialRatingDescription, info.Video3DFormat, info.Timestamp };
    }
    results.Add(new { input = sample, expected = JsonSerializer.SerializeToElement(result, options) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));

public class LocalizationProxy : DispatchProxy
{
    public static CultureDto[] Cultures = [];
    protected override object? Invoke(MethodInfo? method, object?[]? values)
    {
        if (method!.Name == "FindLanguageInfo") { var value = (string)values![0]!; return Cultures.FirstOrDefault(culture => new[] { culture.Name, culture.DisplayName, culture.TwoLetterISOLanguageName }.Concat(culture.ThreeLetterISOLanguageNames).Contains(value, StringComparer.OrdinalIgnoreCase)); }
        if (method.Name == "GetLocalizedString") return values![0]?.ToString()=="ChapterNameValue" ? "Chapter {0}" : values[0];
        if (method.Name == "GetLanguageDisplayName") return values![0];
        return method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
    }
}
