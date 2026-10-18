using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Duplo.Ai.Common.Auth;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.Common.Models;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Duplo.Extension.IncidentLens;
public record MapsRunSetup(string RequestId, string Service);
[BsonIgnoreExtraElements]
public class MapsRun
{
    [BsonId] public string Id { get; set; } = "";
    public string WorkspaceId { get; set; } = "";
    public string ReportId { get; set; } = "";
    public string TicketId { get; set; } = "";
    public string TicketName { get; set; } = "";
    public string ScopeId { get; set; } = "";
    public string AssessmentKey { get; set; } = "";
    public string Service { get; set; } = "";
    public string State { get; set; } = "preparing";
    public DateTime ExpiresAt { get; set; }
    public bool ProviderSpent { get; set; }
    public const int MaxTurns = 6;
    public const int MaxOutputTokens = 1024;
}
public static class MapsRunPolicy
{
    public const string Collection = "extension_incidentlensmapsrun";
    public static void Validate(MapsRun run, IncidentLensReport report, DateTime now)
    {
        if (run.WorkspaceId != report.OwnerWorkspaceId || run.ReportId != report.Id
            || run.TicketId != report.TicketContext?.TicketId || run.ExpiresAt <= now
            || run.AssessmentKey != ReportMapsPolicy.AssessmentKey(report)
            || report.Spec?.ScopeIds?.Contains(run.ScopeId) != true)
            throw new ArgumentException("Maps run expired or its report, ticket, assessment or scope changed.");
    }
    public static string Path(string ws, string report, string run) =>
        $"/v1/aiservicedesk/user/data/workspaces/{ws}/environment/extensions/incidentlens-reports/{report}/maps-runs/{run}";
}
public partial class IncidentLensReportService
{
    private IMongoCollection<MapsRun> MapsRuns => _db.GetCollection<MapsRun>(MapsRunPolicy.Collection);
    private void RequireMapsOperator()
    {
        if (!(_user.Roles ?? Array.Empty<string>()).Contains("Administrator"))
            throw new UnauthorizedAccessException("Maps run setup/start requires an administrator.");
    }
    public async Task<object> SetupMapsRunAsync(string ws, string id, MapsRunSetup req, CancellationToken ct)
    {
        RequireMapsOperator();
        if (!Guid.TryParseExact(req.RequestId, "N", out _) || !Corroboration.Services.Contains(req.Service))
            throw new ArgumentException("Provide a new 32-character request UUID and one supported service.");
        using var lk = await KeyedLock.AcquireAsync($"report-maps:{ws}:{id}", ct);
        var r = await _repo.GetByIdAsync(id, ct);
        if (r?.OwnerWorkspaceId != ws || r.Spec == null) throw new KeyNotFoundException("Report not found.");
        if (r.Status != ResourceStatus.Complete || r.Result?.Assessment == null || string.IsNullOrEmpty(r.TicketContext?.TicketId))
            throw new ArgumentException("Use a completed assessed report with its existing ticket.");
        using var scope = _sf.CreateScope();
        var tickets = scope.ServiceProvider.GetRequiredService<ITicketService>();
        var ticket = await tickets.GetByIdAsync(r.TicketContext.TicketId, ct);
        if (ticket?.WorkspaceId != ws || ticket.OriginContext?.Id != id) throw new ArgumentException("Ticket does not belong to this report.");
        var settings = await SettingsStore.GetAsync(_db, ws, ct);
        var workspaces = scope.ServiceProvider.GetRequiredService<IWorkspaceService>();
        var mapsId = MapsScopeSelection.Select(await workspaces.GetScopesInWorkspaceAsync(ws, ct), settings.MapsScopeId);
        var run = await MapsRuns.Find(x => x.Id == req.RequestId).FirstOrDefaultAsync(ct);
        if (run != null)
        {
            if (run.WorkspaceId != ws || run.ReportId != id || run.Service != req.Service || run.ScopeId != mapsId)
                throw new ArgumentException("Request ID belongs to a different setup.");
            if (run.State != "preparing") return new { run.Id, run.State, run.ExpiresAt };
        }
        else
        {
            run = new() { Id = req.RequestId, WorkspaceId = ws, ReportId = id, TicketId = ticket.Id, TicketName = ticket.Name,
                ScopeId = mapsId, AssessmentKey = ReportMapsPolicy.AssessmentKey(r), Service = req.Service,
                ExpiresAt = DateTime.UtcNow.AddMinutes(30) };
            await MapsRuns.InsertOneAsync(run, cancellationToken: ct);
        }
        // Service PatchAsync deliberately skips resource OnAfterUpdate/reconciliation. No raw DB report edits.
        r = await PatchAsync(id, row => { row.Spec!.ScopeIds ??= new(); if (!row.Spec.ScopeIds.Contains(mapsId)) row.Spec.ScopeIds.Add(mapsId); }, ct)
            ?? throw new InvalidOperationException("Report setup failed.");
        var context = ticket.TicketContextForAgent ?? new AgentTicketContext();
        if (!context.ScopeIds.Contains(mapsId)) context.ScopeIds.Add(mapsId);
        await tickets.UpdateTicketContextAsync(ticket.Name, context, ct);
        await tickets.PutTicketFileAsync(ticket.Id, "shared/incidentlens-report.json", await GetExpandedSpecForAgentAsync(r, ct), ct);
        await MapsRuns.UpdateOneAsync(x => x.Id == run.Id && x.State == "preparing", Builders<MapsRun>.Update.Set(x => x.State, "prepared"), cancellationToken: ct);
        return new { run.Id, state = "prepared", run.Service, run.ExpiresAt, maxTurns = MapsRun.MaxTurns,
            maxPlacesRequests = 3, maxRoutesRequests = 1, maxRouteElements = 3, assessmentUnchanged = true };
    }
    public async Task<object> StartMapsRunAsync(string ws, string id, string runId, CancellationToken ct)
    {
        RequireMapsOperator();
        using var scope = _sf.CreateScope();
        var r = await _repo.GetByIdAsync(id, ct) ?? throw new KeyNotFoundException("Report not found.");
        var run = await MapsRuns.Find(x => x.Id == runId && x.WorkspaceId == ws && x.ReportId == id).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("Maps run not found.");
        MapsRunPolicy.Validate(run, r, DateTime.UtcNow);
        if (run.State != "prepared") return new { state = run.State, retryStarted = false };
        var tickets = scope.ServiceProvider.GetRequiredService<ITicketService>();
        var ticket = await tickets.GetByIdAsync(run.TicketId, ct) ?? throw new KeyNotFoundException("Ticket not found.");
        var agents = scope.ServiceProvider.GetRequiredService<IRepository<AIAgent>>();
        var agent = await agents.GetByIdAsync(ticket.AIAgentId!, ct);
        if (!Uri.TryCreate(agent?.Endpoint, UriKind.Absolute, out var agentUri)) throw new ArgumentException("Ticket agent endpoint is unavailable.");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        // Fail closed before minting/sending: old agent runtime cannot enforce this protocol.
        var capability = await http.GetFromJsonAsync<JsonObject>(new Uri(agentUri, "/v1/api/capabilities/incidentlens-maps"), ct);
        if ((string?)capability?["protocol"] != "incidentlens-maps-v1") throw new ArgumentException("Agent runtime update required; nothing started.");
        var update = await MapsRuns.UpdateOneAsync(x => x.Id == runId && x.State == "prepared", Builders<MapsRun>.Update.Set(x => x.State, "starting"), cancellationToken: ct);
        if (update.ModifiedCount != 1) return new { state = "already_started", retryStarted = false };
        var path = MapsRunPolicy.Path(ws, id, runId);
        var token = scope.ServiceProvider.GetRequiredService<IJwtService>().CreateScopedToken(new[] {
            "*" + path + "/claim", "*" + path + "/agent", ApiTokenConstants.AgentCallbackPathPattern(ws, ticket.Name) }, TimeSpan.FromMinutes(30));
        var cfg = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var baseUrl = cfg["AIStudio:AppBaseUrl"];
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = cfg["Authentication:FrontendBaseUrl"];
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out _)) throw new ArgumentException("Backend base URL is unavailable; run remains spent, do not retry start.");
        var message = new MessageBase { content = "Maps-only run. Follow the assess-incident-report skill maps-prepare and maps-finalize commands only. "
            + "Use source IDs and permitted reasons, at most three listings. Never run photo prepare/finalize, Vision, reassessment, or dispatch. No retries after errors.",
            data = new JsonObject(), User = ticket.CreatedBy,
            platform_context = new JsonObject { ["duplo_token"] = token, ["duplo_base_url"] = baseUrl,
                ["incidentlens_maps_run"] = new JsonObject { ["path"] = path, ["runId"] = runId } } };
        // Mark before sending. Unknown send outcomes cannot be retried into a second native run.
        await tickets.SendOrEnqueueMessageStreamingAsync(ticket.Name, message, terminateSessions: false);
        return new { state = "submitted_once", run.Id, maxTurns = MapsRun.MaxTurns };
    }
    public async Task<object> ClaimMapsRunAsync(string ws, string id, string runId, CancellationToken ct)
    {
        var r = await _repo.GetByIdAsync(id, ct) ?? throw new KeyNotFoundException("Report not found.");
        var run = await MapsRuns.Find(x => x.Id == runId && x.WorkspaceId == ws && x.ReportId == id).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("Maps run not found.");
        MapsRunPolicy.Validate(run, r, DateTime.UtcNow);
        var update = await MapsRuns.UpdateOneAsync(x => x.Id == runId && x.State == "starting", Builders<MapsRun>.Update.Set(x => x.State, "claimed"), cancellationToken: ct);
        if (update.ModifiedCount != 1) throw new ArgumentException("This run was already claimed or has not been started.");
        return new { protocol = "incidentlens-maps-v1", runId, ticketName = run.TicketName,
            maxTurns = MapsRun.MaxTurns, maxOutputTokens = MapsRun.MaxOutputTokens, path = MapsRunPolicy.Path(ws, id, runId) };
    }
}

public static class SingleUseMapsAllowance
{
    // Claim persistence must be atomic. Never refund after a failed/uncertain external call.
    public static async Task<T> RunAsync<T>(Func<Task<bool>> spend, Func<Task<T>> work)
    {
        if (!await spend()) throw new ArgumentException("Provider allowance already spent; no retry is permitted.");
        return await work();
    }
}
