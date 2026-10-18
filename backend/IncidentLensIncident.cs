using System.Text.Json;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Duplo.Extension.IncidentLens;

// ── Incident: one real-world event, built from confirmed reports, answered by several agency assignments ───

[BsonIgnoreExtraElements]
public class IncidentLensIncidentSpec : BaseSpec
{
    public string Category { get; set; } = "other_uncertain";
    public string Priority { get; set; } = "P3";
    public string Jurisdiction { get; set; } = "";
    public List<string> MemberReportIds { get; set; } = new();
    public string? Summary { get; set; }
    public string? ClientRequestId { get; set; }
}

[BsonIgnoreExtraElements]
public class AssignmentSummary
{
    public string AssignmentId { get; set; } = "";
    public string AgencyId { get; set; } = "";
    public string AgencyName { get; set; } = "";
    public string AgencyType { get; set; } = "";
    public string LeadDisplayName { get; set; } = "";
    public int MemberCount { get; set; }
    public string Task { get; set; } = "";
    public string State { get; set; } = "";
    public DateTime? LastUpdatedAt { get; set; }
}

[BsonIgnoreExtraElements]
public class AssistanceRequest
{
    public string Id { get; set; } = "";
    public string? ClientRequestId { get; set; }
    public string RequestedByEmail { get; set; } = "";
    public string FromAssignmentId { get; set; } = "";
    public string? RequestedAgencyId { get; set; }
    public string? RequestedAgencyName { get; set; }
    public List<string> RequestedCapabilities { get; set; } = new();
    public int PersonnelCount { get; set; }
    public string Reason { get; set; } = "";
    /// <summary>pending (awaiting allocation — never shown as dispatched) | fulfilled | cancelled</summary>
    public string State { get; set; } = "pending";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ResolvedAt { get; set; }
    public string? ResolvedBy { get; set; }
    public string? ResultingAssignmentId { get; set; }
    public string? CancelReason { get; set; }
}

[BsonIgnoreExtraElements]
public class GroupingEntry
{
    public string? ClientRequestId { get; set; }
    public string? RequestFingerprint { get; set; }
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string ActorEmail { get; set; } = "";
    public string Action { get; set; } = "";
    public List<string> ReportIds { get; set; } = new();
    public string Reason { get; set; } = "";
}

[BsonIgnoreExtraElements]
public class IncidentLink
{
    public string LinkId { get; set; } = "";
    public string OtherIncidentId { get; set; } = "";
    public string Direction { get; set; } = "from";
    /// <summary>related | follow_up | duplicate_of — deliberately no causal vocabulary.</summary>
    public string Relationship { get; set; } = "related";
    public string Reason { get; set; } = "";
    public string Status { get; set; } = "suggested";
    public string ActorEmail { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public class IncidentLensIncidentResult : BaseResult
{
    /// <summary>Derived on every write: under_review · in_response · awaiting_allocation · needs_reassignment · response_complete · closed.</summary>
    public string ResponseState { get; set; } = "under_review";
    public bool Closed { get; set; }
    public DateTime? ClosedAt { get; set; }
    public string? ClosedBy { get; set; }
    public string? CloseReason { get; set; }
    public string? ReopenReason { get; set; }
    public double CentroidLat { get; set; }
    public double CentroidLng { get; set; }
    public DateTime? LastUpdatedAt { get; set; }
    public string? LastUpdatedBy { get; set; }
    public List<AssignmentSummary> AssignmentSummary { get; set; } = new();
    public List<AssistanceRequest> AssistanceRequests { get; set; } = new();
    public List<NotificationAttempt> Notifications { get; set; } = new();
    public List<AuditEntry> Audit { get; set; } = new();
    public List<GroupingEntry> GroupingHistory { get; set; } = new();
    public List<IncidentLink> Links { get; set; } = new();
}

[BsonCollection("extension_incidentlensincident")]
[BsonIgnoreExtraElements]
public class IncidentLensIncident : ResourceBase<IncidentLensIncidentSpec, IncidentLensIncidentResult>
{
    public override string GetTicketOriginType() => "IncidentLensIncident";
    public override string GetTicketOriginSubType() => "incidentlens-incident";
}

/// <summary>Membership, response state and the audit trail change only through the audited workflow.</summary>
public class IncidentLensIncidentHooks : DefaultEntityHooks<IncidentLensIncident>
{
    public override async Task OnPreUpdateAsync(IncidentLensIncident existing, IncidentLensIncident updated, CancellationToken ct = default)
    {
        await base.OnPreUpdateAsync(existing, updated, ct);
        if (TrustedWrite.Active) return;
        if (JsonSerializer.Serialize(existing.Spec?.MemberReportIds) != JsonSerializer.Serialize(updated.Spec?.MemberReportIds)
            || JsonSerializer.Serialize(existing.Result) != JsonSerializer.Serialize(updated.Result))
            throw new ArgumentException("Incident membership, response state and audit change only through IncidentLens actions.");
    }

    public override Task OnPreDeleteAsync(IncidentLensIncident entity, CancellationToken ct = default)
    {
        if (!TrustedWrite.Active) throw new ArgumentException("Incidents are retained; close them instead of deleting.");
        return base.OnPreDeleteAsync(entity, ct);
    }
}

// Request bodies ------------------------------------------------------------------------------------------
public record CreateIncidentRequest(List<string>? ReportIds, string? Category, string? Priority, string? Jurisdiction, string? Summary, string? Reason, string? ClientRequestId, string? TargetIncidentId = null);
public record MembersRequest(List<string>? Add, List<string>? Remove, string? Reason, long? ExpectedVersion);
public record TriageRequest(string? Category, string? Priority, string? Jurisdiction, string? Summary, string? Reason, long? ExpectedVersion);
public record DispatchRequest(string? AgencyId, List<string>? MemberEmails, string? LeadEmail, string? Task, string? Reason, int? SimulatedEtaMinutes, string? ClientRequestId, List<string>? RequestedCapabilities,
    int? RouteEtaMinutes = null, double? RouteDistanceKm = null, string? FacilityService = null,
    bool FacilityHumanConfirmed = false, bool FacilityContactConfirmed = false, bool FacilityAvailabilityConfirmed = false, string? FacilityContactNote = null, bool FacilityCapabilityConfirmed = false);
public record FacilityStateRequest(string? State, string? Note, long? ExpectedVersion);
public record FacilityAgencyRequest(string? PlaceId, string? Service, string? Name, string? Address, string? Phone, double Lat, double Lng, string? IncidentId = null);
public record ReasonRequest(string? Reason, long? ExpectedVersion);
public record StateRequest(string? State, long? ExpectedVersion);
public record NoteRequest(string? Text);
public record CompleteRequest(string? Note, long? ExpectedVersion);
public record AssistanceCreateRequest(string? FromAssignmentId, string? AgencyId, List<string>? Capabilities, int? PersonnelCount, string? Reason, List<string>? MemberEmails, string? LeadEmail, string? Task, string? ClientRequestId);
public record CloseRequest(string? Reason, bool Force, string? CancelReason, long? ExpectedVersion);
public record LinkRequest(string? OtherIncidentId, string? Relationship, string? Reason, string? Status);
public record GroupingPolicyRequest(List<GroupingWindow>? Windows);

/// <summary>
/// The whole response workflow lives here. Every mutation of an incident (and of its assignments) runs inside a
/// per-incident lock, checks the caller-supplied version where the plan requires it, appends audit, and recomputes
/// the derived response state before saving. Assignment creation is idempotent on clientRequestId / request id.
/// </summary>
public partial class IncidentLensIncidentService : ResourceServiceBase<IncidentLensIncident, IncidentLensIncidentSpec, IncidentLensIncidentResult>
{
    private readonly IRepository<IncidentLensIncident> _repo;
    private readonly IRepository<IncidentLensReport> _reports;
    private readonly IRepository<IncidentLensAssignment> _assignmentRepo;
    private readonly IEntityService<IncidentLensAssignment> _assignmentSvc;
    private readonly IRepository<IncidentLensAgency> _agencies;
    private readonly ICurrentUser _user;
    private readonly IMongoDatabase _db;
    private readonly IScopeCredentials _scopes;
    private readonly IWorkspaceService _workspaces;
    private readonly IEntityService<IncidentLensAgency> _agencySvc;

    public IncidentLensIncidentService(
        IRepository<IncidentLensIncident> repository,
        ILogger<IncidentLensIncidentService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IRepository<IncidentLensReport> reports,
        IRepository<IncidentLensAssignment> assignmentRepo,
        IEntityService<IncidentLensAssignment> assignmentSvc,
        IRepository<IncidentLensAgency> agencies,
        ICurrentUser user,
        IMongoDatabase db,
        IScopeCredentials scopes,
        IWorkspaceService workspaces,
        IEntityService<IncidentLensAgency> agencySvc)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _repo = repository; _reports = reports; _assignmentRepo = assignmentRepo; _assignmentSvc = assignmentSvc;
        _agencies = agencies; _user = user; _db = db; _scopes = scopes; _workspaces = workspaces; _agencySvc = agencySvc;
    }

    protected override bool IsProvisioningNeeded(IncidentLensIncident entity) => false;

    public override Task<IncidentLensIncident> DeprovisionAsync(string workspaceId, string resourceId, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Incidents have nothing to deprovision; close them instead.");

    private string Me() => _user.IsAuthenticated ? (_user.Email ?? "").Trim().ToLowerInvariant() : "";

    private static void CheckVersion(Duplo.Ai.Model.Entity e, long? expected, string what)
    {
        if (expected == null) throw new ArgumentException($"expectedVersion is required to change this {what}.");
        if (expected.Value != e.Version)
            throw new ConflictException($"This {what} changed since you loaded it (version {e.Version}, you sent {expected}). Reload and retry.",
                new { currentVersion = e.Version });
    }

    private static void CheckStateVersion(IncidentLensAssignment a, long? expected)
    {
        if (expected == null) throw new ArgumentException("expectedVersion (the assignment's stateVersion) is required.");
        if (expected.Value != a.Result!.StateVersion)
            throw new ConflictException($"This team's status changed since you loaded it (now {a.Result.State}). Reload and retry.",
                new { currentStateVersion = a.Result.StateVersion, currentState = a.Result.State });
    }

    private static string Required(string? s, string field, int max = 500)
    {
        if (string.IsNullOrWhiteSpace(s)) throw new ArgumentException($"{field} is required.");
        if (s.Length > max) throw new ArgumentException($"{field} must be {max} characters or fewer.");
        return s.Trim();
    }

    private async Task<IncidentLensIncident> LoadAsync(string ws, string id, CancellationToken ct)
    {
        var inc = await _repo.GetByIdAsync(id, ct);
        if (inc == null || inc.OwnerWorkspaceId != ws) throw new KeyNotFoundException("Incident not found.");
        inc.Result ??= new IncidentLensIncidentResult();
        return inc;
    }

    private async Task<List<IncidentLensAssignment>> AssignmentsOfAsync(string incidentId, CancellationToken ct)
        => (await _assignmentRepo.FindAsync(a => a.Spec!.ParentId == incidentId, ct)).OrderBy(a => a.CreatedAt).ToList();

    private void Audit(IncidentLensIncident inc, string action, string? target = null, string? from = null, string? to = null, string? reason = null, string? detail = null)
    {
        inc.Result!.Audit.Add(new AuditEntry { ActorEmail = Me(), Action = action, Target = target, FromState = from, ToState = to, Reason = reason, Detail = detail });
        inc.Result.LastUpdatedAt = DateTime.UtcNow;
        inc.Result.LastUpdatedBy = Me();
    }

    private static void Notify(IncidentLensIncident inc, string to, string detail)
        => inc.Result!.Notifications.Add(new NotificationAttempt { To = to, Detail = detail, State = "sent" });

    /// <summary>Recompute derived fields from the assignments, then persist (trusted).</summary>
    private async Task<IncidentLensIncident> SaveAsync(IncidentLensIncident inc, CancellationToken ct)
    {
        var assignments = await AssignmentsOfAsync(inc.Id, ct);
        var r = inc.Result!;
        r.AssignmentSummary = assignments.Select(a => new AssignmentSummary
        {
            AssignmentId = a.Id, AgencyId = a.Spec!.AgencyId, AgencyName = a.Spec.AgencyName, AgencyType = a.Spec.AgencyType,
            LeadDisplayName = a.Spec.Facility ? "facility (contact by phone)" : a.Spec.Members.FirstOrDefault(m => m.Email == a.Spec.LeadEmail)?.DisplayName ?? a.Spec.LeadEmail,
            MemberCount = a.Spec.Members.Count, Task = a.Spec.Task, State = a.Result?.State ?? Vocab.Requested,
            LastUpdatedAt = a.Result?.LastUpdatedAt,
        }).ToList();
        r.ResponseState = Derive(r, assignments);
        using (TrustedWrite.Begin())
            await _repo.UpdateAsync(inc.Id, inc, ct);
        return await _repo.GetByIdAsync(inc.Id, ct) ?? inc;
    }

    public static string Derive(IncidentLensIncidentResult r, IReadOnlyList<IncidentLensAssignment> assignments)
    {
        if (r.Closed) return "closed";
        var states = assignments.Select(a => a.Result?.State ?? Vocab.Requested).ToList();
        var pending = r.AssistanceRequests.Any(x => x.State == "pending");
        if (states.Any(s => Vocab.ActiveAssignmentStates.Contains(s))) return "in_response";
        if (pending) return "awaiting_allocation";
        if (states.Count == 0) return "under_review";
        return states.Any(s => s == Vocab.Completed) ? "response_complete" : "needs_reassignment";
    }

    // ── membership ──────────────────────────────────────────────────────────────────────────────────────
    public async Task<IncidentLensIncident> CreateFromReportsAsync(string ws, CreateIncidentRequest req, CancellationToken ct)
    {
        var ids = (req.ReportIds ?? new()).Distinct().ToList();
        if (ids.Count == 0) throw new ArgumentException("Select at least one report.");
        var category = req.Category ?? "other_uncertain";
        if (!Vocab.IsCategory(category)) throw new ArgumentException("Unknown category.");
        var priority = req.Priority ?? "P3";
        if (!Vocab.Priorities.Contains(priority)) throw new ArgumentException("priority must be P1–P4.");
        var reason = Required(req.Reason, "reason");
        var crid = Required(req.ClientRequestId, "clientRequestId", 80);

        using var lk = await KeyedLock.AcquireAsync($"incident-membership:{ws}", ct);
        var dup = (await _repo.FindAsync(i => i.OwnerWorkspaceId == ws && i.Spec!.ClientRequestId == crid, ct)).FirstOrDefault();
        if (dup != null)
        {
            if (req.TargetIncidentId != null || !dup.Spec!.MemberReportIds.OrderBy(x => x).SequenceEqual(ids.OrderBy(x => x)))
                throw new ConflictException("This request id was already used for a different group. Refresh before retrying.");
            await RepairMemberPointersAsync(ws, dup, ct);
            return dup;
        }
        var fingerprint = GroupingRequestIdentity.Fingerprint(req);
        var joined = (await _repo.FindAsync(i => i.OwnerWorkspaceId == ws && i.Result!.GroupingHistory.Any(h => h.ClientRequestId == crid), ct)).FirstOrDefault();
        if (joined != null)
        {
            var operation = joined.Result!.GroupingHistory.First(h => h.ClientRequestId == crid);
            if (operation.RequestFingerprint != fingerprint)
                throw new ConflictException("This request id was already used for a different grouping decision.");
            // Repair only CURRENT members. Never resurrect evidence removed after the original join.
            await RepairMemberPointersAsync(ws, joined, ct);
            return joined;
        }
        if (!string.IsNullOrWhiteSpace(req.TargetIncidentId))
        {
            var target = await LoadAsync(ws, req.TargetIncidentId, ct);
            if (target.Result!.Closed) throw new ConflictException("Reopen the incident before adding evidence.");
            var selected = new List<IncidentLensReport>();
            foreach (var rid in ids)
            {
                var report = await _reports.GetByIdAsync(rid, ct);
                if (report == null || report.OwnerWorkspaceId != ws) throw new KeyNotFoundException("Report not found.");
                if (!string.IsNullOrEmpty(report.Spec?.IncidentId) && report.Spec.IncidentId != target.Id)
                    throw new ConflictException("Selected evidence already belongs to another incident. Refresh before retrying.");
                selected.Add(report);
            }
            var existing = new List<IncidentLensReport>();
            foreach (var rid in target.Spec!.MemberReportIds)
                if (await _reports.GetByIdAsync(rid, ct) is { } report && report.OwnerWorkspaceId == ws) existing.Add(report);
            var windows = (await SettingsStore.GetAsync(_db, ws, ct)).GroupingWindows;
            if (!selected.All(r => target.Spec!.MemberReportIds.Contains(r.Id)) && !GroupingPolicy.Candidates(selected[0], existing, windows).Any(c => c.RecommendedForGrouping))
                throw new ConflictException("The existing incident no longer has a strong same-event match. Review the evidence again.");
            return await UpdateMembersCoreAsync(ws, target.Id, new MembersRequest(ids, null, reason, target.Version), ct,
                new GroupingEntry { ActorEmail = Me(), Action = "join_request", ReportIds = ids, Reason = reason, ClientRequestId = crid, RequestFingerprint = fingerprint });
        }
        var reports = new List<IncidentLensReport>();
        foreach (var id in ids)
        {
            var rep = await _reports.GetByIdAsync(id, ct);
            if (rep == null || rep.OwnerWorkspaceId != ws) throw new KeyNotFoundException($"Report {id} not found.");
            if (!string.IsNullOrEmpty(rep.Spec?.IncidentId))
                throw new ConflictException($"Report {rep.Name} already belongs to another incident — move it with the members action instead.");
            await EnsureNoOtherMembershipAsync(ws, rep.Id, null, ct);
            reports.Add(rep);
        }
        var inc = new IncidentLensIncident
        {
            Name = Ids.Name("inc"), OwnerWorkspaceId = ws,
            Spec = new IncidentLensIncidentSpec
            {
                Category = category, Priority = priority, Jurisdiction = Required(req.Jurisdiction, "jurisdiction", 120),
                MemberReportIds = ids, Summary = req.Summary?.Trim(), ClientRequestId = crid,
            },
            Result = new IncidentLensIncidentResult(),
        };
        Centroid(inc, reports);
        inc.Result.GroupingHistory.Add(new GroupingEntry { ActorEmail = Me(), Action = "create", ReportIds = ids, Reason = reason });
        Audit(inc, "incident.create", detail: $"{ids.Count} report(s)", reason: reason);
        IncidentLensIncident created;
        using (TrustedWrite.Begin())
            created = await CreateAsync(inc, ct);
        await SetReportIncidentAsync(reports, created.Id, ct);
        return created;
    }

    public async Task<IncidentLensIncident> UpdateMembersAsync(string ws, string id, MembersRequest req, CancellationToken ct)
    {
        using var membership = await KeyedLock.AcquireAsync($"incident-membership:{ws}", ct);
        return await UpdateMembersCoreAsync(ws, id, req, ct);
    }

    private async Task<IncidentLensIncident> UpdateMembersCoreAsync(string ws, string id, MembersRequest req, CancellationToken ct, GroupingEntry? operation = null)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        var membershipFingerprint = operation == null && req.ExpectedVersion != null ? GroupingRequestIdentity.Fingerprint(req) : null;
        if (membershipFingerprint != null && inc.Result!.GroupingHistory.Any(h => h.Action == "members_request" && h.RequestFingerprint == membershipFingerprint))
        {
            await RepairMemberPointersAsync(ws, inc, ct);
            await RepairRemovedPointersAsync(ws, inc, req.Remove ?? new(), ct);
            return inc;
        }
        CheckVersion(inc, req.ExpectedVersion, "incident");
        if (inc.Result!.Closed) throw new ConflictException("Reopen the incident before changing its reports.");
        var add = (req.Add ?? new()).Distinct().Where(x => !inc.Spec!.MemberReportIds.Contains(x)).ToList();
        var remove = (req.Remove ?? new()).Distinct().Where(x => inc.Spec!.MemberReportIds.Contains(x)).ToList();
        if (add.Count == 0 && remove.Count == 0 && operation == null) throw new ArgumentException("Nothing to add or remove.");
        if (inc.Spec!.MemberReportIds.Count + add.Count - remove.Count < 1)
            throw new ConflictException("An incident keeps at least one report. Close it instead.");

        var addReports = new List<IncidentLensReport>();
        foreach (var rid in add)
        {
            var rep = await _reports.GetByIdAsync(rid, ct);
            if (rep == null || rep.OwnerWorkspaceId != ws) throw new KeyNotFoundException($"Report {rid} not found.");
            if (!string.IsNullOrEmpty(rep.Spec?.IncidentId) && rep.Spec.IncidentId != id)
                throw new ConflictException($"Report {rep.Name} belongs to another incident. Remove it there first (a split), then add it here.");
            await EnsureNoOtherMembershipAsync(ws, rep.Id, id, ct);
            addReports.Add(rep);
        }
        if (operation != null) inc.Result.GroupingHistory.Add(operation);
        if (membershipFingerprint != null) inc.Result.GroupingHistory.Add(new GroupingEntry {
            ActorEmail = Me(), Action = "members_request", RequestFingerprint = membershipFingerprint,
            ReportIds = add.Concat(remove).Distinct().ToList(), Reason = reason
        });
        inc.Spec.MemberReportIds = inc.Spec.MemberReportIds.Except(remove).Concat(add).ToList();
        if (add.Count > 0) inc.Result.GroupingHistory.Add(new GroupingEntry { ActorEmail = Me(), Action = "add", ReportIds = add, Reason = reason });
        if (remove.Count > 0) inc.Result.GroupingHistory.Add(new GroupingEntry { ActorEmail = Me(), Action = "remove", ReportIds = remove, Reason = reason });
        Audit(inc, "incident.members", reason: reason, detail: $"+{add.Count} / -{remove.Count}");
        var members = new List<IncidentLensReport>();
        foreach (var rid in inc.Spec.MemberReportIds) if (await _reports.GetByIdAsync(rid, ct) is { } r) members.Add(r);
        Centroid(inc, members);
        var saved = await SaveAsync(inc, ct);
        await SetReportIncidentAsync(addReports, id, ct);
        var removed = new List<IncidentLensReport>();
        foreach (var rid in remove) if (await _reports.GetByIdAsync(rid, ct) is { } r) removed.Add(r);
        await SetReportIncidentAsync(removed, null, ct);
        if (operation != null) await RepairMemberPointersAsync(ws, saved, ct);
        return saved;
    }

    // Incident membership is authoritative even if a previous pointer write failed. This closes the
    // partial-write duplicate-creation hole; no existing record needs migration.
    private async Task EnsureNoOtherMembershipAsync(string ws, string reportId, string? allowedIncident, CancellationToken ct)
    {
        var owners = await _repo.FindAsync(i => i.OwnerWorkspaceId == ws && i.Spec!.MemberReportIds.Contains(reportId), ct);
        if (owners.Any(i => i.Id != allowedIncident))
            throw new ConflictException("Evidence is already attached to another incident. Refresh before grouping.");
    }

    private async Task RepairMemberPointersAsync(string ws, IncidentLensIncident inc, CancellationToken ct)
    {
        var repairs = new List<IncidentLensReport>();
        foreach (var rid in inc.Spec!.MemberReportIds)
        {
            var report = await _reports.GetByIdAsync(rid, ct);
            if (report == null || report.OwnerWorkspaceId != ws) throw new ConflictException("Incident evidence is unavailable; review membership.");
            await EnsureNoOtherMembershipAsync(ws, rid, inc.Id, ct);
            if (!string.IsNullOrEmpty(report.Spec?.IncidentId) && report.Spec.IncidentId != inc.Id)
                throw new ConflictException("Evidence membership changed; review it before retrying.");
            if (report.Spec?.IncidentId != inc.Id) repairs.Add(report);
        }
        await SetReportIncidentAsync(repairs, inc.Id, ct);
    }

    // A failed removal can leave an old pointer after authoritative membership was saved.
    // Reconcile only evidence still pointing here, absent from ALL incidents; later moves/re-adds win.
    private async Task RepairRemovedPointersAsync(string ws, IncidentLensIncident inc, IEnumerable<string> removedIds, CancellationToken ct)
    {
        var repairs = new List<IncidentLensReport>();
        foreach (var rid in removedIds.Distinct())
        {
            if (inc.Spec!.MemberReportIds.Contains(rid)) continue;
            var report = await _reports.GetByIdAsync(rid, ct);
            if (report == null || report.OwnerWorkspaceId != ws || report.Spec?.IncidentId != inc.Id) continue;
            var owners = await _repo.FindAsync(i => i.OwnerWorkspaceId == ws && i.Spec!.MemberReportIds.Contains(rid), ct);
            if (!owners.Any()) repairs.Add(report);
        }
        await SetReportIncidentAsync(repairs, null, ct);
    }

    private async Task SetReportIncidentAsync(IEnumerable<IncidentLensReport> reports, string? incidentId, CancellationToken ct)
    {
        using (TrustedWrite.Begin())
            foreach (var r in reports)
            {
                var fresh = await _reports.GetByIdAsync(r.Id, ct);
                if (fresh?.Spec == null) continue;
                fresh.Spec.IncidentId = incidentId;
                await _reports.UpdateAsync(fresh.Id, fresh, ct);
            }
    }

    private static void Centroid(IncidentLensIncident inc, IReadOnlyCollection<IncidentLensReport> reports)
    {
        if (reports.Count == 0) return;
        inc.Result!.CentroidLat = Math.Round(reports.Average(r => r.Spec!.Latitude), 6);
        inc.Result.CentroidLng = Math.Round(reports.Average(r => r.Spec!.Longitude), 6);
    }

    public async Task<IncidentLensIncident> TriageAsync(string ws, string id, TriageRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        CheckVersion(inc, req.ExpectedVersion, "incident");
        var changes = new List<string>();
        if (req.Category != null && req.Category != inc.Spec!.Category)
        {
            if (!Vocab.IsCategory(req.Category)) throw new ArgumentException("Unknown category.");
            changes.Add($"category {inc.Spec.Category}→{req.Category}"); inc.Spec.Category = req.Category;
        }
        if (req.Priority != null && req.Priority != inc.Spec!.Priority)
        {
            if (!Vocab.Priorities.Contains(req.Priority)) throw new ArgumentException("priority must be P1–P4.");
            changes.Add($"priority {inc.Spec.Priority}→{req.Priority}"); inc.Spec.Priority = req.Priority;
        }
        if (req.Jurisdiction != null && req.Jurisdiction != inc.Spec!.Jurisdiction) { changes.Add("jurisdiction"); inc.Spec.Jurisdiction = Required(req.Jurisdiction, "jurisdiction", 120); }
        if (req.Summary != null && req.Summary != inc.Spec!.Summary) { changes.Add("summary"); inc.Spec.Summary = req.Summary.Trim(); }
        if (changes.Count == 0) throw new ArgumentException("Nothing changed.");
        Audit(inc, "incident.triage", reason: reason, detail: string.Join("; ", changes));
        return await SaveAsync(inc, ct);
    }

    // ── dispatch / assignments ──────────────────────────────────────────────────────────────────────────
    public record DispatchOutcome(IncidentLensAssignment Assignment, bool Created, List<string> Warnings);

    public async Task<DispatchOutcome> DispatchAsync(string ws, string id, DispatchRequest req, CancellationToken ct)
    {
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        if (inc.Result!.Closed) throw new ConflictException("Reopen the incident before dispatching.");
        var outcome = await DispatchLockedAsync(ws, inc, req, "admin", ct);
        if (outcome.Created)
        {
            Audit(inc, "assignment.dispatch", target: outcome.Assignment.Id, to: Vocab.Requested, reason: req.Reason,
                detail: $"{outcome.Assignment.Spec!.AgencyName}: {string.Join(", ", outcome.Assignment.Spec.Members.Select(m => m.DisplayName))} (lead {outcome.Assignment.Spec.LeadEmail})");
            Notify(inc, $"{outcome.Assignment.Spec.AgencyName} lead {outcome.Assignment.Spec.LeadEmail}", $"New assignment: {outcome.Assignment.Spec.Task}");
            await SaveAsync(inc, ct);
        }
        return outcome;
    }

    /// <summary>Creates one assignment. Caller holds the incident lock. Idempotent on clientRequestId / requestedVia.</summary>
    private async Task<DispatchOutcome> DispatchLockedAsync(string ws, IncidentLensIncident inc, DispatchRequest req, string requestedVia, CancellationToken ct)
    {
        var crid = Required(req.ClientRequestId, "clientRequestId", 80);
        var existing = await AssignmentsOfAsync(inc.Id, ct);
        var same = existing.FirstOrDefault(a => a.Spec!.ClientRequestId == crid
                                                || (requestedVia != "admin" && a.Spec.RequestedVia == requestedVia));
        if (same != null) return new DispatchOutcome(same, false, new());
        var plan = await PlanDispatchAsync(ws, inc, req, existing, ignoreAssignmentId: null, ct);
        return new DispatchOutcome(await CreateFromPlanAsync(ws, inc, plan, crid, requestedVia, req, ct), true, plan.Warnings);
    }

    /// <summary>Everything a dispatch needs, fully validated, with NO writes (D3: validate before any mutation).</summary>
    private sealed record DispatchPlan(IncidentLensAgency Agency, bool Facility, List<string> Emails, string Lead,
        Dictionary<string, RosterMember> Roster, string Task, List<string> Warnings, FacilityRoute? Route, NearbyFacility? ScreenedCandidate = null);

    /// <summary>Route provenance taken from the SERVER's own nearby-facility lookup — never from the client.</summary>
    private sealed record FacilityRoute(string? Provider, int? DriveMinutes, double? DriveKm);

    private async Task<DispatchPlan> PlanDispatchAsync(string ws, IncidentLensIncident inc, DispatchRequest req,
        List<IncidentLensAssignment> existing, string? ignoreAssignmentId, CancellationToken ct)
    {
        var agency = await _agencies.GetByIdAsync(Required(req.AgencyId, "agencyId", 64), ct);
        if (agency == null || agency.OwnerWorkspaceId != ws) throw new KeyNotFoundException("Agency not found.");
        var facility = IncidentLensAgencyService.IsFacility(agency.Spec);
        var emails = (req.MemberEmails ?? new()).Select(e => e.Trim().ToLowerInvariant()).Distinct().ToList();
        var task = Required(req.Task, "task", 300);
        if (facility)
        {
            // A facility (nearby police station / hospital / fire station): no app users; the control room records its status.
            if (emails.Count > 0) throw new ArgumentException("A facility has no roster — dispatch it without members.");
            var service = req.FacilityService?.Trim() ?? "";
            if (!Corroboration.Services.Contains(service)) throw new ArgumentException("Select a screened service and confirm contact, capability and availability before assigning this facility.");
            var placeId = agency.Spec!.PlaceId ?? "";
            var candidate = await FacilityFromCacheAsync(ws, inc.Id, service, placeId, ct);
            FacilityPolicy.RequireDispatch(candidate, ws, inc.Id, placeId, service, DateTime.UtcNow, req);
            var route = new FacilityRoute(candidate!.DriveMinutes.HasValue ? "google_routes" : null, candidate.DriveMinutes, candidate.DriveKm);
            return new DispatchPlan(agency, true, emails, "", new(), task,
                new() { "Contact and availability were confirmed by the operator; IncidentLens sends no dispatch notification." }, route, candidate);
        }
        if (emails.Count == 0) throw new ArgumentException("Select at least one roster member — an assignment never covers the whole agency.");
        var roster = agency.Spec!.Roster.Where(m => m.Active).ToDictionary(m => m.Email);
        var unknown = emails.Where(e => !roster.ContainsKey(e)).ToList();
        if (unknown.Count > 0) throw new ArgumentException($"Not on {agency.Spec.DisplayName}'s active roster: {string.Join(", ", unknown)}.");
        var lead = (req.LeadEmail ?? "").Trim().ToLowerInvariant();
        if (!emails.Contains(lead)) throw new ArgumentException("The lead must be one of the selected members.");
        if (!roster[lead].LeadEligible) throw new ArgumentException($"{roster[lead].DisplayName} is not marked lead-eligible.");
        if (req.SimulatedEtaMinutes is < 0 or > 600) throw new ArgumentException("simulatedEtaMinutes must be 0–600.");

        // A person cannot be on two active teams for the same incident (the team being replaced does not count).
        var clash = existing.Where(a => a.Id != ignoreAssignmentId && Vocab.ActiveAssignmentStates.Contains(a.Result?.State ?? ""))
                            .SelectMany(a => a.Spec!.Members.Select(m => m.Email)).Intersect(emails).ToList();
        if (clash.Count > 0) throw new ConflictException($"Already on an active team for this incident: {string.Join(", ", clash)}.");

        // Busy elsewhere → a visible warning, not a block (the admin may still decide to send them).
        var warnings = new List<string>();
        var activeElsewhere = (await _assignmentRepo.FindAsync(a => a.OwnerWorkspaceId == ws && a.Spec!.ParentId != inc.Id, ct))
            .Where(a => Vocab.ActiveAssignmentStates.Contains(a.Result?.State ?? "")).ToList();
        foreach (var e in emails)
        {
            var n = activeElsewhere.Count(a => a.Spec!.Members.Any(m => m.Email == e));
            if (n > 0) warnings.Add($"{roster[e].DisplayName} is busy on {n} other active assignment(s).");
        }
        return new DispatchPlan(agency, false, emails, lead, roster, task, warnings, null);
    }

    private async Task<IncidentLensAssignment> CreateFromPlanAsync(string ws, IncidentLensIncident inc, DispatchPlan plan, string crid,
        string requestedVia, DispatchRequest req, CancellationToken ct, string? name = null)
    {
        var now = DateTime.UtcNow;
        var spec = new IncidentLensAssignmentSpec
        {
            ParentId = inc.Id, ClientRequestId = crid, AgencyId = plan.Agency.Id, AgencyName = plan.Agency.Spec!.DisplayName,
            AgencyType = plan.Agency.Spec.AgencyType, Task = plan.Task, RequestedByEmail = Me(), RequestedVia = requestedVia,
            Reason = req.Reason?.Trim(), RequestedCapabilities = req.RequestedCapabilities,
        };
        if (plan.Facility)
        {
            spec.Members = new(); spec.LeadEmail = ""; spec.Facility = true;
            spec.FacilityService = plan.ScreenedCandidate!.Service; spec.AgencyType = plan.ScreenedCandidate.Service;
            spec.FacilityScreeningPolicy = plan.ScreenedCandidate.ScreeningPolicy;
            spec.FacilityScreenedAt = plan.ScreenedCandidate.ScreenedAt;
            spec.FacilityScreeningTypes = plan.ScreenedCandidate.Types;
            spec.FacilityScreeningReasons = FacilityPolicy.Classify(plan.ScreenedCandidate).SuitabilityReasons;
            spec.FacilityContactNote = req.FacilityContactNote!.Trim(); spec.FacilityConfirmedAt = now; spec.FacilityConfirmedBy = Me();
            spec.RequestedCapabilities = new() { plan.ScreenedCandidate.Service };
            spec.FacilityProvider = plan.ScreenedCandidate.Provider;
            spec.RouteProvider = plan.Route?.Provider;              // google_routes | fixture | null (unknown)
            spec.RouteEtaMinutes = plan.Route?.DriveMinutes; spec.RouteDistanceKm = plan.Route?.DriveKm;
        }
        else
        {
            spec.Members = plan.Emails.Select(e => new AssignmentMember { Email = e, DisplayName = plan.Roster[e].DisplayName }).ToList();
            spec.LeadEmail = plan.Lead; spec.SimulatedEtaMinutes = req.SimulatedEtaMinutes;
        }
        var assignment = new IncidentLensAssignment
        {
            Name = name ?? Ids.Name("asg"), OwnerWorkspaceId = ws, Spec = spec,
            Result = new IncidentLensAssignmentResult
            {
                State = Vocab.Requested, LastUpdatedAt = now, LastUpdatedBy = Me(),
                StateHistory = new() { new StateChange { State = Vocab.Requested, At = now, ByEmail = Me() } },
            },
        };
        using (TrustedWrite.Begin())
            return await _assignmentSvc.CreateAsync(assignment, ct);
    }

    public async Task<IncidentLensAssignment> CancelAssignmentAsync(string ws, string id, string aid, ReasonRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        var a = await LoadAssignmentAsync(inc, aid, ct);
        CheckStateVersion(a, req.ExpectedVersion);
        if (!Vocab.ActiveAssignmentStates.Contains(a.Result!.State))
            throw new ConflictException($"Assignment is already {a.Result.State}.");
        var from = a.Result.State;
        await SetStateAsync(a, Vocab.Cancelled, reason, ct);
        Audit(inc, "assignment.cancel", target: a.Id, from: from, to: Vocab.Cancelled, reason: reason);
        Notify(inc, $"{a.Spec!.AgencyName} lead {a.Spec.LeadEmail}", "Assignment cancelled by the control room.");
        await SaveAsync(inc, ct);
        return (await _assignmentRepo.GetByIdAsync(a.Id, ct))!;
    }

    /// <summary>Reassign = cancel the current team (history kept) and dispatch a new one in a single audited step.</summary>
    /// <summary>
    /// Replace an assignment (D3). ALL validation of the replacement happens before any write; the writes then run through
    /// <see cref="ReassignmentSwap"/> (create replacement → cancel original → persist incident audit + summary) with
    /// compensation, so a rejected or failed reassignment leaves the original team, its members' access, the audit trail
    /// and the incident summary exactly as they were.
    /// </summary>
    public async Task<DispatchOutcome> ReassignAsync(string ws, string id, string aid, DispatchRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        var crid = Required(req.ClientRequestId, "clientRequestId", 80);
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        var old = await LoadAssignmentAsync(inc, aid, ct);
        var existing = await AssignmentsOfAsync(inc.Id, ct);
        var again = existing.FirstOrDefault(a => a.Spec!.ClientRequestId == crid);
        if (again != null) return new DispatchOutcome(again, false, new());
        if (inc.Result!.Closed) throw new ConflictException("Reopen the incident before reassigning.");
        var fixedReq = req with { AgencyId = req.AgencyId ?? old.Spec!.AgencyId };
        var plan = await PlanDispatchAsync(ws, inc, fixedReq, existing, ignoreAssignmentId: old.Id, ct);   // throws → nothing written

        var created = await ReassignmentSwap.RunAsync(new ReassignStore(this, ws, inc, old, plan, crid, reason, fixedReq, ct));
        return new DispatchOutcome(created, true, plan.Warnings);
    }

    /// <summary>
    /// Persistence for one reassignment (D3). Identity of the replacement is preallocated (fresh name + this request's
    /// unique clientRequestId, which the idempotency check proved unused), so a create whose response was lost is still
    /// found and withdrawn — and nothing pre-existing can match it. Snapshots are of the PERSISTED pre-swap state;
    /// restores read back and rewrite only when storage differs. Compensation ignores the request's cancellation token.
    /// </summary>
    private sealed class ReassignStore : IReassignmentStore<IncidentLensAssignment>
    {
        private readonly IncidentLensIncidentService _s; private readonly string _ws, _crid, _reason, _name, _fromState;
        private readonly IncidentLensIncident _inc; private readonly IncidentLensAssignment _old; private readonly DispatchPlan _plan;
        private readonly DispatchRequest _req; private readonly CancellationToken _ct; private readonly bool _wasActive;
        private readonly string _oldSnapshot, _incSnapshot;

        public ReassignStore(IncidentLensIncidentService s, string ws, IncidentLensIncident inc, IncidentLensAssignment old, DispatchPlan plan,
            string crid, string reason, DispatchRequest req, CancellationToken ct)
        {
            _s = s; _ws = ws; _inc = inc; _old = old; _plan = plan; _crid = crid; _reason = reason; _req = req; _ct = ct;
            _name = Ids.Name("asg");
            _wasActive = Vocab.ActiveAssignmentStates.Contains(old.Result!.State); _fromState = old.Result.State;
            _oldSnapshot = JsonSerializer.Serialize(old.Result);
            _incSnapshot = JsonSerializer.Serialize(inc.Result);
        }

        public Task<IncidentLensAssignment> CreateReplacementAsync() => _s.CreateFromPlanAsync(_ws, _inc, _plan, _crid, "admin", _req, _ct, _name);

        public Task CancelOriginalAsync() => _wasActive ? _s.SetStateAsync(_old, Vocab.Cancelled, $"Reassigned: {_reason}", _ct) : Task.CompletedTask;

        public async Task PersistIncidentAsync(IncidentLensAssignment r)
        {
            if (_wasActive) _s.Audit(_inc, "assignment.cancel", target: _old.Id, from: _fromState, to: Vocab.Cancelled, reason: $"Reassigned: {_reason}");
            _s.Audit(_inc, "assignment.reassign", target: r.Id, to: Vocab.Requested, reason: _reason, detail: $"replaces {_old.Id}");
            Notify(_inc, $"{r.Spec!.AgencyName} lead {r.Spec.LeadEmail}", $"New assignment: {r.Spec.Task}");
            await _s.SaveAsync(_inc, _ct);
        }

        public async Task<IncidentLensAssignment?> FindReplacementAsync()
            => (await _s._assignmentRepo.FindAsync(a => a.Spec!.ParentId == _inc.Id && a.Spec.ClientRequestId == _crid && a.Name == _name, CancellationToken.None))
               .FirstOrDefault();

        public async Task WithdrawReplacementAsync(IncidentLensAssignment r)
        {
            if (r.Name != _name || r.Spec?.ClientRequestId != _crid || r.Id == _old.Id) throw new InvalidOperationException("Refusing to withdraw a record this reassignment did not create.");
            using (TrustedWrite.Begin()) await _s._assignmentRepo.DeleteAsync(r.Id, CancellationToken.None);
        }

        public async Task RestoreOriginalAsync()
        {
            var cur = await _s._assignmentRepo.GetByIdAsync(_old.Id, CancellationToken.None) ?? throw new InvalidOperationException("Original assignment missing.");
            if (JsonSerializer.Serialize(cur.Result) == _oldSnapshot) return;
            cur.Result = JsonSerializer.Deserialize<IncidentLensAssignmentResult>(_oldSnapshot)!;
            using (TrustedWrite.Begin()) await _s._assignmentRepo.UpdateAsync(cur.Id, cur, CancellationToken.None);
            _old.Result = cur.Result;
        }

        public async Task RestoreIncidentAsync()
        {
            var cur = await _s._repo.GetByIdAsync(_inc.Id, CancellationToken.None) ?? throw new InvalidOperationException("Incident missing.");
            if (JsonSerializer.Serialize(cur.Result) != _incSnapshot)
            {
                cur.Result = JsonSerializer.Deserialize<IncidentLensIncidentResult>(_incSnapshot)!;
                using (TrustedWrite.Begin()) await _s._repo.UpdateAsync(cur.Id, cur, CancellationToken.None);
            }
            _inc.Result = JsonSerializer.Deserialize<IncidentLensIncidentResult>(_incSnapshot)!;   // drop unsaved in-memory audit too
        }
    }

    private async Task<IncidentLensAssignment> LoadAssignmentAsync(IncidentLensIncident inc, string aid, CancellationToken ct)
    {
        var a = await _assignmentRepo.GetByIdAsync(aid, ct);
        if (a == null || a.Spec?.ParentId != inc.Id) throw new KeyNotFoundException("Assignment not found on this incident.");
        a.Result ??= new IncidentLensAssignmentResult();
        return a;
    }

    private async Task SetStateAsync(IncidentLensAssignment a, string state, string? cancelReason, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        a.Result!.State = state;
        a.Result.StateVersion++;
        a.Result.LastUpdatedAt = now;
        a.Result.LastUpdatedBy = Me();
        a.Result.StateHistory.Add(new StateChange { State = state, At = now, ByEmail = Me() });
        if (state == Vocab.Cancelled) a.Result.CancelReason = cancelReason;
        using (TrustedWrite.Begin())
            await _assignmentRepo.UpdateAsync(a.Id, a, ct);
    }

    // ── responder actions ───────────────────────────────────────────────────────────────────────────────
    private static bool IsActiveMember(IncidentLensAssignment a, string email)
        => Vocab.ActiveAssignmentStates.Contains(a.Result?.State ?? "") && a.Spec!.Members.Any(m => m.Email == email);

    /// <summary>The caller's ACTIVE assignment on this incident, or a 404 (the incident is invisible otherwise).</summary>
    private async Task<(IncidentLensIncident Inc, List<IncidentLensAssignment> All, IncidentLensAssignment Mine)> RequireResponderAsync(string ws, string id, CancellationToken ct)
    {
        var me = Me();
        var inc = await LoadAsync(ws, id, ct);
        var all = await AssignmentsOfAsync(id, ct);
        var mine = all.FirstOrDefault(a => IsActiveMember(a, me));
        if (mine == null || string.IsNullOrEmpty(me)) throw new KeyNotFoundException("Incident not found.");
        return (inc, all, mine);
    }

    public async Task<IncidentLensAssignment> ChangeStateAsync(string ws, string id, string aid, StateRequest req, CancellationToken ct)
    {
        var target = Required(req.State, "state", 20);
        if (target == Vocab.Completed) throw new ArgumentException("Use the complete action (it records the resolution).");
        if (target == Vocab.Cancelled) throw new ArgumentException("Only the control room cancels assignments.");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var (inc, _, _) = await RequireResponderAsync(ws, id, ct);
        var a = await LoadAssignmentAsync(inc, aid, ct);
        if (!IsActiveMember(a, Me())) throw new KeyNotFoundException("Assignment not found.");
        if (a.Spec!.LeadEmail != Me()) throw new ForbiddenException("Only the team lead updates the team's status; members can add notes.");
        CheckStateVersion(a, req.ExpectedVersion);
        var from = a.Result!.State;
        if (!Vocab.AllowedNext[from].Contains(target))
            throw new ConflictException($"Cannot move from {from} to {target}.", new { allowed = Vocab.AllowedNext[from] });
        await SetStateAsync(a, target, null, ct);
        Audit(inc, "assignment.state", target: a.Id, from: from, to: target);
        await SaveAsync(inc, ct);
        return (await _assignmentRepo.GetByIdAsync(a.Id, ct))!;
    }

    /// <summary>
    /// Control room records a FACILITY assignment's status (the facility has no app users; e.g. after a phone call).
    /// Same transition table as teams; completing requires a note, stored as the resolution.
    /// </summary>
    public async Task<IncidentLensAssignment> FacilityStateAsync(string ws, string id, string aid, FacilityStateRequest req, CancellationToken ct)
    {
        var target = Required(req.State, "state", 20);
        if (target == Vocab.Cancelled) throw new ArgumentException("Use cancel (it needs a reason).");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        if (inc.Result!.Closed) throw new ConflictException("The incident is closed.");
        var a = await LoadAssignmentAsync(inc, aid, ct);
        if (!a.Spec!.Facility) throw new ForbiddenException("Only facility assignments are updated by the control room; teams update their own status.");
        CheckStateVersion(a, req.ExpectedVersion);
        var from = a.Result!.State;
        if (!Vocab.AllowedNext[from].Contains(target))
            throw new ConflictException($"Cannot move from {from} to {target}.", new { allowed = Vocab.AllowedNext[from] });
        if (target == Vocab.Completed)
            a.Result.Resolution = new ResolutionEvidence { Note = Required(req.Note, "note", 1000), SubmittedAt = DateTime.UtcNow, ByEmail = Me() };
        else if (!string.IsNullOrWhiteSpace(req.Note))
            a.Result.Notes.Add(new AssignmentNote { At = DateTime.UtcNow, ByEmail = Me(), Text = req.Note.Trim()[..Math.Min(1000, req.Note.Trim().Length)] });
        await SetStateAsync(a, target, null, ct);
        Audit(inc, "assignment.facility_state", target: a.Id, from: from, to: target, detail: "recorded by control room for a facility");
        await SaveAsync(inc, ct);
        return (await _assignmentRepo.GetByIdAsync(a.Id, ct))!;
    }

    public async Task<IncidentLensAssignment> AddNoteAsync(string ws, string id, string aid, NoteRequest req, CancellationToken ct)
    {
        var text = Required(req.Text, "text", 1000);
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var (inc, _, _) = await RequireResponderAsync(ws, id, ct);
        var a = await LoadAssignmentAsync(inc, aid, ct);
        if (!IsActiveMember(a, Me())) throw new ForbiddenException("Only members of this team can add notes to it.");
        a.Result!.Notes.Add(new AssignmentNote { ByEmail = Me(), Text = text });
        a.Result.LastUpdatedAt = DateTime.UtcNow;
        a.Result.LastUpdatedBy = Me();
        using (TrustedWrite.Begin())
            await _assignmentRepo.UpdateAsync(a.Id, a, ct);
        Audit(inc, "assignment.note", target: a.Id);
        await SaveAsync(inc, ct);
        return (await _assignmentRepo.GetByIdAsync(a.Id, ct))!;
    }

    /// <summary>Lead completes the team's assignment, recording private resolution evidence. Never closes the incident.</summary>
    public async Task<IncidentLensAssignment> CompleteAsync(string ws, string id, string aid, CompleteRequest req, byte[]? photo, CancellationToken ct)
    {
        var note = Required(req.Note, "resolution note", 1000);
        if (photo is { Length: > 0 })
        {
            if (photo.Length > EvidenceStore.MaxBytes) throw new ArgumentException("Photo is larger than 8 MB.");
            if (!EvidenceStore.LooksLikeJpeg(photo)) throw new ArgumentException("Resolution photo must be a camera JPEG.");
        }
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var (inc, _, _) = await RequireResponderAsync(ws, id, ct);
        var a = await LoadAssignmentAsync(inc, aid, ct);
        if (!IsActiveMember(a, Me())) throw new KeyNotFoundException("Assignment not found.");
        if (a.Spec!.LeadEmail != Me()) throw new ForbiddenException("Only the team lead completes the assignment.");
        CheckStateVersion(a, req.ExpectedVersion);
        if (!Vocab.AllowedNext[a.Result!.State].Contains(Vocab.Completed))
            throw new ConflictException($"Cannot complete from {a.Result.State}; the team must be on scene first.", new { allowed = Vocab.AllowedNext[a.Result.State] });
        string? fileId = null;
        if (photo is { Length: > 0 })
        {
            fileId = $"resolution/{ws}/{inc.Id}/{a.Id}.jpg";
            await EvidenceStore.PutAsync(_db, fileId, photo, "image/jpeg", ct);
        }
        a.Result.Resolution = new ResolutionEvidence { Note = note, PhotoFileId = fileId, SubmittedAt = DateTime.UtcNow, ByEmail = Me() };
        var from = a.Result.State;
        await SetStateAsync(a, Vocab.Completed, null, ct);
        Audit(inc, "assignment.complete", target: a.Id, from: from, to: Vocab.Completed, detail: fileId != null ? "resolution photo attached" : "no photo");
        Notify(inc, "control-room", $"{a.Spec.AgencyName} completed: closure review needed when all teams are done.");
        await SaveAsync(inc, ct);
        return (await _assignmentRepo.GetByIdAsync(a.Id, ct))!;
    }

    // ── assistance requests ─────────────────────────────────────────────────────────────────────────────
    public record AssistanceOutcome(AssistanceRequest Request, IncidentLensAssignment? Assignment, List<string> Warnings, bool Created);

    /// <summary>
    /// A responder asks for help WITHOUT admin approval (a human decision, never an AI dispatch). With concrete
    /// users selected the assignment is created immediately (receiving lead must acknowledge); agency-only requests
    /// stay "awaiting allocation" for the control room.
    /// </summary>
    public async Task<AssistanceOutcome> RequestAssistanceAsync(string ws, string id, AssistanceCreateRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        var crid = Required(req.ClientRequestId, "clientRequestId", 80);
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var (inc, all, mine) = await RequireResponderAsync(ws, id, ct);
        var from = all.FirstOrDefault(a => a.Id == req.FromAssignmentId) ?? mine;
        if (!IsActiveMember(from, Me())) throw new ForbiddenException("Request assistance from your own active assignment.");
        if (inc.Result!.Closed) throw new ConflictException("The incident is closed.");

        var replay = inc.Result.AssistanceRequests.FirstOrDefault(x => x.ClientRequestId == crid);
        if (replay != null)
        {
            var asg = replay.ResultingAssignmentId != null ? await _assignmentRepo.GetByIdAsync(replay.ResultingAssignmentId, ct) : null;
            return new AssistanceOutcome(replay, asg, new(), false);
        }
        var caps = (req.Capabilities ?? new()).Select(c => c.Trim()).Where(c => c.Length > 0).Distinct().ToList();
        IncidentLensAgency? agency = null;
        if (!string.IsNullOrEmpty(req.AgencyId))
        {
            agency = await _agencies.GetByIdAsync(req.AgencyId, ct);
            if (agency == null || agency.OwnerWorkspaceId != ws) throw new KeyNotFoundException("Agency not found.");
        }
        if (agency == null && caps.Count == 0) throw new ArgumentException("Name an agency or at least one capability.");

        // Duplicate active request: same team asking for the same agency (or the same capability set) again.
        var dupe = inc.Result.AssistanceRequests.FirstOrDefault(x => x.State == "pending" && x.FromAssignmentId == from.Id
            && (agency != null ? x.RequestedAgencyId == agency.Id : x.RequestedAgencyId == null && x.RequestedCapabilities.OrderBy(c => c).SequenceEqual(caps.OrderBy(c => c))));
        if (dupe != null) throw new ConflictException("Your team already has a pending request for this help.", new { requestId = dupe.Id });

        var request = new AssistanceRequest
        {
            Id = "ar-" + Ids.Short(8), ClientRequestId = crid, RequestedByEmail = Me(), FromAssignmentId = from.Id,
            RequestedAgencyId = agency?.Id, RequestedAgencyName = agency?.Spec?.DisplayName, RequestedCapabilities = caps,
            PersonnelCount = Math.Clamp(req.PersonnelCount ?? (req.MemberEmails?.Count ?? 1), 1, 50), Reason = reason,
        };
        IncidentLensAssignment? created = null;
        var warnings = new List<string>();
        var concrete = agency != null && (req.MemberEmails?.Count ?? 0) > 0;
        if (concrete)
        {
            var outcome = await DispatchLockedAsync(ws, inc, new DispatchRequest(agency!.Id, req.MemberEmails, req.LeadEmail,
                req.Task ?? $"Assist {from.Spec!.AgencyName}: {reason}", reason, null, crid, caps), $"assistance_request:{request.Id}", ct);
            created = outcome.Assignment; warnings = outcome.Warnings;
            request.State = "fulfilled"; request.ResolvedAt = DateTime.UtcNow; request.ResolvedBy = Me();
            request.ResultingAssignmentId = created.Id;
        }
        inc.Result.AssistanceRequests.Add(request);
        Audit(inc, concrete ? "assistance.request_dispatched" : "assistance.request_pending", target: request.Id, reason: reason,
            detail: concrete ? $"→ {created!.Spec!.AgencyName}: {string.Join(", ", created.Spec.Members.Select(m => m.DisplayName))}"
                             : $"awaiting allocation: {agency?.Spec?.DisplayName ?? string.Join(", ", caps)}");
        Notify(inc, "control-room", concrete
            ? $"{Me()} dispatched {created!.Spec!.AgencyName} directly (no approval needed); receiving lead must acknowledge."
            : $"{Me()} requested help — awaiting allocation.");
        if (created != null) Notify(inc, $"{created.Spec!.AgencyName} lead {created.Spec.LeadEmail}", $"Assistance requested: {created.Spec.Task}");
        await SaveAsync(inc, ct);
        return new AssistanceOutcome(request, created, warnings, true);
    }

    /// <summary>Control room allocates a pending (agency-only) request. Idempotent: a second call returns the same assignment.</summary>
    public async Task<AssistanceOutcome> FulfillAssistanceAsync(string ws, string id, string rid, DispatchRequest req, CancellationToken ct)
    {
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        var request = inc.Result!.AssistanceRequests.FirstOrDefault(x => x.Id == rid) ?? throw new KeyNotFoundException("Request not found.");
        if (request.State == "fulfilled")
            return new AssistanceOutcome(request, request.ResultingAssignmentId != null ? await _assignmentRepo.GetByIdAsync(request.ResultingAssignmentId, ct) : null, new(), false);
        if (request.State == "cancelled") throw new ConflictException("This request was cancelled.");
        var outcome = await DispatchLockedAsync(ws, inc, req with { AgencyId = req.AgencyId ?? request.RequestedAgencyId,
            RequestedCapabilities = request.RequestedCapabilities, Reason = req.Reason ?? request.Reason }, $"assistance_request:{rid}", ct);
        request.State = "fulfilled"; request.ResolvedAt = DateTime.UtcNow; request.ResolvedBy = Me();
        request.ResultingAssignmentId = outcome.Assignment.Id;
        Audit(inc, "assistance.fulfil", target: rid, detail: $"→ {outcome.Assignment.Spec!.AgencyName}");
        Notify(inc, $"{outcome.Assignment.Spec.AgencyName} lead {outcome.Assignment.Spec.LeadEmail}", $"Assistance assignment: {outcome.Assignment.Spec.Task}");
        await SaveAsync(inc, ct);
        return new AssistanceOutcome(request, outcome.Assignment, outcome.Warnings, outcome.Created);
    }

    public async Task<IncidentLensIncident> CancelAssistanceAsync(string ws, string id, string rid, ReasonRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        var request = inc.Result!.AssistanceRequests.FirstOrDefault(x => x.Id == rid) ?? throw new KeyNotFoundException("Request not found.");
        if (request.State != "pending") throw new ConflictException($"Request is already {request.State}.");
        request.State = "cancelled"; request.CancelReason = reason; request.ResolvedAt = DateTime.UtcNow; request.ResolvedBy = Me();
        Audit(inc, "assistance.cancel", target: rid, reason: reason);
        return await SaveAsync(inc, ct);
    }

    // ── closure ─────────────────────────────────────────────────────────────────────────────────────────
    public async Task<IncidentLensIncident> CloseAsync(string ws, string id, CloseRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        CheckVersion(inc, req.ExpectedVersion, "incident");
        if (inc.Result!.Closed) throw new ConflictException("Incident is already closed.");
        var all = await AssignmentsOfAsync(id, ct);
        var active = all.Where(a => Vocab.ActiveAssignmentStates.Contains(a.Result?.State ?? "")).ToList();
        var pending = inc.Result.AssistanceRequests.Where(x => x.State == "pending").ToList();
        if ((active.Count > 0 || pending.Count > 0) && !req.Force)
            throw new ConflictException("Active work remains. Wait for the teams, or confirm a forced close that cancels them.",
                new
                {
                    activeAssignments = active.Select(a => new { a.Id, a.Spec!.AgencyName, state = a.Result!.State }),
                    pendingRequests = pending.Select(p => new { p.Id, p.RequestedAgencyName, p.RequestedCapabilities }),
                });
        if (req.Force && (active.Count > 0 || pending.Count > 0))
        {
            var cancelReason = Required(req.CancelReason, "cancelReason");
            foreach (var a in active)
            {
                var from = a.Result!.State;
                await SetStateAsync(a, Vocab.Cancelled, $"Incident closed: {cancelReason}", ct);
                Audit(inc, "assignment.cancel_on_close", target: a.Id, from: from, to: Vocab.Cancelled, reason: cancelReason);
                Notify(inc, $"{a.Spec!.AgencyName} lead {a.Spec.LeadEmail}", "Assignment cancelled: incident closed by the control room.");
            }
            foreach (var p in pending)
            {
                p.State = "cancelled"; p.CancelReason = $"Incident closed: {cancelReason}"; p.ResolvedAt = DateTime.UtcNow; p.ResolvedBy = Me();
                Audit(inc, "assistance.cancel_on_close", target: p.Id, reason: cancelReason);
            }
        }
        var prev = inc.Result.ResponseState;
        inc.Result.Closed = true; inc.Result.ClosedAt = DateTime.UtcNow; inc.Result.ClosedBy = Me(); inc.Result.CloseReason = reason;
        Audit(inc, req.Force ? "incident.close_forced" : "incident.close", from: prev, to: "closed", reason: reason);
        return await SaveAsync(inc, ct);
    }

    public async Task<IncidentLensIncident> ReopenAsync(string ws, string id, ReasonRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        using var lk = await KeyedLock.AcquireAsync($"incident:{id}", ct);
        var inc = await LoadAsync(ws, id, ct);
        CheckVersion(inc, req.ExpectedVersion, "incident");
        if (!inc.Result!.Closed) throw new ConflictException("Incident is not closed.");
        inc.Result.Closed = false; inc.Result.ReopenReason = reason;
        Audit(inc, "incident.reopen", from: "closed", reason: reason);
        return await SaveAsync(inc, ct);
    }

    // ── links between separate incidents (minimal; never causal) ───────────────────────────────────────
    public async Task<IncidentLensIncident> LinkAsync(string ws, string id, LinkRequest req, CancellationToken ct)
    {
        var reason = Required(req.Reason, "reason");
        var other = Required(req.OtherIncidentId, "otherIncidentId", 64);
        var rel = req.Relationship ?? "related";
        if (!new[] { "related", "follow_up", "duplicate_of" }.Contains(rel)) throw new ArgumentException("relationship must be related, follow_up or duplicate_of.");
        var status = req.Status ?? "confirmed";
        if (!new[] { "suggested", "confirmed", "rejected" }.Contains(status)) throw new ArgumentException("status must be suggested, confirmed or rejected.");
        if (other == id) throw new ArgumentException("An incident cannot link to itself.");
        // Lock both incidents in a stable order to avoid deadlocks.
        var keys = new[] { id, other }.OrderBy(x => x, StringComparer.Ordinal).ToArray();
        using var l1 = await KeyedLock.AcquireAsync($"incident:{keys[0]}", ct);
        using var l2 = await KeyedLock.AcquireAsync($"incident:{keys[1]}", ct);
        var a = await LoadAsync(ws, id, ct);
        var b = await LoadAsync(ws, other, ct);
        var linkId = a.Result!.Links.FirstOrDefault(l => l.OtherIncidentId == other)?.LinkId ?? "lk-" + Ids.Short(8);
        Upsert(a, new IncidentLink { LinkId = linkId, OtherIncidentId = other, Direction = "from", Relationship = rel, Reason = reason, Status = status, ActorEmail = Me() });
        Upsert(b, new IncidentLink { LinkId = linkId, OtherIncidentId = id, Direction = "to", Relationship = rel, Reason = reason, Status = status, ActorEmail = Me() });
        Audit(a, "link." + status, target: other, reason: reason, detail: rel);
        Audit(b, "link." + status, target: id, reason: reason, detail: rel);
        await SaveAsync(b, ct);
        return await SaveAsync(a, ct);

        static void Upsert(IncidentLensIncident inc, IncidentLink link)
        {
            inc.Result!.Links.RemoveAll(l => l.LinkId == link.LinkId);
            inc.Result.Links.Add(link);
        }
    }

    // ── reads & projections ─────────────────────────────────────────────────────────────────────────────
    public async Task<List<IncidentLensIncident>> ListAsync(string ws, CancellationToken ct)
        => (await _repo.FindAsync(i => i.OwnerWorkspaceId == ws, ct)).OrderByDescending(i => i.CreatedAt).ToList();

    /// <summary>Admin oversight board: the incident, every assignment (incl. private resolution metadata), member reports.</summary>
    public async Task<object> BoardAsync(string ws, string id, CancellationToken ct)
    {
        var inc = await LoadAsync(ws, id, ct);
        var assignments = await AssignmentsOfAsync(id, ct);
        var reports = new List<object>();
        foreach (var rid in inc.Spec!.MemberReportIds)
            if (await _reports.GetByIdAsync(rid, ct) is { } r) { IncidentLensReportService.Derive(r); reports.Add(ReportSummary(r, includeOwner: true)); }
        return new { incident = inc, assignments, reports };
    }

    /// <summary>
    /// What an assigned responder may see: this incident, every participating team's task/status, the reports'
    /// evidence summaries — but no reporter identity, no other incidents, and no other team's resolution photo.
    /// </summary>
    public async Task<object> ResponderViewAsync(string ws, string id, CancellationToken ct)
    {
        var (inc, all, mine) = await RequireResponderAsync(ws, id, ct);
        var me = Me();
        var reports = new List<object>();
        foreach (var rid in inc.Spec!.MemberReportIds)
            if (await _reports.GetByIdAsync(rid, ct) is { } r) { IncidentLensReportService.Derive(r); reports.Add(ReportSummary(r, includeOwner: false)); }
        var r0 = inc.Result!;
        return new
        {
            incident = new
            {
                inc.Id, inc.Name, inc.Version, inc.CreatedAt, category = inc.Spec.Category, priority = inc.Spec.Priority,
                jurisdiction = inc.Spec.Jurisdiction, summary = inc.Spec.Summary, responseState = r0.ResponseState,
                centroidLat = r0.CentroidLat, centroidLng = r0.CentroidLng, lastUpdatedAt = r0.LastUpdatedAt,
            },
            myAssignmentId = mine.Id,
            teams = all.Select(a => new
            {
                a.Id, a.Version, stateVersion = a.Result!.StateVersion, a.Spec!.AgencyName, a.Spec.AgencyType, a.Spec.Task, a.Spec.LeadEmail,
                lead = a.Spec.Members.FirstOrDefault(m => m.Email == a.Spec.LeadEmail)?.DisplayName,
                members = a.Spec.Members.Select(m => m.DisplayName), a.Spec.RequestedVia,
                simulatedEtaMinutes = a.Spec.SimulatedEtaMinutes,
                state = a.Result.State, a.Result.LastUpdatedAt, lastUpdatedBy = DisplayOf(all, a.Result.LastUpdatedBy),
                stateHistory = a.Result.StateHistory.Select(s => new { s.State, s.At, by = DisplayOf(all, s.ByEmail) }),
                isMine = a.Spec.Members.Any(m => m.Email == me), iAmLead = a.Spec.LeadEmail == me,
                notes = a.Spec.Members.Any(m => m.Email == me) ? a.Result.Notes.Select(n => new { n.At, by = DisplayOf(all, n.ByEmail), n.Text }) : null,
                resolutionSubmitted = a.Result.Resolution != null,
                resolution = a.Spec.Members.Any(m => m.Email == me) && a.Result.Resolution != null
                    ? new { a.Result.Resolution.Note, a.Result.Resolution.SubmittedAt, hasPhoto = a.Result.Resolution.PhotoFileId != null } : null,
            }),
            assistanceRequests = r0.AssistanceRequests.Select(x => new
            {
                x.Id, x.State, x.RequestedAgencyName, x.RequestedCapabilities, x.PersonnelCount, x.Reason, x.CreatedAt,
                requestedBy = DisplayOf(all, x.RequestedByEmail), x.ResultingAssignmentId,
                display = x.State == "pending" ? "Awaiting allocation" : x.State == "fulfilled" ? "Dispatched" : "Cancelled",
            }),
            reports,
        };
    }

    private static string DisplayOf(IEnumerable<IncidentLensAssignment> all, string? email)
        => string.IsNullOrEmpty(email) ? "" : all.SelectMany(a => a.Spec!.Members).FirstOrDefault(m => m.Email == email)?.DisplayName ?? "Control room";

    private static object ReportSummary(IncidentLensReport r, bool includeOwner) => new
    {
        r.Id, r.Name, receivedAt = r.Spec!.ReceivedAt, latitude = r.Spec.Latitude, longitude = r.Spec.Longitude,
        locationSource = r.Spec.LocationSource, gpsAccuracyM = r.Spec.GpsAccuracyM, categoryHint = r.Spec.CategoryHint,
        note = r.Spec.Note, processingState = r.Result?.ProcessingState,
        assessment = r.Result?.Assessment == null ? null : new
        {
            r.Result.Assessment.SuggestedCategory, r.Result.Assessment.Observations, r.Result.Assessment.Uncertainty,
            r.Result.Assessment.UrgencyHint, r.Result.Assessment.QualityFlags,
        },
        visionProvider = r.Result?.Vision?.Provider,
        captureSource = r.Spec.CaptureSource,
        seenOnlinePages = r.Result?.Vision?.Web?.PagesWithMatches ?? 0,
        reporterEmail = includeOwner ? r.Spec.ReporterEmail : null,
    };

    public async Task<List<object>> AssignedListAsync(string ws, CancellationToken ct)
    {
        var me = Me();
        var mine = (await _assignmentRepo.FindAsync(a => a.OwnerWorkspaceId == ws, ct)).Where(a => IsActiveMember(a, me)).ToList();
        var outList = new List<object>();
        foreach (var g in mine.GroupBy(a => a.Spec!.ParentId))
        {
            var inc = await _repo.GetByIdAsync(g.Key!, ct);
            if (inc == null) continue;
            var a = g.First();
            outList.Add(new
            {
                incidentId = inc.Id, inc.Name, category = inc.Spec!.Category, priority = inc.Spec.Priority,
                jurisdiction = inc.Spec.Jurisdiction, responseState = inc.Result?.ResponseState,
                centroidLat = inc.Result?.CentroidLat, centroidLng = inc.Result?.CentroidLng,
                myAssignmentId = a.Id, agencyName = a.Spec!.AgencyName, task = a.Spec.Task, state = a.Result!.State,
                iAmLead = a.Spec.LeadEmail == me, lastUpdatedAt = a.Result.LastUpdatedAt,
                teams = inc.Result?.AssignmentSummary.Count ?? 0,
            });
        }
        return outList;
    }

    /// <summary>The caller's own assignments incl. completed ones (their resolution stays readable to them).</summary>
    public async Task<List<object>> MyHistoryAsync(string ws, CancellationToken ct)
    {
        var me = Me();
        var rows = (await _assignmentRepo.FindAsync(a => a.OwnerWorkspaceId == ws, ct))
            .Where(a => a.Spec!.Members.Any(m => m.Email == me) && a.Result?.State != Vocab.Cancelled)
            .OrderByDescending(a => a.CreatedAt).ToList();
        return rows.Select(a => (object)new
        {
            a.Id, incidentId = a.Spec!.ParentId, a.Spec.AgencyName, a.Spec.Task, state = a.Result!.State, a.Result.LastUpdatedAt,
            resolution = a.Result.Resolution == null ? null : new { a.Result.Resolution.Note, a.Result.Resolution.SubmittedAt, hasPhoto = a.Result.Resolution.PhotoFileId != null },
        }).ToList();
    }

    public async Task<(byte[] Bytes, string ContentType)?> ResponderReportPhotoAsync(string ws, string id, string rid, CancellationToken ct)
    {
        var (inc, _, _) = await RequireResponderAsync(ws, id, ct);
        if (!inc.Spec!.MemberReportIds.Contains(rid)) throw new KeyNotFoundException("Report not found.");
        var r = await _reports.GetByIdAsync(rid, ct);
        return r?.Spec?.PhotoFileId == null ? null : await EvidenceStore.GetAsync(_db, r.Spec.PhotoFileId, ct);
    }

    /// <summary>Resolution photo: admins, or members of THAT assignment (even after completion/closure).</summary>
    public async Task<(byte[] Bytes, string ContentType)?> ResolutionPhotoAsync(string ws, string aid, bool admin, CancellationToken ct)
    {
        var a = await _assignmentRepo.GetByIdAsync(aid, ct);
        if (a == null || a.OwnerWorkspaceId != ws) throw new KeyNotFoundException("Assignment not found.");
        if (!admin && !a.Spec!.Members.Any(m => m.Email == Me())) throw new KeyNotFoundException("Assignment not found.");
        var f = a.Result?.Resolution?.PhotoFileId;
        return f == null ? null : await EvidenceStore.GetAsync(_db, f, ct);
    }

    public async Task<IncidentLensSettings> GetSettingsAsync(string ws, CancellationToken ct) => await SettingsStore.GetAsync(_db, ws, ct);

    /// <summary>AI triage + corroboration for one incident (advisory; a human decides).</summary>
    public async Task<object> TriageSummaryAsync(string ws, string id, CancellationToken ct)
    {
        var inc = await LoadAsync(ws, id, ct);
        var members = (await _reports.FindAsync(r => r.OwnerWorkspaceId == ws && r.Spec!.IncidentId == inc.Id, ct)).ToList();
        var c = Corroboration.Compute(members);
        var (prio, why) = Corroboration.SuggestPriority(members);
        return new
        {
            corroboration = new { level = c.Level, score = c.Score, reasons = c.Reasons, cautions = c.Cautions, independentReporters = c.IndependentReporters },
            services = Corroboration.SuggestServices(members, inc.Spec?.Category),
            suggestedPriority = prio, priorityReason = why,
            centroid = new { lat = members.Count > 0 ? members.Average(r => r.Spec!.Latitude) : inc.Result?.CentroidLat ?? 0,
                             lng = members.Count > 0 ? members.Average(r => r.Spec!.Longitude) : inc.Result?.CentroidLng ?? 0 },
        };
    }

    /// <summary>
    /// Nearest real facilities per service (Places API (New) + Routes API drive time), cached 30 min per incident+service.
    /// The Maps server key is read from the "google-maps-server" scope and never leaves the server.
    /// </summary>
    public async Task<object> NearbyRespondersAsync(string ws, string id, string? servicesCsv, CancellationToken ct)
    {
        var inc = await LoadAsync(ws, id, ct);
        var members = (await _reports.FindAsync(r => r.OwnerWorkspaceId == ws && r.Spec!.IncidentId == inc.Id, ct)).ToList();
        double lat = members.Count > 0 ? members.Average(r => r.Spec!.Latitude) : inc.Result?.CentroidLat ?? 0;
        double lng = members.Count > 0 ? members.Average(r => r.Spec!.Longitude) : inc.Result?.CentroidLng ?? 0;
        if (!Geo.ValidLatLng(lat, lng)) throw new ArgumentException("This incident has no location yet.");
        var services = (servicesCsv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => Corroboration.Services.Contains(x)).Distinct().Take(5).ToList();
        if (services.Count == 0) services = Corroboration.SuggestServices(members, inc.Spec?.Category)
            .Select(v => v.Service).ToList();
        var settings = await SettingsStore.GetAsync(_db, ws, ct);
        // Select metadata within this authorized workspace BEFORE decrypting any credential.
        var attached = await _workspaces.GetScopesInWorkspaceAsync(ws, ct);
        var mapsId = MapsScopeSelection.Select(attached, settings.MapsScopeId);
        string? key = null;
        var reportIds = members.Select(r => r.Id).ToList();
        var agentLedgers = await _db.GetCollection<ReportMapsLedger>(ReportMapsPolicy.Collection)
            .Find(l => l.WorkspaceId == ws && reportIds.Contains(l.ReportId) && l.ScopeId == mapsId).ToListAsync(ct);
        var cache = _db.GetCollection<MongoDB.Bson.BsonDocument>("extension_incidentlensfacilitycache");
        var result = new List<object>();
        foreach (var svc in services)
        {
            var cacheId = $"{ws}:{FacilityPolicy.Version}:{inc.Id}:{svc}:{Math.Round(lat, 4)}:{Math.Round(lng, 4)}:{mapsId}:live";
            var hit = await cache.Find(MongoDB.Driver.Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id", cacheId)).FirstOrDefaultAsync(ct);
            List<NearbyFacility> list;
            var agentSource = agentLedgers.OrderByDescending(l => l.RetrievedAt).FirstOrDefault(l =>
                members.Any(r => r.Id == l.ReportId && ReportMapsPolicy.CanUseForIncident(l, r, svc, lat, lng, DateTime.UtcNow)));
            if (agentSource != null)
            {
                // The same-ticket selection wins, including an intentionally empty shortlist. Do not broaden it.
                list = ReportMapsPolicy.Selected(agentSource, svc, inc.Id);
                await cache.ReplaceOneAsync(MongoDB.Driver.Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id", cacheId),
                    new MongoDB.Bson.BsonDocument { ["_id"] = cacheId, ["workspaceId"] = ws, ["incidentId"] = inc.Id,
                        ["service"] = svc, ["policyVersion"] = FacilityPolicy.Version, ["at"] = agentSource.RetrievedAt,
                        ["agentRunId"] = agentSource.RunId, ["agentReportId"] = agentSource.ReportId,
                        ["json"] = JsonSerializer.Serialize(list) }, new ReplaceOptions { IsUpsert = true }, ct);
            }
            else if (hit != null && CacheMatches(hit, ws, inc.Id, svc)
                && !hit.Contains("agentRunId"))
                list = JsonSerializer.Deserialize<List<NearbyFacility>>(hit["json"].AsString) ?? new();
            else
            {
                if (key == null)
                {
                    var resolved = (await _scopes.ResolveAsync(new[] { mapsId }, ct)).SingleOrDefault();
                    if (resolved?.Scope?.Id != mapsId || resolved.Scope.Name != MapsScopeSelection.Name)
                        throw new ArgumentException("The selected Maps scope could not be resolved. Check its provider credential.");
                    key = MapsScopeSelection.RequireKey(resolved.Data);
                }
                list = (await GooglePlaces.NearbyAsync(key, svc, lat, lng, 3, ct)).Select(f => f with {
                    WorkspaceId = ws, IncidentId = inc.Id, ScreenedAt = DateTime.UtcNow, ScreeningPolicy = FacilityPolicy.Version }).ToList();
                await cache.ReplaceOneAsync(MongoDB.Driver.Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id", cacheId),
                    new MongoDB.Bson.BsonDocument { ["_id"] = cacheId, ["workspaceId"] = ws, ["incidentId"] = inc.Id, ["service"] = svc, ["policyVersion"] = FacilityPolicy.Version, ["at"] = DateTime.UtcNow, ["json"] = JsonSerializer.Serialize(list) },
                    new ReplaceOptions { IsUpsert = true }, ct);
            }
            var shortlist = FacilityPolicy.ScreenedShortlist(list);
            var facilities = shortlist.Select(f => new { f.PlaceId, f.Name, f.Address, f.Phone, f.Lat, f.Lng, f.StraightLineKm,
                f.DriveMinutes, f.DriveKm, f.MapsUri, f.Provider, f.PrimaryType, f.Types, f.SuitabilityReasons,
                screening = f.ScreeningOrigin, agentReason = f.AgentReason, capability = "unconfirmed", availability = "unconfirmed" }).ToList();
            var withheld = list.Where(f => !shortlist.Any(s => s.PlaceId == f.PlaceId)).Select(FacilityPolicy.Classify)
                .Select(f => new { f.Name, reasons = f.Suitability == "candidate" ? new[] { "Outside the top three relevant listings." } : f.SuitabilityReasons }).ToList();
            result.Add(new { service = svc, facilities, withheldCount = withheld.Count, withheld, policyVersion = FacilityPolicy.Version });
        }
        return new { provider = "google_places", incident = new { lat, lng }, services = result };
    }

    /// <summary>
    /// Create/reuse a directory entry only from a workspace/service-specific screened candidate. Listing details come
    /// from this incident's fresh policy-versioned cache; the client's display fields are never authoritative.
    /// </summary>
    public async Task<IncidentLensAgency> FacilityAgencyAsync(string ws, FacilityAgencyRequest req, CancellationToken ct)
    {
        var placeId = Required(req.PlaceId, "placeId", 300);
        var service = Required(req.Service, "service", 40);
        if (!Corroboration.Services.Contains(service)) throw new ArgumentException("Unknown service.");
        using var lk = await KeyedLock.AcquireAsync($"facility:{ws}:{placeId}", ct);
        var incidentId = Required(req.IncidentId, "incidentId", 64);
        await LoadAsync(ws, incidentId, ct);
        var known = await FacilityFromCacheAsync(ws, incidentId, service, placeId, ct)
            ?? throw new ArgumentException("Refresh this incident's candidates before creating a facility entry.");
        if (known.Provider != "google_places" || FacilityPolicy.Classify(known).Suitability != "candidate")
            throw new ArgumentException("Only a current backend-screened listing can be selected for assignment.");
        var existing = (await _agencies.FindAsync(a => a.OwnerWorkspaceId == ws && a.Spec!.PlaceId == placeId, ct)).FirstOrDefault();
        if (existing != null) return existing;
        if (known.Provider != "google_places" || FacilityPolicy.Classify(known).Suitability == "not_suitable")
            throw new ArgumentException("A current usable Places candidate is required.");
        var provenance = known.Provider;
        double lat = known.Lat, lng = known.Lng;
        if (!Geo.ValidLatLng(lat, lng)) throw new ArgumentException("Invalid facility location.");
        var agency = new IncidentLensAgency
        {
            Name = Ids.Name("fac"), OwnerWorkspaceId = ws,
            Spec = new IncidentLensAgencySpec
            {
                AgencyType = service, DisplayName = known.Name, Capabilities = new(),
                CoverageCenterLat = lat, CoverageCenterLng = lng, CoverageRadiusKm = 15, ContactRoute = "phone (manual)",
                Roster = new(), IntegrationStatus = "directory_only", Source = "facility", Provenance = provenance, PlaceId = placeId,
                Address = known.Address?.Trim(), Phone = known.Phone?.Trim(),
            },
        };
        using (TrustedWrite.Begin())
            return await _agencySvc.CreateAsync(agency, ct);
    }

    private static bool CacheMatches(MongoDB.Bson.BsonDocument d, string ws, string incident, string service)
        => d.TryGetValue("workspaceId", out var w) && d.TryGetValue("incidentId", out var i)
           && d.TryGetValue("service", out var s) && d.TryGetValue("policyVersion", out var p) && d.TryGetValue("at", out var at)
           && FacilityPolicy.FreshCache(w.AsString, i.AsString, s.AsString, p.AsString, at.ToUniversalTime(), ws, incident, service, DateTime.UtcNow);

    private async Task<NearbyFacility?> FacilityFromCacheAsync(string ws, string incident, string service, string placeId, CancellationToken ct)
    {
        var cache = _db.GetCollection<MongoDB.Bson.BsonDocument>("extension_incidentlensfacilitycache");
        var f = MongoDB.Driver.Builders<MongoDB.Bson.BsonDocument>.Filter;
        var docs = await cache.Find(f.Eq("workspaceId", ws) & f.Eq("incidentId", incident) & f.Eq("service", service)
            & f.Eq("policyVersion", FacilityPolicy.Version) & f.Gt("at", DateTime.UtcNow - FacilityPolicy.CacheLifetime)).ToListAsync(ct);
        foreach (var doc in docs.Where(d => CacheMatches(d, ws, incident, service)).OrderByDescending(d => d["at"].ToUniversalTime()))
        {
            if (doc.Contains("agentRunId"))
            {
                var members = (await _reports.FindAsync(r => r.OwnerWorkspaceId == ws && r.Spec!.IncidentId == incident, ct)).ToList();
                var report = members.FirstOrDefault(r => r.Id == doc["agentReportId"].AsString);
                var ledger = await _db.GetCollection<ReportMapsLedger>(ReportMapsPolicy.Collection)
                    .Find(l => l.WorkspaceId == ws && l.RunId == doc["agentRunId"].AsString).FirstOrDefaultAsync(ct);
                if (report == null || ledger == null || !ReportMapsPolicy.CanUseForIncident(ledger, report, service,
                    members.Average(r => r.Spec!.Latitude), members.Average(r => r.Spec!.Longitude), DateTime.UtcNow)) continue;
                // Reconstruct from the authoritative ledger; cached display data never authorizes a new selection.
                return ReportMapsPolicy.Selected(ledger, service, incident).FirstOrDefault(f => f.PlaceId == placeId);
            }
            var candidate = (JsonSerializer.Deserialize<List<NearbyFacility>>(doc["json"].AsString) ?? new())
                .FirstOrDefault(x => x.PlaceId == placeId && x.Service == service);
            if (candidate != null) return candidate;
        }
        return null;
    }

    private async Task<FacilityVerification?> VerificationAsync(string ws, string place, string service, CancellationToken ct)
    {
        var rows = await _db.GetCollection<FacilityVerification>("extension_incidentlensfacilityverification")
            .Find(v => v.WorkspaceId == ws && v.PlaceId == place && v.Service == service && v.PolicyVersion == FacilityPolicy.Version).ToListAsync(ct);
        return rows.Where(v => FacilityPolicy.Current(v, ws, place, service, DateTime.UtcNow)).OrderByDescending(v => v.ReviewedAt).FirstOrDefault();
    }

    public async Task<FacilityVerification> VerifyFacilityAsync(string ws, string incident, FacilityVerificationRequest req, CancellationToken ct)
    {
        await LoadAsync(ws, incident, ct);
        var service = Required(req.Service, "service", 40); var place = Required(req.PlaceId, "placeId", 300);
        if (!Corroboration.Services.Contains(service)) throw new ArgumentException("Unknown service.");
        var candidate = await FacilityFromCacheAsync(ws, incident, service, place, ct)
            ?? throw new ArgumentException("Refresh this incident's candidates before recording evidence.");
        var record = FacilityPolicy.Review(candidate, req, ws, Me(), DateTime.UtcNow);
        await _db.GetCollection<FacilityVerification>("extension_incidentlensfacilityverification").InsertOneAsync(record, cancellationToken: ct);
        return record;
    }

    /// <summary>
    /// Live "Pulse" map data (control room): every open incident with its centroid, spread radius, member-report times and
    /// positions, distinct-reporter count and grouping window, plus reports not yet grouped. No reporter identities.
    /// </summary>
    public async Task<object> PulseAsync(string ws, CancellationToken ct)
    {
        var settings = await SettingsStore.GetAsync(_db, ws, ct);
        var open = (await _repo.FindAsync(i => i.OwnerWorkspaceId == ws, ct)).Where(i => i.Result?.Closed != true).ToList();
        var reports = (await _reports.FindAsync(r => r.OwnerWorkspaceId == ws, ct)).Where(r => r.Spec != null).ToList();
        var byIncident = reports.Where(r => !string.IsNullOrEmpty(r.Spec!.IncidentId)).GroupBy(r => r.Spec!.IncidentId!).ToDictionary(g => g.Key, g => g.ToList());
        var incidents = open.Select(i =>
        {
            var members = byIncident.TryGetValue(i.Id, out var m) ? m : new List<IncidentLensReport>();
            double lat = members.Count > 0 ? members.Average(r => r.Spec!.Latitude) : i.Result?.CentroidLat ?? 0;
            double lng = members.Count > 0 ? members.Average(r => r.Spec!.Longitude) : i.Result?.CentroidLng ?? 0;
            var spread = members.Count > 0 ? members.Max(r => Geo.DistanceM(lat, lng, r.Spec!.Latitude, r.Spec.Longitude)) : 0;
            var window = GroupingPolicy.WindowFor(settings.GroupingWindows, i.Spec?.Category);
            return new
            {
                i.Id, i.Name, category = i.Spec?.Category, priority = i.Spec?.Priority, jurisdiction = i.Spec?.Jurisdiction,
                summary = i.Spec?.Summary, responseState = i.Result?.ResponseState, createdAt = i.CreatedAt,
                centroidLat = lat, centroidLng = lng, radiusM = Math.Round(Math.Max(60, spread + 25)),
                reports = members.OrderBy(r => r.Spec!.ReceivedAt).Select(r => new { r.Id, receivedAt = r.Spec!.ReceivedAt, lat = r.Spec.Latitude, lng = r.Spec.Longitude }),
                reportCount = members.Count,
                independentReporters = members.Select(r => r.Spec!.ReporterEmail).Where(e => !string.IsNullOrEmpty(e)).Distinct().Count(),
                lastReportAt = members.Count > 0 ? members.Max(r => r.Spec!.ReceivedAt) : (DateTime?)null,
                windowMinutes = window.MaxMinutes,
                teams = i.Result?.AssignmentSummary.Count ?? 0,
            };
        }).OrderByDescending(x => x.lastReportAt).ToList();
        var ungrouped = reports.Where(r => string.IsNullOrEmpty(r.Spec!.IncidentId)).OrderByDescending(r => r.Spec!.ReceivedAt).Take(200)
            .Select(r => new { r.Id, r.Name, receivedAt = r.Spec!.ReceivedAt, lat = r.Spec.Latitude, lng = r.Spec.Longitude,
                               category = GroupingPolicy.CategoryOf(r) });
        return new { now = DateTime.UtcNow, incidents, ungrouped };
    }

    public async Task<IncidentLensSettings> SetGroupingPolicyAsync(string ws, GroupingPolicyRequest req, CancellationToken ct)
    {
        var windows = req.Windows ?? throw new ArgumentException("windows is required.");
        GroupingPolicy.Validate(windows);
        var s = await SettingsStore.GetAsync(_db, ws, ct);
        foreach (var w in windows)
        {
            s.GroupingWindows.RemoveAll(x => x.Category == w.Category);
            s.GroupingWindows.Add(w);
        }
        s.UpdatedAt = DateTime.UtcNow; s.UpdatedBy = Me();
        await SettingsStore.SaveAsync(_db, s, ct);
        return s;
    }
}
