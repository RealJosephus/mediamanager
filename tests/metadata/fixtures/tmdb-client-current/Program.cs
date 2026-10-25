using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.Movies;
using TMDbLib.Client;
using TMDbLib.Objects.Find;

var inputBytes = File.ReadAllBytes(args[0]);
using var inputDocument = JsonDocument.Parse(inputBytes);
var input = inputDocument.RootElement;
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray())
{
    var configuration = new PluginConfiguration { TmdbApiKey = "fixture-key" };
    var plugin = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));
    typeof(BasePlugin<PluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(plugin, configuration);
    typeof(Plugin).GetProperty("Instance")!.SetValue(null, plugin);
    using var handler = new ScenarioHandler(input, sample);
    var constructor = typeof(TMDbClient).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
        .Single(value => value.GetParameters().Length == 6);
    using var client = (TMDbClient)constructor.Invoke(["fixture-key", false, "tmdb.invalid", null, null, handler]);
    using var manager = new TmdbClientManager();
    var field = typeof(TmdbClientManager).GetField("_tmDbClient", BindingFlags.Instance | BindingFlags.NonPublic)!;
    ((TMDbClient)field.GetValue(manager)!).Dispose();
    field.SetValue(manager, client);
    client.ThrowApiExceptions = false;
    var calls = new List<object>();
    for (var index = 0; index < sample.GetProperty("repeats").GetInt32(); index++)
    {
        using var cancellation = new CancellationTokenSource();
        handler.Cancellation = cancellation;
        handler.CallIndex = index;
        if (sample.TryGetProperty("cancelBefore", out var cancelBefore) && cancelBefore.GetBoolean()) cancellation.Cancel();
        object? value = null;
        Exception? failure = null;
        var started = handler.Elapsed;
        try { value = await Invoke(manager, sample.GetProperty("operation").GetString()!, cancellation.Token); }
        catch (Exception error) { failure = error; }
        calls.Add(new { outcome = failure is null ? "success" : cancellation.IsCancellationRequested ? "cancelled" : "error",
            value, startedMs = started, completedMs = handler.Elapsed, diagnostic = Failure(failure) });
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), calls, requests = handler.Requests });
}
typeof(Plugin).GetProperty("Instance")!.SetValue(null, null);
var assemblies = new[] { typeof(TmdbClientManager).Assembly, typeof(TMDbClient).Assembly }
    .Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location,
        version = assembly.GetName().Version?.ToString(),
        informationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { schemaVersion = 1, actualExecution = true,
    inputSha256 = Hash(inputBytes), assemblies, results,
    scope = "Actual TmdbClientManager and TMDbLib 3.0.0 requests, retries, waits, cancellation, cache and Movie provider. Only HttpMessageHandler supplies declared responses; no live TMDB or PostgreSQL persistence." },
    new JsonSerializerOptions { WriteIndented = true }));

static async Task<object?> Invoke(TmdbClientManager manager, string operation, CancellationToken token)
{
    const string language = "en", images = "en,null", country = "US";
    switch (operation)
    {
        case "configuration":
            var configuration = await manager.GetClientConfiguration();
            return new { secureBaseUrl = configuration.Images?.SecureBaseUrl };
        case "movie":
            var movie = await manager.GetMovieAsync(1, language, images, country, token);
            return movie is null ? null : new { id = movie.Id, name = movie.Title };
        case "series":
            var series = await manager.GetSeriesAsync(1, language, images, country, token);
            return series is null ? null : new { id = series.Id, name = series.Name };
        case "season":
            var season = await manager.GetSeasonAsync(1, 1, language, images, country, token);
            return season is null ? null : new { id = season.Id, name = season.Name };
        case "episode":
            var episode = await manager.GetEpisodeAsync(1, 1, 1, "", language, images, country, token);
            return episode is null ? null : new { id = episode.Id, name = episode.Name };
        case "person":
            var person = await manager.GetPersonAsync(1, language, country, token);
            return person is null ? null : new { id = person.Id, name = person.Name };
        case "collection":
            var collection = await manager.GetCollectionAsync(1, language, images, country, token);
            return collection is null ? null : new { id = collection.Id, name = collection.Name };
        case "find":
            var found = await manager.FindByExternalIdAsync("tt0000001", FindExternalSource.Imdb, language, country, token);
            return found?.MovieResults?.Select(value => new { id = value.Id, name = value.Title }).ToArray();
        case "search":
            var searched = await manager.SearchMovieAsync("Recovery", 2020, language, country, token);
            return searched?.Select(value => new { id = value.Id, name = value.Title }).ToArray();
        case "recommendationsMovie":
            var movies = await manager.GetMovieRecommendationsPageAsync(1, 1, language, token);
            return new { results = movies.Results.Select(value => new { id = value.Id, name = value.Title }), totalPages = movies.TotalPages };
        case "recommendationsSeries":
            var shows = await manager.GetSeriesRecommendationsPageAsync(1, 1, language, token);
            return new { results = shows.Results.Select(value => new { id = value.Id, name = value.Name }), totalPages = shows.TotalPages };
        case "provider":
            var provider = new TmdbMovieProvider(null!, manager, null!);
            var metadata = await provider.GetMetadata(new MovieInfo { Name = "Incoming title", MetadataLanguage = language,
                MetadataCountryCode = country, ProviderIds = new Dictionary<string, string> { ["Tmdb"] = "1" } }, token);
            return new { metadata.HasMetadata, name = metadata.Item?.Name, overview = metadata.Item?.Overview,
                providerIds = metadata.Item?.ProviderIds, productionYear = metadata.Item?.ProductionYear };
        default: throw new InvalidOperationException("Unknown controlled TMDB operation.");
    }
}

static object? Failure(Exception? error) => error is null ? null : new { type = error.GetType().FullName,
    error.Message, cause = Failure(error.InnerException), errors = error is AggregateException aggregate
        ? aggregate.InnerExceptions.Select(Failure).ToArray() : null };
static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

sealed class ScenarioHandler(JsonElement input, JsonElement sample) : HttpMessageHandler
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private int _responseIndex;
    public List<object> Requests { get; } = [];
    public CancellationTokenSource? Cancellation { get; set; }
    public int CallIndex { get; set; }
    public double Elapsed => _clock.Elapsed.TotalMilliseconds;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var configuration = request.RequestUri!.AbsolutePath.EndsWith("/configuration", StringComparison.Ordinal);
        var throttleConfiguration = sample.GetProperty("operation").GetString() == "configuration"
            || sample.TryGetProperty("throttleConfiguration", out var throttle) && throttle.GetBoolean();
        var targeted = configuration == throttleConfiguration;
        var statuses = sample.GetProperty("statuses");
        var responseIndex = targeted ? _responseIndex++ : -1;
        var status = targeted ? statuses[Math.Min(responseIndex, statuses.GetArrayLength() - 1)].GetInt32() : 200;
        var success = status is >= 200 and <= 299;
        string? contentType = "application/json";
        var property = success ? "contentType" : "errorContentType";
        if (targeted && sample.TryGetProperty(property, out var declaredType)) contentType = declaredType.GetString();
        var body = configuration ? input.GetProperty("configuration").GetRawText()
            : input.GetProperty("responses").GetProperty(sample.GetProperty("operation").GetString()!).GetRawText();
        if (!success) body = "{\"status_code\":25,\"status_message\":\"Controlled TMDB failure\"}";
        property = success ? "bodyText" : "errorText";
        if (targeted && sample.TryGetProperty(property, out var declaredText)) body = declaredText.GetString()!;
        var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body)) };
        if (contentType is not null) response.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        var retryAfter = sample.TryGetProperty("retryAfter", out var retry) ? retry.GetString() : null;
        if (status == 429 && retryAfter is not null) response.Headers.TryAddWithoutValidation("Retry-After", retryAfter);
        byte[] requestBody = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(token);
        Requests.Add(new { callIndex = CallIndex, method = request.Method.Method, uri = request.RequestUri.ToString(),
            requestBodySha256 = Convert.ToHexString(SHA256.HashData(requestBody)).ToLowerInvariant(), status,
            contentType, responseBody = body, retryAfter = status == 429 ? retryAfter : null, responseMs = Elapsed });
        if (targeted && sample.TryGetProperty("cancelResponse", out var cancelResponse) && cancelResponse.GetInt32() == responseIndex + 1)
            Cancellation!.CancelAfter(sample.GetProperty("cancelAfterMs").GetInt32());
        return response;
    }
}
