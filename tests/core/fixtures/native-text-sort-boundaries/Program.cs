using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Configuration;
var input = JsonDocument.Parse(File.ReadAllBytes(args[0]));
var samples = input.RootElement.GetProperty("samples").EnumerateArray().Select(v => v.GetString()!).ToArray();
var configuration = new ServerConfiguration();
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, values) => method.Name == "get_Configuration" ? configuration : Stub.Default(method.ReturnType));
var sorts = samples.Select(name => new { name, movie = new Movie { Name = name }.SortName, person = new Person { Name = name }.SortName,
    alpha = BaseItem.GetSortName(name, true, configuration), plain = BaseItem.GetSortName(name, false, configuration) }).ToArray();
var comparisons = samples.SelectMany((left, l) => samples.Select((right, r) => new { l, r,
    current = Math.Sign(CultureInfo.CurrentCulture.CompareInfo.Compare(left, right, CompareOptions.None)),
    invariant = Math.Sign(CultureInfo.InvariantCulture.CompareInfo.Compare(left, right, CompareOptions.None)),
    currentIgnoreCase = Math.Sign(CultureInfo.CurrentCulture.CompareInfo.Compare(left, right, CompareOptions.IgnoreCase)),
    invariantIgnoreCase = Math.Sign(CultureInfo.InvariantCulture.CompareInfo.Compare(left, right, CompareOptions.IgnoreCase)) })).ToArray();
var sortComparisons = sorts.SelectMany((left, l) => sorts.Select((right, r) => new { l, r,
    movieCurrent = Math.Sign(CultureInfo.CurrentCulture.CompareInfo.Compare(left.movie, right.movie, CompareOptions.None)),
    movieInvariant = Math.Sign(CultureInfo.InvariantCulture.CompareInfo.Compare(left.movie, right.movie, CompareOptions.None)),
    personCurrent = Math.Sign(CultureInfo.CurrentCulture.CompareInfo.Compare(left.person, right.person, CompareOptions.None)),
    personInvariant = Math.Sign(CultureInfo.InvariantCulture.CompareInfo.Compare(left.person, right.person, CompareOptions.None)) })).ToArray();
var movieOrder = sorts.Select((value, index) => new { value.movie, index }).OrderBy(value => value.movie).Select(value => value.index).ToArray();
var personOrder = sorts.Select((value, index) => new { value.person, index }).OrderBy(value => value.person).Select(value => value.index).ToArray();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(v => !v.IsDynamic && !string.IsNullOrEmpty(v.Location)).OrderBy(v => v.GetName().Name)
    .Select(v => new { name = v.GetName().Name, location = v.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(v.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualNativeSortName = true, culture = CultureInfo.CurrentCulture.Name,
    SortRemoveWords = configuration.SortRemoveWords, SortRemoveCharacters = configuration.SortRemoveCharacters,
    SortReplaceCharacters = configuration.SortReplaceCharacters, sorts, comparisons, sortComparisons, movieOrder, personOrder, assemblies }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
