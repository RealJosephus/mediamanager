using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Localization;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var localization = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
await localization.LoadAll();
BaseItem.ConfigurationManager = configuration;
BaseItem.LocalizationManager = localization;
var scores = new List<object>();
foreach (var sample in input.GetProperty("scores").EnumerateArray()) {
    var name = sample.GetProperty("Name").GetString();
    var rating = sample.GetProperty("Rating").GetString()!;
    var country = sample.GetProperty("Country").GetString();
    try {
        var result = localization.GetRatingScore(rating, country);
        scores.Add(new { Name = name, Rating = rating, Country = country, Score = result?.Score, SubScore = result?.SubScore, HasScore = result is not null });
    } catch (Exception error) {
        scores.Add(new { Name = name, Rating = rating, Country = country, Exception = error.GetType().Name, Error = error.Message });
    }
}
var pairs = new List<object>();
foreach (var sample in input.GetProperty("pairs").EnumerateArray()) {
    var name = sample.GetProperty("Name").GetString();
    var ratings = sample.GetProperty("Ratings").EnumerateArray().Select(value => value.GetString()!).ToArray();
    var country = sample.GetProperty("Country").GetString();
    var collection = new BoxSet { Name = name, PreferredMetadataCountryCode = country, OfficialRating = "Original" };
    try {
        var changed = collection.UpdateRatingToItems(ratings.Select(rating => (BaseItem)new Movie { OfficialRating = rating }).ToArray());
        pairs.Add(new { Name = name, Ratings = ratings, Country = country, Changed = changed, OfficialRating = collection.OfficialRating });
    } catch (Exception error) {
        pairs.Add(new { Name = name, Ratings = ratings, Country = country, Exception = error.GetType().Name, Error = error.Message });
    }
}
object Describe(Type type) {
    var filename = type.Assembly.Location;
    return new { Type = type.FullName, Assembly = type.Assembly.FullName, Filename = filename,
        Sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename))) };
}
var unrated = typeof(LocalizationManager).GetMethod("IsUnrated", BindingFlags.NonPublic | BindingFlags.Static);
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    InputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    ActualGetRatingScore = true, ActualUpdateRatingToItems = true, ActualEmbeddedRatingResourcesLoaded = true,
    IsUnratedPublic = unrated?.IsPublic ?? false, IsUnratedDirectlyInvoked = false,
    ConfigurationControlled = true, MediaOpened = false, PortOpened = false,
    LoadedAssemblies = new[] { Describe(typeof(LocalizationManager)), Describe(typeof(BaseItem)), Describe(typeof(BoxSet)) },
    Scores = scores, Pairs = pairs,
}, new JsonSerializerOptions { WriteIndented = true }));

public class ConfigurationProxy : DispatchProxy {
    private readonly ServerConfiguration configuration = new() { MetadataCountryCode = "US", UICulture = "en-US" };
    protected override object? Invoke(MethodInfo? method, object?[]? arguments) => method!.Name switch {
        "get_Configuration" => configuration,
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}
