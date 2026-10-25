using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

public static class Certificates {
    public static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public static object FileRecord(string filename) {
        var bytes = File.ReadAllBytes(filename);
        return new { filename, size = bytes.Length, sha256 = Hash(bytes) };
    }
    public static object Prepare(JsonElement input, string inputHash, string output, string pemCertificate, string pemKey) {
        var directory = Path.Combine(output, "certificates"); Directory.CreateDirectory(directory);
        var password = input.GetProperty("certificatePassword").GetString()!;
        using var a = X509Certificate2.CreateFromPemFile(pemCertificate, pemKey);
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=network-listener-b", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder(); names.AddDnsName("localhost"); names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        var validity = input.GetProperty("certificateValidity");
        using var b = request.CreateSelfSigned(DateTimeOffset.Parse(validity.GetProperty("notBefore").GetString()!), DateTimeOffset.Parse(validity.GetProperty("notAfter").GetString()!));
        using var certificateOnly = X509CertificateLoader.LoadCertificate(a.RawData);
        object Export(string name, X509Certificate2 certificate) {
            var filename = Path.Combine(directory, name + ".pfx"); File.WriteAllBytes(filename, certificate.Export(X509ContentType.Pfx, password));
            var derFile = Path.Combine(directory, name + ".der"); File.WriteAllBytes(derFile, certificate.RawData);
            return new { file = FileRecord(filename), certificate = FileRecord(derFile), derSha256 = Hash(certificate.RawData) };
        }
        var pfxA = Export("a", a); var pfxB = Export("b", b); var publicOnly = Export("certificate-only", certificateOnly);
        var bad = Path.Combine(directory, "bad.pfx"); File.WriteAllBytes(bad, Encoding.UTF8.GetBytes("controlled non-PKCS12 original bytes\n"));
        var missing = Path.Combine(directory, "missing.pfx");
        return new { schemaVersion = 1, inputSha256 = inputHash, originalPem = new { certificate = FileRecord(pemCertificate), key = FileRecord(pemKey) },
            password, a = pfxA, b = pfxB, certificateOnly = publicOnly, bad = FileRecord(bad), missing,
            scope = "Actions-only one-time certificate preparation; initial/repeat consume these exact original PFX/DER bytes. Private-key source bytes are retained as files, never copied into JSON or logs." };
    }
}
