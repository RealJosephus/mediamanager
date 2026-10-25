using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.TV;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItem = MediaBrowser.Controller.Entities.BaseItem;

Guid Id(int value) => Guid.Parse($"ab210000-0000-0000-0000-{value:000000000000}");
var user = new User("InstantMixUser", "controlled-auth", "controlled-reset") { Id = Id(1) };
var parent = new CollectionFolder { Id = Id(2), Name = "Controlled library", CollectionType = CollectionType.tvshows };
var source = new Audio { Id = Id(3), Name = "First song", Genres = ["Drama", "DRAMA", "爵士"] };
var other = new Audio { Id = Id(4), Name = "Other song", Genres = ["Drama"] };
var book = new AudioBook { Id = Id(5), Name = "Audio book", Genres = ["Drama"] };
var paper = new Book { Id = Id(6), Name = "Book", Genres = ["Novel"] };
var movie = new Movie { Id = Id(7), Name = "Movie", Genres = ["Drama"] };
var series = new Series { Id = Id(8), Name = "Series", Genres = ["Drama"] };
var episode = new Episode { Id = Id(9), Name = "Episode", Genres = ["Drama"], ParentIndexNumber = 1, IndexNumber = 2 };
var collection = new BoxSet { Id = Id(10), Name = "Collection" };
var genres = new Dictionary<string, MusicGenre>(StringComparer.OrdinalIgnoreCase) {
    ["Drama"] = new MusicGenre { Id = Id(20), Name = "Drama" },
    ["爵士"] = new MusicGenre { Id = Id(21), Name = "爵士" },
    ["Novel"] = new MusicGenre { Id = Id(22), Name = "Novel" }
};
var candidates = new Audio[] { source, other };
BaseItem[] selected = [];
var calls = new List<object>();
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, args) =>
    method.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(method.ReturnType));
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.UserDataManager = Stub.Make<IUserDataManager>((method, args) =>
    method.Name == "GetUserData" ? new UserItemData { Key = "controlled" } : Stub.Default(method.ReturnType));
Folder.UserViewManager = Stub.Make<IUserViewManager>((method, args) => Stub.Default(method.ReturnType));
UserView.TVSeriesManager = Stub.Make<ITVSeriesManager>((method, args) => {
    if (method.Name == "GetNextUp") {
        calls.Add(new { method = method.Name, count = selected.Length });
        return new QueryResult<BaseItem>(selected);
    }
    return Stub.Default(method.ReturnType);
});
var library = Stub.Make<ILibraryManager>((method, args) => {
    if (method.Name == "GetItemById") return (Guid)args![0]! == parent.Id ? parent : null;
    if (method.Name == "GetMusicGenre") {
        var name = (string)args![0]!;
        calls.Add(new { method = method.Name, name });
        if (name == "Failure") throw new IOException("Controlled genre lookup failure");
        return genres.GetValueOrDefault(name) ?? new MusicGenre { Id = Id(23), Name = name };
    }
    if (method.Name is "GetItemsResult" or "GetItemList") {
        var query = (InternalItemsQuery)args![0]!;
        var random = query.OrderBy.Any(order => order.OrderBy == ItemSortBy.Random);
        calls.Add(new { method = method.Name, query.Recursive, query.ForceDirect, query.IsFolder,
            query.IsVirtualItem, query.Limit, query.IsFavorite, query.IsResumable,
            includeItemTypes = query.IncludeItemTypes.Select(type => type.ToString()).ToArray(),
            genreIds = query.GenreIds, random });
        IReadOnlyList<BaseItem> result = random ? candidates
            : selected.Where(item => query.IncludeItemTypes.Length == 0
                || query.IncludeItemTypes.Contains(item.GetBaseItemKind())).ToArray();
        return method.Name == "GetItemsResult" ? new QueryResult<BaseItem>(result) : result;
    }
    return Stub.Default(method.ReturnType);
});
BaseItem.LibraryManager = library;
var manager = new MusicManager(library);
var observations = new List<object>();
void Record(string name, BaseItem item, BaseItem[] children, User? currentUser = null, bool userless = false) {
    selected = children;
    calls.Clear();
    IReadOnlyList<BaseItem>? result = null;
    Exception? failure = null;
    try {
        result = manager.GetInstantMixFromItem(item, userless ? null : currentUser ?? user,
            new DtoOptions(false) { EnableImages = false });
    } catch (Exception error) { failure = error; }
    observations.Add(new { name, sourceType = item.GetType().Name, item.Id,
        viewType = (item as UserView)?.ViewType?.ToString(), userless,
        selected = children.Select(child => new { child.Id, type = child.GetType().Name, child.Genres }).ToArray(),
        item.Genres, ids = result?.Select(entry => entry.Id).ToArray(),
        failure = failure is null ? null : new { type = failure.GetType().FullName, failure.Message },
        calls = calls.ToArray() });
}
Record("audio", source, []);
Record("audio-book", book, []);
Record("audio-book-userless", book, [], userless: true);
Record("movie", movie, []);
Record("paper-book", paper, []);
Record("music-genre", genres["Drama"], []);
Record("music-album", new MusicAlbum { Id = Id(30), Name = "Album", Genres = ["Drama"] }, []);
Record("music-artist", new MusicArtist { Id = Id(31), Name = "Artist", Genres = ["Drama"] }, []);
Record("playlist", new Playlist { Id = Id(32), Name = "Playlist", Genres = ["Drama"] }, []);
Record("failed-genre", new Audio { Id = Id(33), Genres = ["Failure"] }, []);
Record("empty-genres", new Audio { Id = Id(34) }, []);
Record("folder-userless", new Folder { Id = Id(35) }, [], userless: true);
var overridden = new[] { CollectionType.books, CollectionType.tvshowseries, CollectionType.tvgenre,
    CollectionType.tvfavoriteseries, CollectionType.tvfavoriteepisodes, CollectionType.tvlatest,
    CollectionType.tvresume, CollectionType.tvnextup, CollectionType.moviemovies, CollectionType.moviegenre,
    CollectionType.moviecollection, CollectionType.moviefavorites, CollectionType.movielatest, CollectionType.movieresume };
for (var index = 0; index < overridden.Length; index++) {
    var kind = overridden[index];
    var view = new UserView { Id = Id(100 + index), Name = "Controlled view", ViewType = kind,
        DisplayParentId = parent.Id };
    BaseItem child = kind == CollectionType.books ? book : kind == CollectionType.moviecollection ? collection
        : kind is CollectionType.tvshowseries or CollectionType.tvgenre or CollectionType.tvfavoriteseries ? series
        : kind.ToString().StartsWith("tv", StringComparison.Ordinal) ? episode : movie;
    Record($"{kind}-empty", view, []);
    Record($"{kind}-selected", view, [child]);
    Record($"{kind}-userless", view, [], userless: true);
}
var books = new UserView { Id = Id(100), Name = "Controlled view", ViewType = CollectionType.books,
    DisplayParentId = parent.Id };
Record("books-paper-after-audio", books, [book, paper]);
Record("books-paper-before-audio", books, [paper, book]);
foreach (var kind in new[] { CollectionType.movies, CollectionType.tvshows, CollectionType.music,
    CollectionType.moviegenres, CollectionType.tvgenres }) {
    var view = new UserView { Id = Id(200 + (int)kind), Name = "Controlled view", ViewType = kind,
        DisplayParentId = parent.Id };
    Record($"{kind}-audio", view, [source]);
    Record($"{kind}-userless", view, [], userless: true);
}
var assembly = typeof(MusicManager).Assembly;
var output = new {
    actualMusicManager = true, actualUserViewBuilder = true,
    dependenciesControlled = new[] { "entity lookup", "repository query", "genre lookup", "TVSeriesManager", "configuration", "user data" },
    databaseOpened = false, portOpened = false,
    userId = user.Id, parentId = parent.Id,
    candidates = candidates.Select(item => new { item.Id, item.Name, item.Genres }).ToArray(),
    observations,
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
        .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name,
            sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value.Location))).ToLowerInvariant() }).ToArray()
};
File.WriteAllText(args[0], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = observations.Count, actualMusicManager = true, actualUserViewBuilder = true }));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
