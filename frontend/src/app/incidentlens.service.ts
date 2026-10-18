import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map, shareReplay } from 'rxjs/operators';

// Host-provided string DI tokens (reference/02, /13). REMOTE_DuploHttpClient: the host HTTP client with auth.
export const REMOTE_DuploHttpClient = 'REMOTE_DuploHttpClient';
export const REMOTE_UserSession = 'REMOTE_UserSession';

// Every data call uses the FULL namespaced segment (== manifest restSegment == controller [Route]).
const REST_SEGMENT = 'extensions/incidentlens-reports';
const INCIDENTS_SEGMENT = 'extensions/incidentlens-incidents';
const AGENCIES_SEGMENT = 'extensions/incidentlens-agencies';
const ORIGIN_TYPE = 'IncidentLensReport';
const SUB_TYPE = 'incidentlens-report';

export const CATEGORIES: { value: string; label: string }[] = [
  { value: 'road_collision', label: 'Road collision' },
  { value: 'pothole_road_damage', label: 'Pothole / road damage' },
  { value: 'waterlogging_flood', label: 'Waterlogging / flood' },
  { value: 'fallen_tree_obstruction', label: 'Fallen tree / obstruction' },
  { value: 'smoke_fire_indicator', label: 'Smoke / fire indicator' },
  { value: 'other_uncertain', label: 'Other / uncertain' },
];
export const categoryLabel = (c?: string | null) => CATEGORIES.find(x => x.value === c)?.label ?? (c || '—');

export const ASSIGNMENT_STATES: Record<string, string> = {
  requested: 'Requested', acknowledged: 'Acknowledged', en_route: 'En route', on_scene: 'On scene',
  completed: 'Completed', cancelled: 'Cancelled',
};
export const RESPONSE_STATES: Record<string, string> = {
  under_review: 'Under review', in_response: 'In response', awaiting_allocation: 'Awaiting allocation',
  needs_reassignment: 'Needs reassignment', response_complete: 'Response complete', closed: 'Closed',
};
export const PROCESSING_STATES: Record<string, string> = {
  received: 'Received', queued: 'Queued', analyzing: 'Analyzing', ready_for_review: 'Ready for review',
  manual_review: 'Needs manual review',
};
export const NEXT_STATE: Record<string, string[]> = {
  requested: ['acknowledged'], acknowledged: ['en_route', 'on_scene'], en_route: ['on_scene'], on_scene: ['completed'],
};

export interface WhoAmI {
  email: string; roles: string[]; isAdmin: boolean;
  capabilities: Record<string, boolean>; evaluationError?: string;
  agencies: { id: string; displayName: string; agencyType: string; leadEligible: boolean }[];
  visionConfigured: boolean; visionFixtureMode: boolean;
}

/** A client-generated id for idempotent submits/dispatches (a network retry re-sends the same id). */
export const newRequestId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

@Injectable({ providedIn: 'root' })
export class IncidentLensService {
  private readonly http = inject<any>(REMOTE_DuploHttpClient as any);
  private readonly session = inject<any>(REMOTE_UserSession as any);

  workspaceId(): string { return this.session?.tenant?.TenantId ?? ''; }
  userProvider(): string { return this.session?.provider ?? this.session?.user?.provider ?? ''; }
  workspaceName(): string { return this.session?.tenant?.AccountName ?? ''; }
  private env(): string { return `/v1/aiservicedesk/user/data/workspaces/${this.workspaceId()}/environment`; }
  reportsUrl(): string { return `${this.env()}/${REST_SEGMENT}`; }
  incidentsUrl(): string { return `${this.env()}/${INCIDENTS_SEGMENT}`; }
  agenciesUrl(): string { return `${this.env()}/${AGENCIES_SEGMENT}`; }

  // The host client does not unwrap the envelope; user/data returns {data: …}.
  private unwrap = (r: any) => (r && r.data !== undefined ? r.data : r);
  private list = (r: any) => { const d = this.unwrap(r); return (d?.items ?? d ?? []) as any[]; };
  private get<T = any>(url: string): Observable<T> { return this.http.get(url).pipe(map(this.unwrap)); }
  private post<T = any>(url: string, body: any): Observable<T> { return this.http.post(url, body).pipe(map(this.unwrap)); }

  private who$?: Observable<WhoAmI>; private whoWs = '';
  /** Capability probe, cached per workspace for the page's lifetime (UI view selection only — the server enforces). */
  whoami(): Observable<WhoAmI> {
    if (!this.who$ || this.whoWs !== this.workspaceId()) {
      this.whoWs = this.workspaceId();
      this.who$ = this.get<WhoAmI>(`${this.reportsUrl()}/whoami`).pipe(shareReplay({ bufferSize: 1, refCount: false }));
    }
    return this.who$;
  }

  // reporter
  submit(form: FormData): Observable<any> { return this.post(`${this.reportsUrl()}/submit`, form); }
  myReports(): Observable<any[]> { return this.http.get(`${this.reportsUrl()}/mine`).pipe(map(this.list)); }
  myReport(id: string): Observable<any> { return this.get(`${this.reportsUrl()}/mine/${id}`); }
  myPhotoUrl(id: string): string { return `${this.reportsUrl()}/mine/${id}/photo`; }

  // control room — reports
  reports(): Observable<any[]> { return this.http.get(`${this.reportsUrl()}?pageSize=200`).pipe(map(this.list)); }
  report(id: string): Observable<any> { return this.get(`${this.reportsUrl()}/${id}`); }
  reportPhotoUrl(id: string): string { return `${this.reportsUrl()}/${id}/photo`; }
  visionSettings(body: { visionFixtureMode?: boolean; visionScopeId?: string }): Observable<any> { return this.http.put(`${this.reportsUrl()}/vision-settings`, body).pipe(map(this.unwrap)); }
  candidates(id: string): Observable<any[]> { return this.get(`${this.reportsUrl()}/${id}/candidates`); }
  ticketName(id: string): Observable<string | null> {
    const url = `/v1/aiservicedesk/tickets/${this.workspaceId()}/origin-context?type=${ORIGIN_TYPE}&id=${id}&subType=${SUB_TYPE}`;
    return this.http.get(url).pipe(map((r: any) => this.unwrap(r)?.name ?? null));
  }

  // control room — incidents
  incidents(): Observable<any[]> { return this.http.get(`${this.incidentsUrl()}?pageSize=200`).pipe(map(this.list)); }
  triageSummary(id: string): Observable<any> { return this.get(`${this.incidentsUrl()}/${id}/triage-summary`); }
  verifyFacility(id: string, body: any): Observable<any> { return this.http.post(`${this.incidentsUrl()}/${id}/facility-verifications`, body).pipe(map(this.unwrap)); }
  nearbyResponders(id: string, services: string[]): Observable<any> { return this.get(`${this.incidentsUrl()}/${id}/nearby-responders?services=${encodeURIComponent(services.join(','))}`); }
  facilityAgency(body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/facility-agencies`, body); }
  facilityState(id: string, aid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assignments/${aid}/facility-state`, body); }
  briefsUrl(): string { return `${this.env()}/extensions/incidentlens-briefs`; }
  /** as = the caller's IncidentLens action used to authorise the create: report | triage | respond. */
  createBrief(as: 'report' | 'triage' | 'respond', body: any): Observable<any> { return this.post(`${this.briefsUrl()}/create/${as}`, body); }
  briefs(): Observable<any[]> { return this.http.get(`${this.briefsUrl()}/list`).pipe(map(this.list)); }
  brief(id: string): Observable<any> { return this.get(`${this.briefsUrl()}/view?id=${encodeURIComponent(id)}`); }
  priorityAlerts(audience: 'control' | 'responder'): Observable<any[]> { return this.get(`${this.incidentsUrl()}/alerts/${audience}`); }
  pulse(): Observable<any> { return this.get(`${this.incidentsUrl()}/pulse`); }
  board(id: string): Observable<any> { return this.get(`${this.incidentsUrl()}/${id}/board`); }
  createIncident(body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/from-reports`, body); }
  members(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/members`, body); }
  triage(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/triage`, body); }
  dispatch(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assignments`, body); }
  cancelAssignment(id: string, aid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assignments/${aid}/cancel`, body); }
  reassign(id: string, aid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assignments/${aid}/reassign`, body); }
  fulfill(id: string, rid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assistance/${rid}/fulfill`, body); }
  cancelAssistance(id: string, rid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/assistance/${rid}/cancel`, body); }
  close(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/close`, body); }
  reopen(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/reopen`, body); }
  link(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/${id}/links`, body); }
  groupingPolicy(): Observable<any> { return this.get(`${this.incidentsUrl()}/grouping-policy`); }
  saveGroupingPolicy(windows: any[]): Observable<any> { return this.http.put(`${this.incidentsUrl()}/grouping-policy`, { windows }).pipe(map(this.unwrap)); }
  adminResolutionPhotoUrl(id: string, aid: string): string { return `${this.incidentsUrl()}/${id}/assignments/${aid}/resolution-photo`; }

  // responders
  assigned(): Observable<any[]> { return this.http.get(`${this.incidentsUrl()}/assigned`).pipe(map(this.list)); }
  assignedOne(id: string): Observable<any> { return this.get(`${this.incidentsUrl()}/assigned/${id}`); }
  assignedPhotoUrl(id: string, rid: string): string { return `${this.incidentsUrl()}/assigned/${id}/reports/${rid}/photo`; }
  setState(id: string, aid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/assigned/${id}/assignments/${aid}/state`, body); }
  addNote(id: string, aid: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/assigned/${id}/assignments/${aid}/notes`, body); }
  complete(id: string, aid: string, form: FormData): Observable<any> { return this.post(`${this.incidentsUrl()}/assigned/${id}/assignments/${aid}/complete`, form); }
  requestAssistance(id: string, body: any): Observable<any> { return this.post(`${this.incidentsUrl()}/assigned/${id}/assistance`, body); }
  myAssignments(): Observable<any[]> { return this.http.get(`${this.incidentsUrl()}/my-assignments`).pipe(map(this.list)); }
  myResolutionPhotoUrl(aid: string): string { return `${this.incidentsUrl()}/my-assignments/${aid}/resolution-photo`; }

  // agencies
  agencies(): Observable<any[]> { return this.http.get(`${this.agenciesUrl()}?pageSize=200`).pipe(map(this.list)); }
  agency(id: string): Observable<any> { return this.get(`${this.agenciesUrl()}/${id}`); }
  directory(): Observable<any[]> { return this.http.get(`${this.agenciesUrl()}/directory`).pipe(map(this.list)); }
  createAgency(name: string, spec: any): Observable<any> { return this.post(this.agenciesUrl(), { name, spec }); }
  updateAgency(id: string, spec: any): Observable<any> { return this.http.patch(`${this.agenciesUrl()}/${id}`, { spec }).pipe(map(this.unwrap)); }

  /**
   * Fetch a protected image through the authenticated host client and return an object URL — an <img src> to the
   * API would not carry the bearer token. Callers revoke the URL on destroy.
   */
  imageUrl(url: string): Observable<string> {
    return this.http.get(url, { responseType: 'blob' }).pipe(map((b: Blob) => URL.createObjectURL(b)));
  }
}
