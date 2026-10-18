using System.Collections.Concurrent;
using System.Security.Cryptography;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Attributes;
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Duplo.Extension.IncidentLens;

/// <summary>
/// Groups every IncidentLens resource under one permission-editor branch (reference/18 Pattern C). The node id
/// "incidentlens" is written into stored rule paths, so it is immutable.
/// </summary>
[AccessCategoryNode("incidentlens", Parent = typeof(Workspace), DisplayName = "IncidentLens")]
public sealed class IncidentLensCategory : AccessCategory { }

/// <summary>Named access actions. Ids are stored in customers' permission sets — never rename.</summary>
public static class Actions
{
    public const string Report = "incidentlens.report";
    public const string Triage = "incidentlens.triage";
    public const string Close = "incidentlens.close";
    public const string Respond = "incidentlens.respond";
}

/// <summary>Shared vocabularies. Strings (not enums) so the agent's JSON and the FE use the same tokens.</summary>
public static class Vocab
{
    public static readonly string[] Categories =
    {
        "road_collision", "pothole_road_damage", "waterlogging_flood",
        "fallen_tree_obstruction", "smoke_fire_indicator", "other_uncertain",
    };
    public static readonly string[] Priorities = { "P1", "P2", "P3", "P4" };
    public static readonly string[] AgencyTypes =
        { "police", "ambulance", "fire_rescue", "municipal_roads", "municipal_water", "other" };
    public static readonly string[] LocationSources = { "gps", "gps_adjusted", "manual" };

    // Assignment lifecycle — every transition is a human action (lead or admin); nothing is tracked live.
    public const string Requested = "requested", Acknowledged = "acknowledged", EnRoute = "en_route",
        OnScene = "on_scene", Completed = "completed", Cancelled = "cancelled";
    public static readonly string[] ActiveAssignmentStates = { Requested, Acknowledged, EnRoute, OnScene };
    public static readonly Dictionary<string, string[]> AllowedNext = new()
    {
        [Requested] = new[] { Acknowledged, Cancelled },
        [Acknowledged] = new[] { EnRoute, OnScene, Cancelled },
        [EnRoute] = new[] { OnScene, Cancelled },
        [OnScene] = new[] { Completed, Cancelled },
        [Completed] = Array.Empty<string>(),
        [Cancelled] = Array.Empty<string>(),
    };

    public static bool IsCategory(string? c) => c != null && Categories.Contains(c);
}

/// <summary>Raised when a precondition fails in a way the caller can fix (maps to 409 Conflict).</summary>
public sealed class ConflictException : Exception
{
    public object? Detail { get; }
    public ConflictException(string message, object? detail = null) : base(message) { Detail = detail; }
}

/// <summary>Caller is authenticated and holds the grant, but the server-side rule refuses (maps to 403).</summary>
public sealed class ForbiddenException : Exception
{
    public ForbiddenException(string message) : base(message) { }
}

/// <summary>
/// Marks a write as performed by IncidentLens's own workflow code. Entity hooks reject changes to protected
/// fields (membership, assignment state, audit, photo/GPS evidence) unless this scope is active, so the
/// inherited generic PUT/PATCH/results endpoints cannot bypass the audited workflow.
/// </summary>
public static class TrustedWrite
{
    private static readonly AsyncLocal<int> Depth = new();
    public static bool Active => Depth.Value > 0;
    public static IDisposable Begin()
    {
        Depth.Value++;
        return new Scope();
    }
    private sealed class Scope : IDisposable
    {
        private bool _done;
        public void Dispose()
        {
            if (_done) return;
            _done = true;
            Depth.Value--;
        }
    }
}

/// <summary>
/// Serializes mutations per key (one incident, one reporter's submissions) inside this studio process. With the
/// single local studio instance this makes check-then-write sequences atomic; a multi-replica deployment would
/// need a database-side conditional update instead (documented in README "Known limits").
/// </summary>
public static class KeyedLock
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks = new();
    public static async Task<IDisposable> AcquireAsync(string key, CancellationToken ct)
    {
        var sem = Locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await sem.WaitAsync(ct);
        return new Releaser(sem);
    }
    private sealed class Releaser : IDisposable
    {
        private SemaphoreSlim? _sem;
        public Releaser(SemaphoreSlim sem) => _sem = sem;
        public void Dispose() { Interlocked.Exchange(ref _sem, null)?.Release(); }
    }
}

/// <summary>
/// Private evidence store (report photos, resolution photos) in its own Mongo collection. Deliberately NOT the
/// shared /data file store: that volume is also mounted into the agent container, where any ticket could read
/// it. Mongo is reachable only by the studio. Bytes are served solely through IncidentLens endpoints that
/// re-check authorization on every request.
/// </summary>
public static class EvidenceStore
{
    public const string Collection = "extension_incidentlensevidence";
    public const int MaxBytes = 8 * 1024 * 1024;

    private static IMongoCollection<BsonDocument> Col(IMongoDatabase db) => db.GetCollection<BsonDocument>(Collection);

    public static bool LooksLikeJpeg(byte[] b) => b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF;

    public static string Sha256(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    public static async Task PutAsync(IMongoDatabase db, string key, byte[] bytes, string contentType, CancellationToken ct)
    {
        var doc = new BsonDocument
        {
            { "_id", key }, { "contentType", contentType }, { "size", bytes.Length },
            { "sha256", Sha256(bytes) }, { "createdAt", DateTime.UtcNow }, { "data", new BsonBinaryData(bytes) },
        };
        await Col(db).ReplaceOneAsync(Builders<BsonDocument>.Filter.Eq("_id", key), doc,
            new ReplaceOptions { IsUpsert = true }, ct);
    }

    public static async Task<(byte[] Bytes, string ContentType)?> GetAsync(IMongoDatabase db, string key, CancellationToken ct)
    {
        var doc = await Col(db).Find(Builders<BsonDocument>.Filter.Eq("_id", key)).FirstOrDefaultAsync(ct);
        if (doc == null) return null;
        return (doc["data"].AsBsonBinaryData.Bytes, doc.GetValue("contentType", "image/jpeg").AsString);
    }

    public static Task DeleteAsync(IMongoDatabase db, string key, CancellationToken ct)
        => Col(db).DeleteOneAsync(Builders<BsonDocument>.Filter.Eq("_id", key), ct);
}

/// <summary>Per-workspace IncidentLens settings (grouping windows, Vision configuration), one document each.</summary>
[BsonIgnoreExtraElements]
public class IncidentLensSettings
{
    [BsonId] public string WorkspaceId { get; set; } = "";
    public List<GroupingWindow> GroupingWindows { get; set; } = GroupingPolicy.Defaults();
    /// <summary>Scope id of the server-side Cloud Vision credential (provider type "other", scope name "vision-api").</summary>
    public string? VisionScopeId { get; set; }
    /// <summary>
    /// LOCAL DEVELOPMENT ONLY: when no Vision scope is configured, the assessment tool returns canned annotations
    /// labelled provider "fixture". Never confused with real provenance; the UI shows a FIXTURE badge.
    /// </summary>
    public bool VisionFixtureMode { get; set; }
    /// <summary>Scope "google-maps-server" (Places API (New), Routes, Geocoding — server key, never sent to browsers).</summary>
    public string? MapsScopeId { get; set; }
    /// <summary>Scope "gemini-api" (Gemini API key for Google Search grounding in Situation Briefs).</summary>
    public string? GeminiScopeId { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }
}

public static class SettingsStore
{
    public const string Collection = "extension_incidentlenssettings";

    public static async Task<IncidentLensSettings> GetAsync(IMongoDatabase db, string ws, CancellationToken ct)
    {
        var col = db.GetCollection<IncidentLensSettings>(Collection);
        var s = await col.Find(x => x.WorkspaceId == ws).FirstOrDefaultAsync(ct);
        if (s == null) return new IncidentLensSettings { WorkspaceId = ws };
        // Fill categories added after the document was written (e.g. a new category in a later version).
        foreach (var d in GroupingPolicy.Defaults())
            if (s.GroupingWindows.All(w => w.Category != d.Category)) s.GroupingWindows.Add(d);
        return s;
    }

    public static Task SaveAsync(IMongoDatabase db, IncidentLensSettings s, CancellationToken ct)
        => db.GetCollection<IncidentLensSettings>(Collection)
             .ReplaceOneAsync(x => x.WorkspaceId == s.WorkspaceId, s, new ReplaceOptions { IsUpsert = true }, ct);
}

/// <summary>Shared append-only history records embedded in incident documents.</summary>
[BsonIgnoreExtraElements]
public class AuditEntry
{
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string ActorEmail { get; set; } = "";
    public string Action { get; set; } = "";
    public string? Target { get; set; }
    public string? FromState { get; set; }
    public string? ToState { get; set; }
    public string? Reason { get; set; }
    public string? Detail { get; set; }
}

[BsonIgnoreExtraElements]
public class NotificationAttempt
{
    public DateTime At { get; set; } = DateTime.UtcNow;
    /// <summary>Always "mock": IncidentLens never contacts a real agency.</summary>
    public string Channel { get; set; } = "mock";
    public string To { get; set; } = "";
    /// <summary>pending | sent | failed. "sent" is a delivery attempt, never an acknowledgement.</summary>
    public string State { get; set; } = "sent";
    public string Detail { get; set; } = "";
}

public static class Ids
{
    private static readonly char[] Alphabet = "abcdefghijkmnpqrstuvwxyz23456789".ToCharArray();
    public static string Short(int n = 6)
    {
        var bytes = RandomNumberGenerator.GetBytes(n);
        return new string(bytes.Select(b => Alphabet[b % Alphabet.Length]).ToArray());
    }
    public static string Name(string prefix) => $"{prefix}-{DateTime.UtcNow:yyMMdd-HHmm}-{Short(4)}";
}
