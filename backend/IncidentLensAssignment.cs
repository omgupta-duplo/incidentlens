using System.Text.Json;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.IncidentLens;

// ── Assignment: selected users of ONE agency, with a lead and a task, for ONE incident ─────────────────────

[BsonIgnoreExtraElements]
public class AssignmentMember
{
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
}

[BsonIgnoreExtraElements]
public class IncidentLensAssignmentSpec : ParentRefSpec<IncidentLensIncident>
{
    public string? ClientRequestId { get; set; }
    public string AgencyId { get; set; } = "";
    public string AgencyName { get; set; } = "";
    public string AgencyType { get; set; } = "";
    public List<AssignmentMember> Members { get; set; } = new();
    public string LeadEmail { get; set; } = "";
    public string Task { get; set; } = "";
    public string RequestedByEmail { get; set; } = "";
    /// <summary>"admin" or "assistance_request:&lt;requestId&gt;".</summary>
    public string RequestedVia { get; set; } = "admin";
    public string? Reason { get; set; }
    public List<string>? RequestedCapabilities { get; set; }
    /// <summary>SIMULATED for demos only — never computed from location; every view labels it "simulated".</summary>
    public int? SimulatedEtaMinutes { get; set; }
    /// <summary>Facility assignment (agency source google_places): no app users; the control room records its status.</summary>
    public bool Facility { get; set; }
    /// <summary>Where the facility came from: google_places | fixture | unknown (legacy rows without a record).</summary>
    public string? FacilityProvider { get; set; }
    public string? FacilityService { get; set; }
    public string? FacilityVerificationId { get; set; }
    public string? FacilityScreeningPolicy { get; set; }
    public DateTime? FacilityScreenedAt { get; set; }
    public string[]? FacilityScreeningTypes { get; set; }
    public string[]? FacilityScreeningReasons { get; set; }
    public string? FacilityContactNote { get; set; }
    public DateTime? FacilityConfirmedAt { get; set; }
    public string? FacilityConfirmedBy { get; set; }
    /// <summary>Where the drive time came from: google_routes | fixture (simulated) | null = unknown. Server-derived only.</summary>
    public string? RouteProvider { get; set; }
    /// <summary>Drive time at dispatch from the server's own nearby lookup (see RouteProvider; never live tracking).</summary>
    public int? RouteEtaMinutes { get; set; }
    public double? RouteDistanceKm { get; set; }
}

[BsonIgnoreExtraElements]
public class StateChange
{
    public string State { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string ByEmail { get; set; } = "";
}

[BsonIgnoreExtraElements]
public class AssignmentNote
{
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string ByEmail { get; set; } = "";
    public string Text { get; set; } = "";
}

[BsonIgnoreExtraElements]
public class ResolutionEvidence
{
    public string Note { get; set; } = "";
    public string? PhotoFileId { get; set; }
    public DateTime SubmittedAt { get; set; }
    public string ByEmail { get; set; } = "";
}

[BsonIgnoreExtraElements]
public class IncidentLensAssignmentResult : BaseResult
{
    public string State { get; set; } = Vocab.Requested;
    /// <summary>
    /// Concurrency token for STATUS changes only (state/complete/cancel compare against it). Notes don't bump it, so
    /// a member adding a note never makes the lead's status update fail.
    /// </summary>
    public long StateVersion { get; set; }
    public List<StateChange> StateHistory { get; set; } = new();
    public DateTime? LastUpdatedAt { get; set; }
    public string? LastUpdatedBy { get; set; }
    public List<AssignmentNote> Notes { get; set; } = new();
    public string? CancelReason { get; set; }
    /// <summary>Private: readable by admins and this assignment's members only — retained after completion/closure.</summary>
    public ResolutionEvidence? Resolution { get; set; }
}

[BsonCollection("extension_incidentlensassignment")]
[BsonIgnoreExtraElements]
public class IncidentLensAssignment : ResourceBase<IncidentLensAssignmentSpec, IncidentLensAssignmentResult>
{
    public override string GetTicketOriginType() => "IncidentLensAssignment";
    public override string GetTicketOriginSubType() => "incidentlens-assignment";
}

/// <summary>Members, lead, state and history change only through the audited workflow (dispatch / state / reassign).</summary>
public class IncidentLensAssignmentHooks : DefaultEntityHooks<IncidentLensAssignment>
{
    public override async Task OnPreUpdateAsync(IncidentLensAssignment existing, IncidentLensAssignment updated, CancellationToken ct = default)
    {
        await base.OnPreUpdateAsync(existing, updated, ct);
        if (TrustedWrite.Active) return;
        if (Spec(existing) != Spec(updated) || JsonSerializer.Serialize(existing.Result) != JsonSerializer.Serialize(updated.Result))
            throw new ArgumentException("Assignments change only through dispatch, state, notes, reassign and cancel actions.");
    }

    public override Task OnPreDeleteAsync(IncidentLensAssignment entity, CancellationToken ct = default)
    {
        if (!TrustedWrite.Active) throw new ArgumentException("Assignments are history; cancel them instead of deleting.");
        return base.OnPreDeleteAsync(entity, ct);
    }

    private static string Spec(IncidentLensAssignment a) => JsonSerializer.Serialize(new
    {
        a.Spec?.ParentId, a.Spec?.AgencyId, a.Spec?.Members, a.Spec?.LeadEmail, a.Spec?.Task, a.Spec?.RequestedByEmail,
        a.Spec?.RequestedVia, a.Spec?.ClientRequestId, a.Spec?.FacilityService, a.Spec?.FacilityVerificationId,
        a.Spec?.FacilityContactNote, a.Spec?.FacilityConfirmedAt, a.Spec?.FacilityConfirmedBy,
        a.Spec?.FacilityScreeningPolicy, a.Spec?.FacilityScreenedAt, a.Spec?.FacilityScreeningTypes, a.Spec?.FacilityScreeningReasons,
    });
}

public class IncidentLensAssignmentService : ResourceServiceBase<IncidentLensAssignment, IncidentLensAssignmentSpec, IncidentLensAssignmentResult>
{
    public IncidentLensAssignmentService(
        IRepository<IncidentLensAssignment> repository,
        ILogger<IncidentLensAssignmentService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor) { }

    protected override bool IsProvisioningNeeded(IncidentLensAssignment entity) => false;

    public override Task<IncidentLensAssignment> DeprovisionAsync(string workspaceId, string resourceId, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Assignments are cancelled, not deprovisioned.");
}
