using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.LiveTv.Listings;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.LiveTv;
using Microsoft.Extensions.Logging.Abstractions;

var routes = JsonDocument.Parse(await File.ReadAllBytesAsync(args[0])).RootElement;
var importedCache = args.Length > 2;
var directory = importedCache ? args[2] : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "sd-cache");
Directory.CreateDirectory(directory);
var paths = DispatchProxy.Create<IApplicationPaths, CachePaths>();
((CachePaths)(object)paths).Directory = directory;
using var handler = new FixtureRoutes(routes);
using var http = new HttpClient(handler);
var factory = new Clients(http);
var info = new ListingsProviderInfo { Username = "user", Password = "password", ListingsId = "A" };
var date = new DateTime(2025, 3, 1, 12, 0, 0, DateTimeKind.Utc);
var rounds = new List<object>();
for (var index = 0; index < (importedCache ? 1 : 2); index++)
{
    using var provider = new SchedulesDirect(NullLogger<SchedulesDirect>.Instance, factory, paths, null!);
    var start = handler.Calls.Count;
    await provider.Validate(info, true, true);
    var lineups = await provider.GetLineups(info, "USA", "12345");
    var channels = await provider.GetChannels(info, CancellationToken.None);
    var program = (await provider.GetProgramsAsync(info, "I21.json.schedulesdirect.org", date, date.AddHours(1), CancellationToken.None)).Single();
    if (!importedCache && index == 0) provider.ReportImageDownloadFailure(program.ImageUrl!, HttpStatusCode.NotFound, "{\"code\":5000}");
    rounds.Add(new {
        lineups = lineups.Select(x => new { x.Id, x.Name }),
        channels = channels.Select(x => new { x.Id, x.Name, x.Number, x.CallSign }),
        program = new { program.Id, program.Name, program.ChannelId, program.ShowId, program.EpisodeTitle,
            program.SeasonNumber, program.EpisodeNumber, program.IsSeries, program.IsHD, program.IsNews,
            program.Etag, program.ImageUrl, program.ThumbImageUrl, Audio = program.Audio.ToString() },
        calls = handler.Calls.Skip(start).ToArray()
    });
}
await File.WriteAllTextAsync(args[1], JsonSerializer.Serialize(new { rounds,
    assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(typeof(SchedulesDirect).Assembly.Location))) }));

public class CachePaths : DispatchProxy
{
    public string Directory = "";
    protected override object? Invoke(MethodInfo? method, object?[]? args) =>
        method?.Name == "get_CachePath" ? Directory : throw new InvalidOperationException(method?.Name);
}
public sealed class Clients(HttpClient client) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => client;
}
public sealed class FixtureRoutes(JsonElement routes) : HttpMessageHandler
{
    public List<string> Calls { get; } = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var uri = request.RequestUri!;
        if (uri.Host != "json.schedulesdirect.org") throw new InvalidOperationException(uri.Host);
        var key = request.Method.Method + " " + uri.AbsolutePath["/20141201".Length..];
        Calls.Add(key);
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent(routes.GetProperty(key).GetRawText(), Encoding.UTF8, "application/json")
        });
    }
}
