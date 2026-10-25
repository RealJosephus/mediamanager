using System.Text.Json;
using ATL;

Settings.DisplayValueSeparator = '\u001F';
Settings.UseFileNameWhenNoTitle = false;
Settings.ID3v2_separatev2v3Values = false;
var track = new Track(args[0]);
var output = new
{
    track.Title,
    track.Album,
    track.Artist,
    track.AlbumArtist,
    track.Composer,
    track.Genre,
    track.Year,
    track.Date,
    track.TrackNumber,
    track.DiscNumber,
    track.Description,
    track.Comment,
    track.Publisher,
    AdditionalFields = track.AdditionalFields
};
File.WriteAllText(args[1], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));
