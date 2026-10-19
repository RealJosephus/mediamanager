using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Sorting;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Sorting;
using BaseItem = MediaBrowser.Controller.Entities.BaseItem;

Guid Id(int number) => Guid.Parse($"99200000-0000-0000-0000-{number:000000000000}");
Movie Item(int number, string name) => new() { Id = Id(number), Name = name };
var user = new User("SyntheticBoundary", "controlled-authentication", "controlled-reset") { Id = Id(99) };
var data = new Dictionary<Guid, UserItemData>();
var manager = Stub.Make<IUserDataManager>((method, args) => {
    if (method.Name == "GetUserData") return data.GetValueOrDefault(((BaseItem)args![1]!).Id);
    return Stub.Default(method.ReturnType);
});
BaseItem.UserDataManager = manager;
var output = new List<object>();
void Record(string name, IBaseItemComparer comparer, BaseItem[] items, Dictionary<string, object?>[] candidateItems,
    Dictionary<string, object?>[] candidateUserData) {
    output.Add(new { name, comparer = comparer.GetType().FullName, registrationType = comparer.Type.ToString(),
        inputOrder = items.Select(item => item.Id.ToString()).ToArray(), candidateItems, candidateUserData,
        ascending = items.OrderBy(item => item, comparer).Select(item => item.Id.ToString()).ToArray(),
        descending = items.OrderByDescending(item => item, comparer).Select(item => item.Id.ToString()).ToArray(),
        pairwise = items.SelectMany(left => items.Select(right => new { left = left.Id, right = right.Id,
            compare = Math.Sign(comparer.Compare(left, right)) })).ToArray() });
}
Dictionary<string, object?> Row(Movie item, params (string Key, object? Value)[] values) {
    var row = new Dictionary<string, object?> { ["Id"] = item.Id.ToString(), ["Name"] = item.Name, ["Type"] = "Movie", ["SortName"] = item.Name };
    foreach (var (key, value) in values) row[key] = value;
    return row;
}
Dictionary<string, object?> UserRow(Movie item, params (string Key, object? Value)[] values) {
    var row = new Dictionary<string, object?> { ["ItemId"] = item.Id.ToString() };
    foreach (var (key, value) in values) row[key] = value;
    return row;
}
var minimum = "0001-01-01 00:00:00";
Movie createdMin = Item(1, "explicit-min"), createdAbsent = Item(2, "absent-null-db");
createdMin.DateCreated = DateTime.MinValue;
// BaseItem.DateCreated is DateTime (not nullable); its default and mapper's DB-null fallback are MinValue.
Record("DateCreated", new DateCreatedComparer(), [createdMin, createdAbsent],
    [Row(createdMin, ("DateCreated", minimum)), Row(createdAbsent, ("DateCreated", null))], []);
Movie playedMin = Item(3, "explicit-min"), playedNull = Item(4, "null-last-played"), playedAbsent = Item(5, "absent-user-data");
data[playedMin.Id] = new() { Key = "controlled", LastPlayedDate = DateTime.MinValue };
data[playedNull.Id] = new() { Key = "controlled", LastPlayedDate = null };
Record("DatePlayed", new DatePlayedComparer { User = user, UserDataManager = manager }, [playedMin, playedNull, playedAbsent],
    [Row(playedMin), Row(playedNull), Row(playedAbsent)],
    [UserRow(playedMin, ("LastPlayedDate", minimum)), UserRow(playedNull, ("LastPlayedDate", null))]);
Movie validYear = Item(6, "valid-year"), invalidLarge = Item(7, "invalid-year-10000"), premiereMin = Item(8, "explicit-min"),
    premiereAbsent = Item(9, "absent-date-year"), invalidZero = Item(10, "invalid-year-zero");
validYear.ProductionYear = 2000; invalidLarge.ProductionYear = 10000; premiereMin.PremiereDate = DateTime.MinValue; invalidZero.ProductionYear = 0;
Record("PremiereDate", new PremiereDateComparer(), [validYear, invalidLarge, premiereMin, premiereAbsent, invalidZero],
    [Row(validYear, ("ProductionYear", 2000)), Row(invalidLarge, ("ProductionYear", 10000)), Row(premiereMin, ("PremiereDate", minimum)),
        Row(premiereAbsent), Row(invalidZero, ("ProductionYear", 0))], []);
Movie ordinary = Item(11, "ordinary"), liked = Item(12, "liked"), favorite = Item(13, "favorite"), disliked = Item(14, "disliked"), absent = Item(15, "absent");
data[ordinary.Id] = new() { Key = "controlled", IsFavorite = false };
data[liked.Id] = new() { Key = "controlled", IsFavorite = false, Likes = true };
data[favorite.Id] = new() { Key = "controlled", IsFavorite = true };
data[disliked.Id] = new() { Key = "controlled", IsFavorite = false, Likes = false };
Record("IsFavoriteOrLiked", new IsFavoriteOrLikeComparer { User = user, UserDataManager = manager }, [ordinary, liked, favorite, disliked, absent],
    [Row(ordinary), Row(liked), Row(favorite), Row(disliked), Row(absent)],
    [UserRow(ordinary, ("IsFavorite", false), ("Likes", null), ("Rating", null)),
        UserRow(liked, ("IsFavorite", false), ("Likes", data[liked.Id].Likes), ("Rating", data[liked.Id].Rating)),
        UserRow(favorite, ("IsFavorite", true), ("Likes", null), ("Rating", null)),
        UserRow(disliked, ("IsFavorite", false), ("Likes", data[disliked.Id].Likes), ("Rating", data[disliked.Id].Rating))]);
var assemblies = new[] { typeof(DateCreatedComparer).Assembly, typeof(BaseItem).Assembly, typeof(User).Assembly }
    .Distinct().Select(assembly => new { assembly = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
Console.WriteLine(JsonSerializer.Serialize(new { actualFrozenDllComparersInvoked = true, actualLinqOrderByInvoked = true,
    dependenciesControlled = true, libraryManagerInvoked = false, httpInvoked = false, databaseOpened = false,
    noAuthenticationPerformed = true, assemblies, output }));
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => Handler(targetMethod!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
