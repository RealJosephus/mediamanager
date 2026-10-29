using System.Globalization;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.Movies;
using TMDbLib.Client;
using MediaBrowser.XbmcMetadata.Configuration;
using MediaBrowser.XbmcMetadata.Savers;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var observations = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var pluginConfiguration = new PluginConfiguration { TmdbApiKey = "public-response-replay", MaxCastMembers = 0, MaxCrewMembers = 0 };
    var plugin = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));
    typeof(BasePlugin<PluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(plugin, pluginConfiguration);
    typeof(Plugin).GetProperty("Instance")!.SetValue(null, plugin);
    using var handler = new ReplayHandler(sample.GetProperty("responses"));
    var constructor = typeof(TMDbClient).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single(value => value.GetParameters().Length == 6);
    using var client = (TMDbClient)constructor.Invoke(["public-response-replay", true, "api.themoviedb.org", null, null, handler]);
    using var manager = new TmdbClientManager();
    var field = typeof(TmdbClientManager).GetField("_tmDbClient", BindingFlags.Instance | BindingFlags.NonPublic)!;
    ((TMDbClient)field.GetValue(manager)!).Dispose(); field.SetValue(manager, client); client.ThrowApiExceptions = false;
    var provider = new TmdbMovieProvider(null!, manager, null!);
    var info = new MovieInfo { Name = "Incoming movie", MetadataLanguage = sample.GetProperty("language").GetString(),
        MetadataCountryCode = sample.GetProperty("country").GetString(),
        ProviderIds = new Dictionary<string, string> { ["Tmdb"] = input.GetProperty("movieId").GetInt32().ToString(CultureInfo.InvariantCulture) } };
    var results = new List<object>();
    for (var index = 0; index < 2; index++) {
        var result = await provider.GetMetadata(info, CancellationToken.None);
        var item = result.Item;
        results.Add(new { result.HasMetadata, result.ResultLanguage, Item = item is null ? null : new {
            Type = item.GetBaseItemKind().ToString(), item.Name, item.OriginalTitle, item.Overview, item.Tagline, item.ProductionLocations,
            item.ProviderIds, item.CommunityRating, item.PremiereDate, item.ProductionYear, item.Studios, item.Genres, item.Tags,
            TmdbCollectionName = item.CollectionName, item.OfficialRating,
            RemoteTrailers = item.RemoteTrailers.Select(value => new { value.Url, value.Name }).ToArray(), item.OriginalLanguage
        }, commonNfo = item is null ? null : NfoCommon.Record(item), People = result.People?.Select(person => new { person.Name, person.Role, Type = person.Type.ToString(),
            person.SortOrder, person.ImageUrl, person.ProviderIds }).ToArray(), requestCount = handler.Requests.Count });
    }
    observations.Add(new { name = sample.GetProperty("name").GetString(), language = info.MetadataLanguage,
        country = info.MetadataCountryCode, results, requests = handler.Requests });
}
typeof(Plugin).GetProperty("Instance")!.SetValue(null, null);
var assemblies = new[] { typeof(TmdbClientManager).Assembly, typeof(TMDbClient).Assembly, typeof(BaseNfoSaver).Assembly }.Select(assembly => new {
    name = assembly.GetName().Name, filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualManager = true, actualMovieProvider = true, actualCommonNfoWriter = true, publicNetworkUsedByNative = false,
    controlled = new[] { "HTTP response replay from actual same-run TMDB response bytes", "cast and crew limits of zero" },
    observations, assemblies, phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static class NfoCommon {
    public static object Record(BaseItem item) {
        var configuration = Gateway.Make<IServerConfigurationManager>((method, values) =>
            method.Name == "GetConfiguration" && (string)values![0]! == "xbmcmetadata"
                ? new XbmcMetadataOptions { SaveImagePathsInNfo = false, UserId = null }
                : throw new InvalidOperationException("Unexpected common NFO configuration access: " + method.Name));
        var library = Gateway.Make<ILibraryManager>((method, values) => method.Name == "GetPeople"
            ? new List<PersonInfo>() : throw new InvalidOperationException("Unexpected common NFO library access: " + method.Name));
        var saver = new MovieNfoSaver(null!, configuration, library, null!, null!, NullLogger<MovieNfoSaver>.Instance);
        using var stream = new MemoryStream();
        using (var writer = XmlWriter.Create(stream, new XmlWriterSettings { Encoding = new UTF8Encoding(false), CloseOutput = false })) {
            writer.WriteStartElement("movie");
            try {
                typeof(BaseNfoSaver).GetMethod("AddCommonNodes", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(saver, [item, writer, library, null, null, configuration]);
            } catch (TargetInvocationException error) when (error.InnerException is not null) {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw(); throw;
            }
            writer.WriteEndElement();
        }
        var bytes = stream.ToArray();
        var document = XDocument.Parse(Encoding.UTF8.GetString(bytes));
        return new { genres = document.Root!.Elements("genre").Select(element => element.Value).ToArray(),
            bytes = bytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), base64 = Convert.ToBase64String(bytes) };
    }
}

public class Gateway : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Gateway>(); ((Gateway)(object)value).Handler = handler; return value;
    }
}

sealed class ReplayHandler(JsonElement responses) : HttpMessageHandler {
    public List<object> Requests { get; } = [];
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
        token.ThrowIfCancellationRequested();
        var uri = request.RequestUri!;
        var query = Query(uri.Query);
        var matching = responses.EnumerateArray().Where(value => value.GetProperty("request").GetProperty("path").GetString() == uri.AbsolutePath
            && JsonSerializer.Serialize(value.GetProperty("request").GetProperty("query")) == JsonSerializer.Serialize(query)).ToArray();
        if (matching.Length == 0) throw new InvalidOperationException("No captured public response matches the Native request path and query.");
        var sample = matching[0];
        var bytes = await File.ReadAllBytesAsync(sample.GetProperty("filename").GetString()!, token);
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != sample.GetProperty("sha256").GetString())
            throw new InvalidOperationException("Captured public response bytes changed.");
        Requests.Add(new { origin = uri.GetLeftPart(UriPartial.Authority), path = uri.AbsolutePath, query });
        var response = new HttpResponseMessage((HttpStatusCode)sample.GetProperty("status").GetInt32()) { Content = new ByteArrayContent(bytes) };
        response.Content.Headers.TryAddWithoutValidation("Content-Type", sample.GetProperty("contentType").GetString());
        return response;
    }
    private static string[][] Query(string query) => query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(value => value.Split('=', 2)).Select(value => new[] { Uri.UnescapeDataString(value[0]), value.Length > 1 ? Uri.UnescapeDataString(value[1].Replace('+', ' ')) : "" })
        .Where(value => !string.Equals(value[0], "api_key", StringComparison.OrdinalIgnoreCase))
        .Select(value => value[0] == "append_to_response" ? new[] { value[0], string.Join(',', value[1].Split(',').Order(StringComparer.Ordinal)) } : value)
        .OrderBy(value => value[0], StringComparer.Ordinal).ThenBy(value => value[1], StringComparer.Ordinal).ToArray();
}
