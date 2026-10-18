using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.Model.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Duplo.Extension.IncidentLens;

public record AgentMapsChoice(string Service, string PlaceId, string Reason);
public record AgentMapsRequest(string Action, string? RunId = null, List<AgentMapsChoice>? Choices = null);

/// <summary>Server-written source ledger, separate from generic agent-editable report results.</summary>
[BsonIgnoreExtraElements]
public class ReportMapsLedger
{
    [BsonId] public string Id { get; set; } = "";
    public string RunId { get; set; } = "";
    public string WorkspaceId { get; set; } = "";
    public string ReportId { get; set; } = "";
    public string ScopeId { get; set; } = "";
    public string AssessmentKey { get; set; } = "";
    public string Policy { get; set; } = FacilityPolicy.Version;
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public DateTime RetrievedAt { get; set; }
    public DateTime? SelectedAt { get; set; }
    public List<string> Services { get; set; } = new();
    public List<NearbyFacility> Candidates { get; set; } = new();
    public List<AgentMapsChoice> Choices { get; set; } = new();
}

public static class ReportMapsPolicy
{
    public const string Collection = "extension_incidentlensreportmaps";
    public static string AssessmentKey(IncidentLensReport r) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        JsonSerializer.Serialize(new { r.Spec!.PhotoSha256, r.Result?.AssessmentState, r.Result?.Assessment }))));
    public static bool Current(ReportMapsLedger l, IncidentLensReport r, DateTime now)
        => l.WorkspaceId == r.OwnerWorkspaceId && l.ReportId == r.Id && l.Policy == FacilityPolicy.Version
        && r.Spec?.ScopeIds?.Contains(l.ScopeId) == true && l.AssessmentKey == AssessmentKey(r)
        && l.Latitude == r.Spec.Latitude && l.Longitude == r.Spec.Longitude
        && l.RetrievedAt <= now && l.RetrievedAt > now - FacilityPolicy.CacheLifetime;
    public static List<AgentMapsChoice> Validate(ReportMapsLedger l, IncidentLensReport r, AgentMapsRequest req, DateTime now)
    {
        if (!Current(l, r, now) || req.RunId != l.RunId) throw new ArgumentException("Maps source expired or changed. Prepare this report again.");
        var choices = req.Choices ?? throw new ArgumentException("Provide choices, including an empty list when no listing is relevant.");
        if (choices.Count > 15 || choices.GroupBy(x => (x.Service, x.PlaceId)).Any(g => g.Count() > 1)
            || choices.GroupBy(x => x.Service).Any(g => g.Count() > 3)) throw new ArgumentException("Choose at most three distinct listings per service.");
        foreach (var x in choices)
        {
            var f = l.Candidates.SingleOrDefault(f => f.Service == x.Service && f.PlaceId == x.PlaceId);
            if (!l.Services.Contains(x.Service) || f == null || f.Provider != "google_places" || FacilityPolicy.Classify(f).Suitability != "candidate")
                throw new ArgumentException("Choose only source-listed candidates for this service; supplied listing details are never accepted.");
            if (x.Reason is not ("service_type_match" or "route_estimate_available" or "nearby_relevant_listing"))
                throw new ArgumentException("Use a supported relevance reason; capability and availability remain unconfirmed.");
            if (x.Reason == "route_estimate_available" && !f.DriveMinutes.HasValue)
                throw new ArgumentException("This source has no route estimate; choose a supported source fact.");
        }
        return choices;
    }
    public static bool CanUseForIncident(ReportMapsLedger l, IncidentLensReport r, string service, double lat, double lng, DateTime now)
        => l.SelectedAt != null && l.SelectedAt <= now && Current(l, r, now) && l.Services.Contains(service)
           && Geo.DistanceM(l.Latitude, l.Longitude, lat, lng) <= 100;
    public static List<NearbyFacility> Selected(ReportMapsLedger l, string service, string incidentId)
        => l.Choices.Where(c => c.Service == service).Select(c => l.Candidates.Single(f => f.Service == service && f.PlaceId == c.PlaceId)
            with { WorkspaceId = l.WorkspaceId, IncidentId = incidentId, ScreenedAt = l.RetrievedAt,
                ScreeningPolicy = l.Policy, ScreeningOrigin = "agent_screened_listing", AgentReason = c.Reason }).ToList();
}

public partial class IncidentLensReportService
{
    /// <summary>No ticket creation or context mutation. Only a pre-authorized, report-scoped agent may invoke this phase.</summary>
    public async Task<object> AgentMapsAsync(string ws, string id, AgentMapsRequest req, CancellationToken ct, string? mapsRunId = null)
    {
        if (mapsRunId == null) throw new ArgumentException("Prepare and explicitly start a bounded Maps run first.");
        if (req.Action is not ("prepare" or "finalize")) throw new ArgumentException("Use prepare or finalize.");
        using var lk = await KeyedLock.AcquireAsync($"report-maps:{ws}:{id}", ct);
        var report = await _repo.GetByIdAsync(id, ct);
        if (report?.OwnerWorkspaceId != ws || report.Spec == null) throw new KeyNotFoundException("Report not found.");
        if (report.Result?.Assessment == null) throw new ArgumentException("Complete the assessment before preparing Maps; this phase never reassesses a photo.");
        using var scope = _sf.CreateScope();
        var workspaces = scope.ServiceProvider.GetRequiredService<IWorkspaceService>();
        var attached = await workspaces.GetScopesInWorkspaceAsync(ws, ct);
        var allowed = attached.Where(s => report.Spec.ScopeIds?.Contains(s.Id) == true).ToList();
        var settings = await SettingsStore.GetAsync(_db, ws, ct);
        var mapsId = MapsScopeSelection.Select(allowed, settings.MapsScopeId);
        var store = _db.GetCollection<ReportMapsLedger>(ReportMapsPolicy.Collection);
        var ledger = await store.Find(x => x.Id == ws + ":" + id).FirstOrDefaultAsync(ct);
        var now = DateTime.UtcNow;
        var run = await MapsRuns.Find(x => x.Id == mapsRunId && x.WorkspaceId == ws && x.ReportId == id).FirstOrDefaultAsync(ct)
            ?? throw new ArgumentException("Maps run not found.");
        MapsRunPolicy.Validate(run, report, now);
        if (run.State != "claimed" || run.ScopeId != mapsId) throw new ArgumentException("The bounded agent must claim this run first.");
        if (req.Action == "prepare")
        {
            // A retry reuses this ledger (even an empty selection); no repeated paid fetch within its lifetime.
            if (ledger == null || !ReportMapsPolicy.Current(ledger, report, now) || ledger.ScopeId != mapsId || ledger.RunId != mapsRunId)
            {
                var services = new List<string> { run.Service };
                var candidates = await SingleUseMapsAllowance.RunAsync(async () => {
                    var spent = await MapsRuns.UpdateOneAsync(x => x.Id == mapsRunId && x.State == "claimed" && !x.ProviderSpent,
                        Builders<MapsRun>.Update.Set(x => x.ProviderSpent, true), cancellationToken: ct);
                    return spent.ModifiedCount == 1;
                }, async () => {
                    var resolved = (await _scopes.ResolveAsync(new[] { mapsId }, ct)).SingleOrDefault();
                    if (resolved?.Scope?.Id != mapsId || resolved.Scope.Name != MapsScopeSelection.Name)
                        throw new ArgumentException("The authorized Maps scope could not be resolved.");
                    var key = MapsScopeSelection.RequireKey(resolved.Data);
                    return FacilityPolicy.ScreenedShortlist(await GooglePlaces.NearbyAsync(key, run.Service,
                        report.Spec.Latitude, report.Spec.Longitude, 3, ct));
                });
                ledger = new() { Id = ws + ":" + id, RunId = mapsRunId, WorkspaceId = ws, ReportId = id,
                    ScopeId = mapsId, AssessmentKey = ReportMapsPolicy.AssessmentKey(report), Latitude = report.Spec.Latitude,
                    Longitude = report.Spec.Longitude, RetrievedAt = now, Services = services, Candidates = candidates };
                await store.ReplaceOneAsync(x => x.Id == ledger.Id, ledger, new ReplaceOptions { IsUpsert = true }, ct);
            }
            // No coordinates, credentials, reporter identity or photo in the model-facing list.
            return new { ledger.RunId, state = ledger.SelectedAt.HasValue ? "already_selected" : "ready", ledger.Services,
                candidates = ledger.Candidates.Select(f => new { f.Service, f.PlaceId, f.Name, f.PrimaryType, f.Types,
                    f.SuitabilityReasons, f.StraightLineKm, f.DriveMinutes, f.Provider }),
                capability = "unconfirmed", availability = "unconfirmed" };
        }
        if (ledger == null || ledger.ScopeId != mapsId || ledger.RunId != mapsRunId) throw new ArgumentException("Prepare this report's Maps source first.");
        var choices = ReportMapsPolicy.Validate(ledger, report, req, now);
        if (ledger.SelectedAt.HasValue)
        {
            if (JsonSerializer.Serialize(ledger.Choices) != JsonSerializer.Serialize(choices))
                throw new ArgumentException("This run is already finalized; wait for an explicit refresh.");
        }
        else
        {
            ledger.Choices = choices; ledger.SelectedAt = now;
            await store.ReplaceOneAsync(x => x.Id == ledger.Id && x.RunId == req.RunId, ledger, cancellationToken: ct);
        }
        // Does not touch the report assessment, Vision results, status, ticket, or ticket context.
        return new { state = "complete", selected = ledger.Choices.Count, screening = "agent_screened_listing",
            capability = "unconfirmed", availability = "unconfirmed" };
    }
}
