using System.Text.Json;
using Duplo.Ai.DataManagement.AccessControl;
using Duplo.Ai.DataManagement.Controllers.User.Resource;
using Duplo.Ai.DataManagement.Models;
using Duplo.Ai.Model.Interfaces;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.IncidentLens;

/// <summary>Maps workflow exceptions to the platform's ApiResponse envelope (reference/15: the reason goes in `errors`).</summary>
internal static class Guard
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const long PhotoLimit = 9 * 1024 * 1024;

    public static async Task<IActionResult> Run(ControllerBase c, Func<Task<IActionResult>> f)
    {
        try { return await f(); }
        catch (ConflictException e)
        {
            var r = ApiResponse<object>.ErrorResult("Conflict", e.Message, "conflict");
            r.Data = e.Detail;
            return c.StatusCode(StatusCodes.Status409Conflict, r);
        }
        catch (GoogleMapsException e) { return c.StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.ErrorResult("Google Maps unavailable", e.Message, "google_maps_error")); }
        catch (ForbiddenException e) { return c.StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.ErrorResult("Forbidden", e.Message, "forbidden")); }
        catch (KeyNotFoundException e) { return c.NotFound(ApiResponse<object>.ErrorResult("Not found", e.Message, "not_found")); }
        catch (NotSupportedException e) { return c.StatusCode(StatusCodes.Status405MethodNotAllowed, ApiResponse<object>.ErrorResult("Not supported", e.Message)); }
        catch (ArgumentException e) { return c.BadRequest(ApiResponse<object>.ErrorResult("Invalid request", e.Message)); }
        catch (JsonException) { return c.BadRequest(ApiResponse<object>.ErrorResult("Invalid request", "The request body is not valid JSON.")); }
    }

    public static IActionResult Ok<T>(ControllerBase c, T data, string message = "OK") => c.Ok(ApiResponse<T>.SuccessResult(data, message));

    public static T Payload<T>(string? payload) where T : class
        => JsonSerializer.Deserialize<T>(string.IsNullOrWhiteSpace(payload) ? "{}" : payload, Json)
           ?? throw new ArgumentException("Missing request payload.");

    public static async Task<byte[]> ReadPhotoAsync(IFormFile? photo, bool required, CancellationToken ct)
    {
        if (photo == null || photo.Length == 0)
        {
            if (required) throw new ArgumentException("A photo is required.");
            return Array.Empty<byte>();
        }
        if (photo.Length > PhotoLimit) throw new ArgumentException("Photo is larger than 8 MB.");
        using var ms = new MemoryStream();
        await photo.CopyToAsync(ms, ct);
        return ms.ToArray();
    }

    public static IActionResult Photo(ControllerBase c, (byte[] Bytes, string ContentType)? p)
    {
        if (p == null) return c.NotFound(ApiResponse<object>.ErrorResult("Not found", "No photo."));
        c.Response.Headers["Cache-Control"] = "private, no-store";
        return c.File(p.Value.Bytes, p.Value.ContentType);
    }

    public static IActionResult UseWorkflow(ControllerBase c, string how)
        => c.StatusCode(StatusCodes.Status405MethodNotAllowed, ApiResponse<object>.ErrorResult("Use the workflow endpoint", how));
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/incidentlens-reports")]
[AccessControl(Parent = typeof(IncidentLensCategory), ParentIdProperty = "OwnerWorkspaceId")]
public class IncidentLensReportsController : ResourcesController<IncidentLensReport, IncidentLensReportSpec, IncidentLensReportResult>
{
    private readonly IncidentLensReportService _svc;

    public IncidentLensReportsController(IEntityService<IncidentLensReport> service, IncidentLensReportService svc,
        ILogger<IncidentLensReportsController> logger) : base(service, logger) { _svc = svc; }

    /// <summary>Reports are created only by camera submission (photo + confirmed pin), never by generic POST.</summary>
    public override Task<IActionResult> Create([FromBody] IncidentLensReport resource, CancellationToken cancellationToken = default)
        => Task.FromResult(Guard.UseWorkflow(this, "Submit reports with POST …/incidentlens-reports/submit."));

    [HttpGet("whoami")]
    [NoResourceAccessCheck(Reason = "Reports the caller's own IncidentLens capabilities; no resource instance is read.")]
    public Task<IActionResult> WhoAmI(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.WhoAmIAsync(workspaceId, ct)));

    [HttpPost("submit")]
    [RequestSizeLimit(10 * 1024 * 1024)]
    [Consumes("multipart/form-data")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Report, ActionName = "Report incidents",
        Description = "Submit camera reports with a confirmed location and follow the status of the caller's OWN reports. Grants no access to anyone else's reports.")]
    public Task<IActionResult> Submit(string workspaceId, [FromForm] IFormFile? photo, [FromForm] string? payload, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var req = Guard.Payload<SubmitReportRequest>(payload);
            var bytes = await Guard.ReadPhotoAsync(photo, true, ct);
            var (report, created) = await _svc.SubmitAsync(workspaceId, req, bytes, ct);
            var view = await _svc.ReporterViewAsync(report, ct);
            return created ? StatusCode(StatusCodes.Status201Created, ApiResponse<object>.SuccessResult(view, "Report received"))
                           : Guard.Ok(this, view, "Already received (same clientRequestId)");
        });

    [HttpGet("mine")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Report)]
    public Task<IActionResult> Mine(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var rows = await _svc.MineAsync(workspaceId, ct);
            var views = new List<object>();
            foreach (var r in rows) views.Add(await _svc.ReporterViewAsync(r, ct));
            return Guard.Ok(this, views);
        });

    [HttpGet("mine/{id}")]
    [AccessControl(Action = Actions.Report)]
    public Task<IActionResult> MineOne(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var r = await _svc.GetOwnedAsync(workspaceId, id, ct) ?? throw new KeyNotFoundException("Report not found.");
            return Guard.Ok(this, await _svc.ReporterViewAsync(r, ct));
        });

    [HttpGet("mine/{id}/photo")]
    [AccessControl(Action = Actions.Report)]
    public Task<IActionResult> MinePhoto(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var r = await _svc.GetOwnedAsync(workspaceId, id, ct) ?? throw new KeyNotFoundException("Report not found.");
            return Guard.Photo(this, await _svc.GetPhotoAsync(r, ct));
        });

    /// <summary>Control room photo access (inherited GET verb on the report node).</summary>
    [HttpGet("{id}/photo")]
    public Task<IActionResult> Photo(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var r = await _svc.GetByIdUnenrichedAsync(id, ct);
            if (r == null || r.OwnerWorkspaceId != workspaceId) throw new KeyNotFoundException("Report not found.");
            return Guard.Photo(this, await _svc.GetPhotoAsync(r, ct));
        });

    /// <summary>
    /// Just-in-time evidence for the assessment agent. Reachable ONLY with this report's resource-scoped provisioning
    /// token (allow-listed by IncidentLensReport.GetAdditionalProvisioningTokenPatterns); any human session — admins
    /// included — gets 404 (admins use {id}/photo). The hierarchical filter still runs for human callers (PUT verb).
    /// </summary>
    [HttpGet("{id}/agent-evidence")]
    [AccessControl(Verb = AccessVerbs.Put)]
    public Task<IActionResult> AgentEvidence(string workspaceId, string id, [FromQuery] string? part, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            if (string.IsNullOrEmpty(User.FindFirst("duplocloud.net/auth/allowed_paths")?.Value))
                throw new KeyNotFoundException("Not found.");
            var e = await _svc.AgentEvidenceAsync(workspaceId, id, part ?? "photo", ct);
            if (e == null) return NoContent();
            Response.Headers["Cache-Control"] = "private, no-store";
            return File(e.Value.Bytes, e.Value.ContentType);
        });

    // Scoped report agent only. Explicit POST: preparing a fresh ledger may incur Maps charges.
    [HttpPost("{id}/agent-maps")]
    [AccessControl(Verb = AccessVerbs.Put)]
    public Task<IActionResult> AgentMaps(string workspaceId, string id, [FromBody] AgentMapsRequest req, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            if (string.IsNullOrEmpty(User.FindFirst("duplocloud.net/auth/allowed_paths")?.Value))
                throw new KeyNotFoundException("Not found.");
            Response.Headers["Cache-Control"] = "private, no-store";
            return Guard.Ok(this, await _svc.AgentMapsAsync(workspaceId, id, req, ct));
        });

    [HttpPost("{id}/maps-runs")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> SetupMapsRun(string workspaceId, string id, [FromBody] MapsRunSetup req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.SetupMapsRunAsync(workspaceId, id, req, ct)));

    [HttpPost("{id}/maps-runs/{runId}/start")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> StartMapsRun(string workspaceId, string id, string runId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.StartMapsRunAsync(workspaceId, id, runId, ct)));

    [HttpPost("{id}/maps-runs/{runId}/claim")]
    [AccessControl(Verb = AccessVerbs.Put)]
    public Task<IActionResult> ClaimMapsRun(string workspaceId, string id, string runId, CancellationToken ct)
        => Guard.Run(this, async () => {
            if (string.IsNullOrEmpty(User.FindFirst("duplocloud.net/auth/allowed_paths")?.Value)) throw new KeyNotFoundException("Not found.");
            Response.Headers["Cache-Control"] = "private, no-store";
            return Guard.Ok(this, await _svc.ClaimMapsRunAsync(workspaceId, id, runId, ct));
        });

    [HttpPost("{id}/maps-runs/{runId}/agent")]
    [AccessControl(Verb = AccessVerbs.Put)]
    public Task<IActionResult> RunMapsAgent(string workspaceId, string id, string runId, [FromBody] AgentMapsRequest req, CancellationToken ct)
        => Guard.Run(this, async () => {
            if (string.IsNullOrEmpty(User.FindFirst("duplocloud.net/auth/allowed_paths")?.Value)) throw new KeyNotFoundException("Not found.");
            Response.Headers["Cache-Control"] = "private, no-store";
            return Guard.Ok(this, await _svc.AgentMapsAsync(workspaceId, id, req, ct, runId));
        });

    [HttpPut("vision-settings")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> VisionSettings(string workspaceId, [FromBody] IncidentLensReportService.VisionSettingsRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.SetVisionSettingsAsync(workspaceId, req, ct)));

    [HttpGet("{id}/candidates")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Candidates(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.CandidatesAsync(workspaceId, id, ct)));
}

// ── Incidents (+ the whole response workflow) ──────────────────────────────────────────────────────────
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/incidentlens-incidents")]
[AccessControl(Parent = typeof(IncidentLensCategory), ParentIdProperty = "OwnerWorkspaceId")]
public class IncidentLensIncidentsController : ResourcesController<IncidentLensIncident, IncidentLensIncidentSpec, IncidentLensIncidentResult>
{
    private readonly IncidentLensIncidentService _svc;

    public IncidentLensIncidentsController(IEntityService<IncidentLensIncident> service, IncidentLensIncidentService svc,
        ILogger<IncidentLensIncidentsController> logger) : base(service, logger) { _svc = svc; }

    public override Task<IActionResult> Create([FromBody] IncidentLensIncident resource, CancellationToken cancellationToken = default)
        => Task.FromResult(Guard.UseWorkflow(this, "Create incidents from reports with POST …/incidentlens-incidents/from-reports."));

    // control room — triage
    [HttpPost("from-reports")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage, ActionName = "Triage and dispatch",
        Description = "Group reports into incidents, set category and priority, dispatch and reassign response teams, allocate or cancel assistance requests, and edit grouping windows. Every decision is audited.")]
    public Task<IActionResult> FromReports(string workspaceId, [FromBody] CreateIncidentRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.CreateFromReportsAsync(workspaceId, req, ct)));

    [HttpPost("{id}/members")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Members(string workspaceId, string id, [FromBody] MembersRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.UpdateMembersAsync(workspaceId, id, req, ct)));

    [HttpPost("{id}/triage")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Triage(string workspaceId, string id, [FromBody] TriageRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.TriageAsync(workspaceId, id, req, ct)));

    [HttpPost("{id}/assignments")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Dispatch(string workspaceId, string id, [FromBody] DispatchRequest req, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var o = await _svc.DispatchAsync(workspaceId, id, req, ct);
            return Guard.Ok(this, new { assignment = o.Assignment, created = o.Created, warnings = o.Warnings });
        });

    [HttpPost("{id}/assignments/{aid}/cancel")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> CancelAssignment(string workspaceId, string id, string aid, [FromBody] ReasonRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.CancelAssignmentAsync(workspaceId, id, aid, req, ct)));

    [HttpPost("{id}/assignments/{aid}/reassign")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Reassign(string workspaceId, string id, string aid, [FromBody] DispatchRequest req, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var o = await _svc.ReassignAsync(workspaceId, id, aid, req, ct);
            return Guard.Ok(this, new { assignment = o.Assignment, created = o.Created, warnings = o.Warnings });
        });

    [HttpPost("{id}/assistance/{rid}/fulfill")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Fulfill(string workspaceId, string id, string rid, [FromBody] DispatchRequest req, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var o = await _svc.FulfillAssistanceAsync(workspaceId, id, rid, req, ct);
            return Guard.Ok(this, new { request = o.Request, assignment = o.Assignment, warnings = o.Warnings, created = o.Created });
        });

    [HttpPost("{id}/assistance/{rid}/cancel")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> CancelAssistance(string workspaceId, string id, string rid, [FromBody] ReasonRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.CancelAssistanceAsync(workspaceId, id, rid, req, ct)));

    [HttpPost("{id}/links")]
    [AccessControl(Action = Actions.Triage)]
    public Task<IActionResult> Link(string workspaceId, string id, [FromBody] LinkRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.LinkAsync(workspaceId, id, req, ct)));

    [HttpGet("{id}/triage-summary")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> TriageSummary(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.TriageSummaryAsync(workspaceId, id, ct)));

    [HttpGet("{id}/nearby-responders")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> NearbyResponders(string workspaceId, string id, [FromQuery] string? services, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.NearbyRespondersAsync(workspaceId, id, services, ct)));

    [HttpPost("{id}/assignments/{aid}/facility-state")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> FacilityState(string workspaceId, string id, string aid, [FromBody] FacilityStateRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.FacilityStateAsync(workspaceId, id, aid, req, ct)));

    [HttpPost("{id}/facility-verifications")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> VerifyFacility(string workspaceId, string id, [FromBody] FacilityVerificationRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.VerifyFacilityAsync(workspaceId, id, req, ct)));

    [HttpPost("facility-agencies")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> FacilityAgency(string workspaceId, [FromBody] FacilityAgencyRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.FacilityAgencyAsync(workspaceId, req, ct)));

    [HttpGet("alerts/control")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> ControlAlerts(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.ControlAlertsAsync(workspaceId, ct)));

    [HttpGet("alerts/responder")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond)]
    public Task<IActionResult> ResponderAlerts(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.ResponderAlertsAsync(workspaceId, ct)));

    [HttpGet("pulse")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> Pulse(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.PulseAsync(workspaceId, ct)));

    [HttpGet("grouping-policy")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> GetPolicy(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.GetSettingsAsync(workspaceId, ct)));

    [HttpPut("grouping-policy")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> PutPolicy(string workspaceId, [FromBody] GroupingPolicyRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.SetGroupingPolicyAsync(workspaceId, req, ct)));

    /// <summary>Oversight board — plain read (inherited GET verb).</summary>
    [HttpGet("{id}/board")]
    public Task<IActionResult> Board(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.BoardAsync(workspaceId, id, ct)));

    [HttpGet("{id}/assignments/{aid}/resolution-photo")]
    public Task<IActionResult> AdminResolutionPhoto(string workspaceId, string id, string aid, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Photo(this, await _svc.ResolutionPhotoAsync(workspaceId, aid, admin: true, ct)));

    // control room — closure
    [HttpPost("{id}/close")]
    [AccessControl(Action = Actions.Close, Destructive = true, ActionName = "Close and reopen incidents",
        Description = "Review resolution evidence and close an incident (or reopen it). A forced close cancels remaining assignments and assistance requests, each with an audited reason.")]
    public Task<IActionResult> Close(string workspaceId, string id, [FromBody] CloseRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.CloseAsync(workspaceId, id, req, ct)));

    [HttpPost("{id}/reopen")]
    [AccessControl(Action = Actions.Close)]
    public Task<IActionResult> Reopen(string workspaceId, string id, [FromBody] ReasonRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.ReopenAsync(workspaceId, id, req, ct)));

    // responders
    [HttpGet("assigned")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond, ActionName = "Respond to assigned incidents",
        Description = "See incidents where the caller is on an ACTIVE assignment (and the other teams' tasks/status there), update their team's status as lead, add notes, record resolution evidence, and request assistance. No access to other incidents or to reporter identities.")]
    public Task<IActionResult> Assigned(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.AssignedListAsync(workspaceId, ct)));

    [HttpGet("assigned/{id}")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> AssignedOne(string workspaceId, string id, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.ResponderViewAsync(workspaceId, id, ct)));

    [HttpGet("assigned/{id}/reports/{rid}/photo")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> AssignedPhoto(string workspaceId, string id, string rid, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Photo(this, await _svc.ResponderReportPhotoAsync(workspaceId, id, rid, ct)));

    [HttpPost("assigned/{id}/assignments/{aid}/state")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> State(string workspaceId, string id, string aid, [FromBody] StateRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.ChangeStateAsync(workspaceId, id, aid, req, ct)));

    [HttpPost("assigned/{id}/assignments/{aid}/notes")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> Note(string workspaceId, string id, string aid, [FromBody] NoteRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.AddNoteAsync(workspaceId, id, aid, req, ct)));

    [HttpPost("assigned/{id}/assignments/{aid}/complete")]
    [RequestSizeLimit(10 * 1024 * 1024)]
    [Consumes("multipart/form-data")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> Complete(string workspaceId, string id, string aid, [FromForm] IFormFile? photo, [FromForm] string? payload, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var req = Guard.Payload<CompleteRequest>(payload);
            var bytes = await Guard.ReadPhotoAsync(photo, false, ct);
            return Guard.Ok(this, await _svc.CompleteAsync(workspaceId, id, aid, req, bytes, ct));
        });

    [HttpPost("assigned/{id}/assistance")]
    [AccessControl(Action = Actions.Respond)]
    public Task<IActionResult> RequestAssistance(string workspaceId, string id, [FromBody] AssistanceCreateRequest req, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var o = await _svc.RequestAssistanceAsync(workspaceId, id, req, ct);
            return Guard.Ok(this, new { request = o.Request, assignment = o.Assignment, warnings = o.Warnings, created = o.Created });
        });

    [HttpGet("my-assignments")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond)]
    public Task<IActionResult> MyAssignments(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, await _svc.MyHistoryAsync(workspaceId, ct)));

    [HttpGet("my-assignments/{aid}/resolution-photo")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond)]
    public Task<IActionResult> MyResolutionPhoto(string workspaceId, string aid, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Photo(this, await _svc.ResolutionPhotoAsync(workspaceId, aid, admin: false, ct)));
}

// ── Assignments (child of an incident; reads + history for the control room) ───────────────────────────
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/incidentlens-incidents/{parentId}/incidentlens-assignments")]
[AccessControl(Parent = typeof(IncidentLensIncident), ParentIdProperty = "Spec.ParentId")]
public class IncidentLensAssignmentsController : ChildResourceController<IncidentLensAssignment, IncidentLensIncident, IncidentLensAssignmentSpec, IncidentLensAssignmentResult>
{
    public IncidentLensAssignmentsController(IEntityService<IncidentLensAssignment> service, IEntityService<IncidentLensIncident> parent,
        ILogger<IncidentLensAssignmentsController> logger) : base(service, parent, logger) { }

    public override Task<IActionResult> Create([FromBody] IncidentLensAssignment resource, CancellationToken cancellationToken = default)
        => Task.FromResult(Guard.UseWorkflow(this, "Dispatch with POST …/incidentlens-incidents/{id}/assignments."));
}

// ── Agencies ────────────────────────────────────────────────────────────────────────────────────────────
[ApiController]
[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/incidentlens-agencies")]
[AccessControl(Parent = typeof(IncidentLensCategory), ParentIdProperty = "OwnerWorkspaceId")]
public class IncidentLensAgenciesController : ResourcesController<IncidentLensAgency, IncidentLensAgencySpec, IncidentLensAgencyResult>
{
    private readonly IncidentLensAgencyService _svc;

    public IncidentLensAgenciesController(IEntityService<IncidentLensAgency> service, IncidentLensAgencyService svc,
        ILogger<IncidentLensAgenciesController> logger) : base(service, logger) { _svc = svc; }

    /// <summary>
    /// Responder-facing directory for the assistance picker: agencies, capabilities, roster names and busy COUNTS.
    /// Which incidents someone is busy on is never exposed here.
    /// </summary>
    [HttpGet("directory")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond)]
    public Task<IActionResult> Directory(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () =>
        {
            var outList = new List<object>();
            foreach (var a in await _svc.ListAsync(workspaceId, ct))
            {
                await _svc.FillAvailabilityAsync(a, includeIncidentIds: false, ct);
                outList.Add(new
                {
                    a.Id, a.Spec!.DisplayName, a.Spec.AgencyType, a.Spec.Capabilities, a.Spec.ContactRoute,
                    roster = a.Result!.Availability!.Select(m => new
                    {
                        m.Email, m.DisplayName, m.ActiveAssignmentCount, m.Busy,
                        leadEligible = a.Spec.Roster.First(r => r.Email == m.Email).LeadEligible,
                    }),
                });
            }
            return Guard.Ok(this, outList);
        });
}

[Route("v1/aiservicedesk/user/data/workspaces/{workspaceId}/environment/extensions/incidentlens-briefs")]
[AccessControl(Parent = typeof(IncidentLensCategory), ParentIdProperty = "OwnerWorkspaceId")]
public class IncidentLensBriefsController : ResourcesController<IncidentLensBrief, IncidentLensBriefSpec, IncidentLensBriefResult>
{
    private readonly IncidentLensBriefService _svc;

    public IncidentLensBriefsController(IEntityService<IncidentLensBrief> service, IncidentLensBriefService svc,
        ILogger<IncidentLensBriefsController> logger) : base(service, logger) { _svc = svc; }

    public override Task<IActionResult> Create([FromBody] IncidentLensBrief resource, CancellationToken cancellationToken = default)
        => Task.FromResult(Guard.UseWorkflow(this, "Create briefs with POST …/incidentlens-briefs/create."));

    // Briefs are open to every IncidentLens role. One endpoint per named action, so the platform authorises the create
    // through that action exactly like report submission (an endpoint cannot declare "any of three actions").
    [HttpPost("create/report")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Report)]
    public Task<IActionResult> CreateBriefAsReporter(string workspaceId, [FromBody] CreateBriefRequest req, CancellationToken ct) => CreateBrief(workspaceId, req, ct);

    [HttpPost("create/triage")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Triage)]
    public Task<IActionResult> CreateBriefAsControlRoom(string workspaceId, [FromBody] CreateBriefRequest req, CancellationToken ct) => CreateBrief(workspaceId, req, ct);

    [HttpPost("create/respond")]
    [AccessControl("workspaceId", AnchorNode = "Workspace", Action = Actions.Respond)]
    public Task<IActionResult> CreateBriefAsResponder(string workspaceId, [FromBody] CreateBriefRequest req, CancellationToken ct) => CreateBrief(workspaceId, req, ct);

    private Task<IActionResult> CreateBrief(string workspaceId, CreateBriefRequest req, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, IncidentLensBriefService.View(await _svc.CreateBriefAsync(workspaceId, req, ct))));

    [HttpGet("list")]
    [NoResourceAccessCheck(Reason = "Requires any IncidentLens role; enforced in IncidentLensBriefService.RequireAnyRoleAsync.")]
    public Task<IActionResult> ListBriefs(string workspaceId, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, (await _svc.ListAsync(workspaceId, ct)).Select(IncidentLensBriefService.View)));

    // Query parameter, not a {id} route segment: a segment makes the platform run a per-resource check that only
    // control-room grants pass; briefs are for every IncidentLens role (checked in the service).
    [HttpGet("view")]
    [NoResourceAccessCheck(Reason = "Requires any IncidentLens role; enforced in IncidentLensBriefService.RequireAnyRoleAsync.")]
    public Task<IActionResult> ViewBrief(string workspaceId, [FromQuery] string id, CancellationToken ct)
        => Guard.Run(this, async () => Guard.Ok(this, IncidentLensBriefService.View(await _svc.GetAsync(workspaceId, id, ct))));
}
