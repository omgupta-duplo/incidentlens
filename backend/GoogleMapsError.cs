using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Duplo.Extension.IncidentLens;

/// <summary>Only the sanitized diagnostic is carried through the API error envelope.</summary>
public sealed class GoogleMapsException(string message) : Exception(message);

public static class GoogleMapsError
{
    private const int MaxBody = 16384;
    private static string Text(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
    private static string Clean(string text, string? key)
    {
        // Remove the actual submitted credential before any truncation or pattern processing.
        if (!string.IsNullOrEmpty(key)) text = text.Replace(key, "[REDACTED]", StringComparison.Ordinal);
        text = Regex.Replace(text, @"https?://[^\s<>""']+", "[URL omitted]", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\bBearer\s+\S+", "Bearer [REDACTED]", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\b(?:api[ _-]?key|x-goog-api-key|token|access[ _-]?token|refresh[ _-]?token|authorization|password|secret|credential|signature)\b[""']?\s*[:=]\s*(?:""[^""]*""|'[^']*'|[^\s,;]+)", "[credential omitted]", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\bAIza[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_.-]+|[A-Za-z0-9_+/=-]{32,}", "[REDACTED]");
        text = Regex.Replace(text, @"[\p{C}\s]+", " ").Trim();
        return text.Length > 500 ? text[..500] + "…" : text;
    }
    public static string Describe(int statusCode, string body, string? key)
    {
        var prefix = $"Places API returned {statusCode}.";
        if (body.Length > MaxBody) return prefix + " Google error body exceeded the diagnostic limit.";
        try
        {
            var error = JsonNode.Parse(body, documentOptions: new() { MaxDepth = 16 })?["error"] as JsonObject;
            if (error == null) return prefix + " No structured Google error details.";
            var status = Text(error["status"]);
            if (!Regex.IsMatch(status, @"^[A-Z][A-Z_]{0,63}$")) status = "";
            var reasons = (error["details"] as JsonArray ?? new JsonArray())
                .OfType<JsonObject>().Select(d => Text(d["reason"]))
                .Where(s => Regex.IsMatch(s, @"^[A-Z][A-Z_]{0,63}$")).Distinct().Take(3);
            var codes = string.Join(" / ", new[] { status }.Concat(reasons).Where(s => s.Length > 0));
            var message = Clean(Text(error["message"]), key);
            return prefix + (codes.Length > 0 ? " " + Clean(codes, key) + "." : "") + (message.Length > 0 ? " " + message : "");
        }
        catch (System.Text.Json.JsonException) { return prefix + " Google error details were not valid JSON."; }
        catch (InvalidOperationException) { return prefix + " No structured Google error details."; }
    }
    public static async Task<string> ReadAsync(HttpResponseMessage response, string? key, CancellationToken ct)
    {
        // Bounded read: never retain/log an entire unexpected upstream error response.
        using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        readTimeout.CancelAfter(TimeSpan.FromSeconds(15));
        ct = readTimeout.Token;
        using var stream = await response.Content.ReadAsStreamAsync(ct);
        var bytes = new byte[MaxBody + 1]; var count = 0;
        while (count < bytes.Length)
        {
            var n = await stream.ReadAsync(bytes.AsMemory(count), ct);
            if (n == 0) break;
            count += n;
        }
        return count > MaxBody ? $"Places API returned {(int)response.StatusCode}. Google error body exceeded the diagnostic limit."
            : Describe((int)response.StatusCode, System.Text.Encoding.UTF8.GetString(bytes, 0, count), key);
    }
}
