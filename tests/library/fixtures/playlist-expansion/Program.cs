// Calls the pinned native Playlist.GetPlaylistItems and Folder.GetItemList.
// Repository responses are controlled inputs; query planning is unmodified.
using System.Reflection;
using System.Text.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Querying;

var id = (int index) => Guid.Parse("79000000-0000-0000-0000-" + index.ToString("D12"));
var first = new Audio { Id = id(1), Name = "First" };
var second = new Movie { Id = id(2), Name = "Second" };
var photo = new Photo { Id = id(3), Name = "Photo" };
var folder = new Folder { Id = id(4), Name = "Folder" };
var artist = new MusicArtist { Id = id(5), Name = "Artist" };
var genre = new MusicGenre { Id = id(6), Name = "Genre" };
var manager = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
var recording = (LibraryProxy)(object)manager;
recording.Candidates = [second, first, photo];
BaseItem.LibraryManager = manager;
BaseItem.ConfigurationManager = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var result = Playlist.GetPlaylistItems([first, photo, folder, artist, genre, first], null, new DtoOptions(false))
    .Where(item => item.SupportsAddingToPlaylist).Select(item => item.Id.ToString("N")).ToArray();
File.WriteAllText(args[0], JsonSerializer.Serialize(new {
    results = result, queries = recording.Queries,
    sourceBoundary = "Unmodified Playlist.GetPlaylistItems and Folder.GetItemList/QueryRecursive. ILibraryManager.GetItemList returns explicitly supplied candidates; this oracle verifies expansion and query arguments, not database filtering. User is null; user visibility is covered by candidate dual-database tests and existing permission oracles.",
    runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
    assemblies = new[] { typeof(Playlist).Assembly, typeof(object).Assembly }.Select(assembly => new {
        path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }),
    candidateVerified = false
}, new JsonSerializerOptions { WriteIndented = true }));

public class LibraryProxy : DispatchProxy {
    public BaseItem[] Candidates = [];
    public List<object> Queries = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name is not ("GetItemList" or "GetItemsResult")) throw new NotSupportedException(method.Name);
        var query = (InternalItemsQuery)args![0]!;
        Queries.Add(new { ParentId = query.ParentId.ToString("N"), query.Recursive, query.IsFolder,
            query.EnableTotalRecordCount, IncludeItemTypes = query.IncludeItemTypes.Select(value => value.ToString()),
            MediaTypes = query.MediaTypes.Select(value => value.ToString()), ArtistIds = query.ArtistIds.Select(value => value.ToString("N")),
            GenreIds = query.GenreIds.Select(value => value.ToString("N")),
            OrderBy = query.OrderBy.Select(value => new { Key = value.Item1.ToString(), Direction = value.Item2.ToString() }) });
        return method.Name == "GetItemsResult" ? new QueryResult<BaseItem> { Items = Candidates, TotalRecordCount = Candidates.Length } : Candidates;
    }
}
public class ConfigurationProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "get_Configuration"
        ? new ServerConfiguration { EnableGroupingMoviesIntoCollections = false, EnableGroupingShowsIntoCollections = false }
        : throw new NotSupportedException(method.Name);
}
