using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.Providers.Manager;
using MediaBrowser.XbmcMetadata.Configuration;
using MediaBrowser.XbmcMetadata.Parsers;
using MediaBrowser.XbmcMetadata.Savers;
using Microsoft.Extensions.Logging.Abstractions;

public static class NfoConsumers
{
    public static async Task<object> Run(Fixture fixture, JsonElement sample, byte[] picture)
    {
        const string key = "xbmcmetadata";
        var manager = fixture.Manager;
        var root = Path.Combine(fixture.Root, "media"); Directory.CreateDirectory(root);
        var files = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, manager.ApplicationPaths, []);
        BaseItem.ConfigurationManager = manager; BaseItem.FileSystem = files; BaseItem.Logger = NullLogger<BaseItem>.Instance;
        // These fixture files belong to the ordinary library and have no
        // active recording. Video.SourceType consults this real gateway before
        // MovieNfoSaver evaluates SupportsLocalMetadata.
        Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo"
            ? null : throw new InvalidOperationException("Unexpected recording gateway: " + method.Name));
        var users = new[] {
            new User("NFO A", "controlled", "controlled") { Id = Guid.Parse("10000000-0000-0000-0000-000000000001") },
            new User("NFO B", "controlled", "controlled") { Id = Guid.Parse("10000000-0000-0000-0000-000000000002") }
        };
        var data = new Dictionary<Guid, UserItemData> {
            [users[0].Id] = new() { Key = "nfo-config-item", PlayCount = 3, PlaybackPositionTicks = 120000000, IsFavorite = false },
            [users[1].Id] = new() { Key = "nfo-config-item", PlayCount = 9, PlaybackPositionTicks = 340000000, IsFavorite = true }
        };
        var userManager = Stub.Make<IUserManager>((method, arguments) => method.Name == "GetUserById"
            ? users.FirstOrDefault(user => user.Id == (Guid)arguments![0]!) : Stub.Default(method.ReturnType));
        XbmcMetadataOptions Options(JsonElement value) => JsonSerializer.Deserialize<XbmcMetadataOptions>(value.GetRawText())!;
        var before = Options(sample.GetProperty("before")); var incoming = Options(sample.GetProperty("after"));
        var imports = new List<object>(); var switchDuringImport = false;
        var userData = Stub.Make<IUserDataManager>((method, arguments) => {
            if (method.Name == "GetUserData") {
                if (((BaseItem)arguments![1]!).IsFolder) throw new IOException("Folder play state is unavailable.");
                return data[((User)arguments[0]!).Id];
            }
            if (method.Name == "SaveUserData") {
                var user = (User)arguments![0]!; var value = (UserItemData)arguments[2]!;
                imports.Add(new { userId = user.Id.ToString("D"), value.PlayCount, value.Played, value.PlaybackPositionTicks });
                if (switchDuringImport && user.Id == users[0].Id && value.PlayCount == 31) {
                    switchDuringImport = false; manager.SaveConfiguration(key, Options(sample.GetProperty("after")));
                }
                return null;
            }
            return Stub.Default(method.ReturnType);
        });
        var library = Stub.Make<ILibraryManager>((method, arguments) => method.Name switch {
            "GetPeople" => new List<PersonInfo>(),
            "GetPathAfterNetworkSubstitution" => arguments![0],
            "GetLibraryOptions" => new LibraryOptions { SaveLocalMetadata = true, MetadataSavers = ["Nfo"] },
            _ => Stub.Default(method.ReturnType)
        });
        BaseItem.LibraryManager = library;
        BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
            "GetMediaStreams" => new List<MediaStream>(),
            "GetPathProtocol" => MediaProtocol.File,
            _ => throw new InvalidOperationException("Unexpected media-source gateway: " + method.Name)
        });
        var movie = new Movie { Id = Guid.Parse("20000000-0000-0000-0000-000000000001"), Path = Path.Combine(root, "movie.mkv"),
            Name = "Current NFO", PremiereDate = new DateTime(2024, 2, 29, 0, 0, 0, DateTimeKind.Utc), RunTimeTicks = 900000000,
            DateCreated = new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Utc) };
        File.WriteAllBytes(movie.Path, Encoding.UTF8.GetBytes("Opaque original media; no media executor is used."));
        var poster = Path.Combine(root, "poster.png"); File.WriteAllBytes(poster, picture);
        movie.SetImage(new ItemImageInfo { Type = ImageType.Primary, Path = poster }, 0);
        var saver = new MovieNfoSaver(files, manager, library, userManager, userData, NullLogger<MovieNfoSaver>.Instance);
        var phases = new List<object>();
        async Task Save(string phase) {
            var enabled = saver.IsEnabledFor(movie, ItemUpdateType.ImageUpdate);
            await saver.SaveAsync(movie, CancellationToken.None);
            var filename = saver.GetSavePath(movie); using (File.Open(filename, FileMode.Open, FileAccess.Read, FileShare.None)) { }
            phases.Add(JsonSerializer.SerializeToElement(new { name = phase, enabledForImageUpdate = enabled, configuration = manager.GetConfiguration(key),
                nfo = Summary(filename), bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }));
        }
        manager.SaveConfiguration(key, before); await Save("before");
        manager.SaveConfiguration(key, incoming); await Save("after");
        incoming.ReleaseDateFormat = "yyyy/MM/dd";
        ((XbmcMetadataOptions)manager.GetConfiguration(key)).SaveImagePathsInNfo = true;
        before.ReleaseDateFormat = "old only"; before.UserId = null;
        await Save("late-incoming-and-current-reverse");
        var episode = new Episode { Id = Guid.Parse("20000000-0000-0000-0000-000000000002"), Path = Path.Combine(root, "episode.mkv"),
            Name = "Episode", PremiereDate = movie.PremiereDate, DateCreated = movie.DateCreated };
        var episodeSaver = new EpisodeNfoSaver(files, manager, library, userManager, userData, NullLogger<EpisodeNfoSaver>.Instance);
        await episodeSaver.SaveAsync(episode, CancellationToken.None);
        phases.Add(new { name = "episode-current-format", nfo = Summary(episodeSaver.GetSavePath(episode)),
            bytes = Convert.ToBase64String(File.ReadAllBytes(episodeSaver.GetSavePath(episode))) });

        manager.SaveConfiguration(key, Options(sample.GetProperty("before")));
        var parser = new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, manager,
            Stub.Make<IProviderManager>((method, _) => method.Name == "GetExternalIdInfos" ? Array.Empty<ExternalIdInfo>() : Stub.Default(method.ReturnType)),
            userManager, userData, new DirectoryService(files));
        var input = "<movie><playcount>31</playcount><watched>true</watched><premiered>29/02/2024</premiered></movie>";
        var inputFile = Path.Combine(root, "import.nfo"); File.WriteAllText(inputFile, input);
        movie.PremiereDate = null; movie.ProductionYear = null; switchDuringImport = true;
        parser.Fetch(new MetadataResult<Video> { Item = movie }, inputFile, CancellationToken.None);

        var current = (XbmcMetadataOptions)manager.GetConfiguration(key); current.EnableExtraThumbsDuplication = true;
        manager.Configuration.ImageSavingConvention = ImageSavingConvention.Compatible;
        var monitor = Stub.Make<ILibraryMonitor>((method, _) => Stub.Default(method.ReturnType));
        var imageSaver = new ImageSaver(manager, monitor, files, NullLogger<ImageSaver>.Instance);
        var held = new HeldSource(picture);
        var saving = imageSaver.SaveImage(movie, held, "image/png", ImageType.Backdrop, 1, CancellationToken.None);
        try {
            var first = await Task.WhenAny(held.Entered.Task, saving);
            if (first == saving) { await saving; throw new InvalidOperationException("The Native image save completed before reading its controlled source."); }
            manager.SaveConfiguration(key, new XbmcMetadataOptions { EnableExtraThumbsDuplication = false });
        } finally { held.Release.TrySetResult(); }
        await saving;
        var imageFiles = new[] { Path.Combine(root, "extrafanart", "fanart1.png"), Path.Combine(root, "extrathumbs", "thumb1.png") }
            .Select(filename => new { path = Path.GetRelativePath(fixture.Root, filename).Replace('\\', '/'), bytes = Convert.ToBase64String(File.ReadAllBytes(filename)) }).ToArray();
        using (File.Open(imageFiles.Select(value => Path.Combine(fixture.Root, value.path)).First(), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        var imageConfiguration = (XbmcMetadataOptions)manager.GetConfiguration(key);
        var folderCases = new List<object>();
        foreach (var definition in sample.GetProperty("folderUserIds").EnumerateArray()) {
            var name = definition.GetProperty("name").GetString()!;
            var directory = Path.Combine(root, name); Directory.CreateDirectory(directory);
            var season = new Season { Id = Guid.Parse("20000000-0000-0000-0000-000000000004"), Path = directory,
                Name = "Folder fixture", DateCreated = movie.DateCreated, IndexNumber = 1 };
            var target = Path.Combine(directory, "season.nfo");
            var original = Encoding.UTF8.GetBytes(sample.GetProperty("previousFolderNfo").GetString()!); File.WriteAllBytes(target, original);
            manager.SaveConfiguration(key, new XbmcMetadataOptions { UserId = definition.GetProperty("userId").GetString() });
            object? failure = null;
            try { await new SeasonNfoSaver(files, manager, library, userManager, userData, NullLogger<SeasonNfoSaver>.Instance).SaveAsync(season, CancellationToken.None); }
            catch (Exception error) { failure = CaptureFailure(error); }
            var bytes = File.ReadAllBytes(target); using (File.Open(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            folderCases.Add(new { name, failed = failure is not null, failure, beforeBase64 = Convert.ToBase64String(original),
                afterBase64 = Convert.ToBase64String(bytes), title = XDocument.Load(target).Root?.Element("title")?.Value, nfo = Summary(target) });
        }
        manager.SaveConfiguration(key, imageConfiguration);
        return new { name = sample.GetProperty("name").GetString(), root = fixture.Root, phases, imports, folderCases,
            parsed = new { premiereDate = movie.PremiereDate?.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ"), movie.ProductionYear },
            users = users.Select(user => new { userId = user.Id.ToString("D"), data[user.Id].PlayCount, data[user.Id].Played, data[user.Id].PlaybackPositionTicks }),
            inputBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(input)), imageSourceBase64 = Convert.ToBase64String(picture), imageFiles,
            configuration = manager.GetConfiguration(key) };
    }

    private static object CaptureFailure(Exception error) => new { type = error.GetType().FullName, error.Message, error.StackTrace, hresult = error.HResult,
        error.Source, data = error.Data.Cast<System.Collections.DictionaryEntry>().ToDictionary(entry => entry.Key.ToString()!, entry => entry.Value?.ToString()),
        cause = error.InnerException is null ? null : CaptureFailure(error.InnerException),
        errors = error is AggregateException group ? group.InnerExceptions.Select(CaptureFailure).ToArray() : null };

    public static object Summary(string filename)
    {
        var root = XDocument.Load(filename).Root!;
        return new { premiered = root.Element("premiered")?.Value, aired = root.Element("aired")?.Value,
            playcount = root.Element("playcount")?.Value, watched = root.Element("watched")?.Value,
            position = root.Element("resume")?.Element("position")?.Value, total = root.Element("resume")?.Element("total")?.Value,
            poster = root.Element("art")?.Element("poster")?.Value };
    }
}

public sealed class HeldSource(byte[] bytes) : Stream
{
    private readonly MemoryStream _inner = new(bytes);
    public readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public override bool CanRead => _inner.CanRead; public override bool CanSeek => true; public override bool CanWrite => false;
    public override long Length => _inner.Length; public override long Position { get => _inner.Position; set => _inner.Position = value; }
    public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
    public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException(); public override void Flush() { }
    public override async Task CopyToAsync(Stream destination, int bufferSize, CancellationToken cancellationToken) {
        Entered.TrySetResult(); await Release.Task.WaitAsync(cancellationToken); await _inner.CopyToAsync(destination, bufferSize, cancellationToken);
    }
    protected override void Dispose(bool disposing) { if (disposing) _inner.Dispose(); base.Dispose(disposing); }
}
