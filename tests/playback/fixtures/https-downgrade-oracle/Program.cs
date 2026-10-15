using System.Net;
using System.Security.Cryptography;
using System.Text.Json;

if (args.Length != 2)
{
    throw new ArgumentException("Expected an HTTPS URL and the exact SHA-256 certificate fingerprint.");
}

var expectedCertificate = args[1].Replace(":", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
using var handler = new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.All };
handler.SslOptions.RemoteCertificateValidationCallback = (_, certificate, _, _) =>
    certificate is not null && Convert.ToHexString(SHA256.HashData(certificate.GetRawCertData())) == expectedCertificate;
using var client = new HttpClient(handler);
using var response = await client.GetAsync(args[0], HttpCompletionOption.ResponseHeadersRead);
var bytes = await response.Content.ReadAsByteArrayAsync();
Console.WriteLine(JsonSerializer.Serialize(new
{
    status = (int)response.StatusCode,
    requestUri = response.RequestMessage?.RequestUri?.ToString(),
    location = response.Headers.Location?.ToString(),
    size = bytes.Length,
    sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()
}));
