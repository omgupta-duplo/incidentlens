import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, forkJoin, interval, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { ASSIGNMENT_STATES, CATEGORIES, IncidentLensService, NEXT_STATE, PROCESSING_STATES, RESPONSE_STATES, categoryLabel, newRequestId } from '../incidentlens.service';
import { AuthImageComponent } from '../shared/auth-image.component';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';
import { StatusChipComponent } from '../shared/status-chip.component';
import { closureOutcome, facilityProvenance, incidentNextAction, incidentTitle, isActiveAssignment, sourceLabel } from '../util';
import { DispatchDraft, DispatchFormComponent } from './dispatch-form.component';
import { AiDispatchComponent } from './ai-dispatch.component';

type Tab = 'overview' | 'reports' | 'teams' | 'help' | 'audit';

/** Oversight board for one incident: triage, membership, multi-agency teams, help requests, audit, closure. */
@Component({
  selector: 'il-incident-board',
  imports: [DatePipe, FormsModule, AuthImageComponent, GeoMapComponent, StatusChipComponent, DispatchFormComponent, AiDispatchComponent],
  styleUrl: './control.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><button type="button" class="il-link" (click)="back()">← Control room</button></header>
      @if (inc(); as i) {
        <header class="il-hero">
          <div class="row"><span class="il-pri" [attr.data-p]="i.spec.priority">{{ i.spec.priority }}</span>
            <span class="il-hero-state">{{ rs[i.result.responseState] }}</span><span class="il-grow"></span>
            <span>Ref <span class="il-mono" data-ref>{{ i.name }}</span></span></div>
          <h1>{{ iTitle(i) }} · {{ i.spec.priority }}</h1>
          <p class="il-hero-sub">{{ cat(i.spec.category) }} @if (i.spec.summary) { · {{ i.spec.summary }} }</p>
          <div class="il-hero-foot">
            <span>◎ {{ i.spec.memberReportIds?.length || 0 }} report{{ (i.spec.memberReportIds?.length || 0) === 1 ? '' : 's' }} connected · {{ i.result.assignmentSummary?.length || 0 }} team{{ (i.result.assignmentSummary?.length || 0) === 1 ? '' : 's' }} · updated {{ i.result.lastUpdatedAt | date:'short' }}</span>
            <button type="button" class="il-hero-btn" (click)="openBrief(i)">Situation brief</button>
            @if (!i.result.closed) { <button type="button" class="il-hero-btn" (click)="panel.set('close')">Close incident…</button> }
            @else { <button type="button" class="il-hero-btn" (click)="panel.set('reopen')">Reopen…</button> }
          </div>
        </header>
        @if (closure(i); as c) { <p class="il-alert" [class.warn]="!hasCompleted(i)" [class.info]="hasCompleted(i)" role="status"><strong>Outcome:</strong> {{ c }}
          @if (i.result.closeReason) { <br /><small>Closure reason (admin-only): {{ i.result.closeReason }}</small> }</p> }
        @if (nextAction(i); as n) { <p class="il-next" role="note"><strong>Next step:</strong> {{ n }}</p> }
        @if (i.result.responseState === 'needs_reassignment') { <p class="il-alert err" role="status"><strong>Needs reassignment:</strong> every team was cancelled and none completed. Dispatch a new team or close with a reason.</p> }
        @if (i.result.responseState === 'awaiting_allocation') { <p class="il-alert warn" role="status"><strong>Awaiting allocation:</strong> a responder asked for help that has not been allocated yet (see Help requests).</p> }
        @if (msg()) { <p class="il-alert ok" role="status">{{ msg() }}</p> }
        @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }

        @if (panel() === 'close') {
          <form class="il-panel" (ngSubmit)="close()" aria-label="Close incident">
            <h3 style="font-size:1rem;margin:0 0 8px">Close {{ i.name }}</h3>
            @if (blockers().assignments.length || blockers().requests.length) {
              <div class="il-alert warn" role="alert"><strong>Active work remains.</strong> Closing now will cancel:
                <ul style="margin:6px 0 0">
                  @for (a of blockers().assignments; track a.id) { <li>{{ a.spec.agencyName }} team ({{ asl[a.result.state] }})</li> }
                  @for (p of blockers().requests; track p.id) { <li>Help request: {{ p.requestedAgencyName || p.requestedCapabilities.join(', ') }} (awaiting allocation)</li> }
                </ul></div>
              <label class="il-field"><span>Why cancel the remaining work? (sent to the teams, audited per item)</span>
                <input class="il-input" name="cr" required [ngModel]="cancelReason()" (ngModelChange)="cancelReason.set($event)" /></label>
              <label class="il-field"><span><input type="checkbox" name="fc" [ngModel]="forceOk()" (ngModelChange)="forceOk.set($event)" />
                I confirm cancelling the work listed above.</span></label>
            } @else { <p class="il-muted">All teams have finished and no help requests are pending.</p> }
            <label class="il-field"><span>Closure reason (audited)</span><input class="il-input" name="r" required [ngModel]="closeReason()" (ngModelChange)="closeReason.set($event)" /></label>
            <div style="display:flex;gap:8px">
              <button type="submit" class="il-btn danger" [disabled]="busy() || !closeReason().trim() || (needsForce() && (!forceOk() || !cancelReason().trim()))">Close incident</button>
              <button type="button" class="il-btn ghost" (click)="panel.set('')">Cancel</button></div>
          </form>
        }
        @if (panel() === 'reopen') {
          <form class="il-panel" (ngSubmit)="reopen()" aria-label="Reopen incident">
            <label class="il-field"><span>Reason for reopening (audited)</span><input class="il-input" name="rr" required [ngModel]="reopenReason()" (ngModelChange)="reopenReason.set($event)" /></label>
            <div style="display:flex;gap:8px"><button type="submit" class="il-btn" [disabled]="busy() || !reopenReason().trim()">Reopen</button>
              <button type="button" class="il-btn ghost" (click)="panel.set('')">Cancel</button></div>
          </form>
        }

        <div class="il-tabs" role="tablist" aria-label="Incident sections" (keydown)="tabKey($event)">
          @for (t of tabs; track t.key) {
            <button type="button" role="tab" [id]="'itab-' + t.key" [attr.aria-selected]="tab() === t.key" [attr.tabindex]="tab() === t.key ? 0 : -1"
                    (click)="tab.set(t.key)">{{ t.label }}{{ count(t.key) }}</button>
          }
        </div>

        @switch (tab()) {
          @case ('overview') {
            <section class="il-card" role="tabpanel" aria-labelledby="itab-overview">
              <h2>Triage</h2>
              <form (ngSubmit)="triage()">
                <div class="il-grid">
                  <label class="il-field"><span>Category</span><select class="il-input" name="c" [ngModel]="tCat()" (ngModelChange)="tCat.set($event)">@for (c of categories; track c.value) { <option [value]="c.value">{{ c.label }}</option> }</select></label>
                  <label class="il-field"><span>Priority</span><select class="il-input" name="p" [ngModel]="tPri()" (ngModelChange)="tPri.set($event)">@for (p of ['P1','P2','P3','P4']; track p) { <option [value]="p">{{ p }}</option> }</select></label>
                </div>
                <label class="il-field"><span>Jurisdiction / area</span><input class="il-input" name="j" [ngModel]="tJur()" (ngModelChange)="tJur.set($event)" /></label>
                <label class="il-field"><span>Summary</span><input class="il-input" name="s" [ngModel]="tSum()" (ngModelChange)="tSum.set($event)" /></label>
                <label class="il-field"><span>Reason for the change (audited)</span><input class="il-input" name="r" [ngModel]="tReason()" (ngModelChange)="tReason.set($event)" /></label>
                <button type="submit" class="il-btn" [disabled]="busy() || !tReason().trim()">Save triage</button>
              </form>
            </section>
          }
          @case ('reports') {
            <div class="il-split" role="tabpanel" aria-labelledby="itab-reports">
              <section class="il-card"><h2>Reports in this incident</h2>
                <ul class="il-list">
                  @for (r of reports(); track r.id) {
                    <li><button type="button" class="il-link" (click)="openReport(r.id)">{{ r.name }}</button> · {{ r.receivedAt | date:'short' }} · {{ src(r.locationSource) }}
                      @if (r.processingState) { · <il-status [value]="r.processingState" [label]="psl[r.processingState]" /> }
                      @if (r.assessment) { <br /><small>{{ r.assessment.observations }}</small> }
                      @if (reports().length > 1 && !i.result.closed) { <br /><button type="button" class="il-link" (click)="removeReport(r.id)">Remove from incident (split)…</button> }</li>
                  }
                </ul>
                @if (!i.result.closed) {
                  <form class="il-panel" (ngSubmit)="addReports()" aria-label="Add reports">
                    <label class="il-field"><span>Add an ungrouped report (merge)</span>
                      <select class="il-input" name="ar" [ngModel]="addId()" (ngModelChange)="addId.set($event)"><option value="">Choose…</option>
                        @for (u of ungrouped(); track u.id) { <option [value]="u.id">{{ u.name }} — {{ cat(u.spec.categoryHint) }}</option> }</select></label>
                    <label class="il-field"><span>Reason (audited)</span><input class="il-input" name="mr" [ngModel]="memberReason()" (ngModelChange)="memberReason.set($event)" /></label>
                    <button type="submit" class="il-btn sm" [disabled]="busy() || !addId() || !memberReason().trim()">Add report</button>
                  </form>
                }
              </section>
              <section class="il-card"><h2>Map</h2>
                <il-geo-map [markers]="markers()" ariaLabel="Report locations for this incident" listLabel="Report locations" /></section>
            </div>
          }
          @case ('teams') {
            <section role="tabpanel" aria-labelledby="itab-teams">
              <il-ai-dispatch [incidentId]="i.id" [category]="i.spec.category" [area]="i.spec.jurisdiction" [closed]="i.result.closed" (dispatched)="load(false)" />
              @if (!i.result.closed && panel() !== 'dispatch') { <button type="button" class="il-btn" (click)="panel.set('dispatch')">Dispatch a team…</button> }
              @if (panel() === 'dispatch') {
                <il-dispatch-form [agencies]="agencies()" [presetTask]="'Assess and report: ' + (i.spec.summary || iTitle(i))" [busyFlag]="busy()" [warnings]="warnings()" (submitted)="dispatch($event)" (cancel)="panel.set('')" />
              }
              @if (!assignments().length) { <p class="il-muted" style="margin-top:10px">No teams dispatched yet.</p> }
              @for (a of assignments(); track a.id) {
                <article class="il-team" [attr.aria-labelledby]="'t-' + a.id" style="margin-top:10px">
                  <h3 [id]="'t-' + a.id">{{ a.spec.agencyName }} — <il-status [value]="a.result.state" [label]="asl[a.result.state]" /></h3>
                  <p style="margin:0">Task: {{ a.spec.task }}</p>
                  @if (a.spec.facility) {
                    @let fp = prov(a.spec);
                    <p style="margin:0" class="il-muted"><span class="il-chip">Facility</span> @if (fp.fixture) { <span class="il-badge fixture">FIXTURE</span> }
                      {{ fp.source }} · no app users — the control room records its status
                      @if (fp.route) { · {{ fp.route }} }</p>
                    @if (!i.result.closed && nextFor(a.result.state).length) {
                      <div class="il-row-actions" style="margin-top:6px" role="group" [attr.aria-label]="'Record status for ' + a.spec.agencyName">
                        @for (st of nextFor(a.result.state); track st) {
                          <button type="button" class="il-btn ghost sm" [disabled]="busy()" (click)="facilityState(a, st)">Mark {{ asl[st].toLowerCase() }}</button> }
                      </div>
                    }
                  } @else {
                  <p style="margin:0" class="il-muted">Lead {{ lead(a) }} · members: {{ members(a) }} · via {{ a.spec.requestedVia === 'admin' ? 'control room' : 'responder help request' }}
                    @if (a.spec.simulatedEtaMinutes != null) { · ETA {{ a.spec.simulatedEtaMinutes }} min <span class="il-badge sim">SIMULATED</span> }</p>
                  }
                  <details style="margin-top:6px"><summary>History ({{ a.result.stateHistory.length }}) and notes ({{ a.result.notes.length }})</summary>
                    <ul>@for (h of a.result.stateHistory; track $index) { <li>{{ asl[h.state] }} · {{ h.at | date:'medium' }} · by {{ h.byEmail }}</li> }</ul>
                    @if (a.result.cancelReason) { <p>Cancelled: {{ a.result.cancelReason }}</p> }
                    <ul>@for (n of a.result.notes; track $index) { <li>{{ n.at | date:'short' }} · {{ n.byEmail }}: {{ n.text }}</li> }</ul>
                  </details>
                  @if (a.result.resolution; as res) {
                    <div class="il-panel"><strong>Resolution evidence</strong> (private: control room + this team) · {{ res.submittedAt | date:'medium' }}
                      <p style="margin:4px 0">{{ res.note }}</p>
                      @if (res.photoFileId) { <il-auth-image [src]="resPhoto(a.id)" [alt]="'Resolution photo from ' + a.spec.agencyName" /> }</div>
                  }
                  @if (active(a) && !i.result.closed) {
                    <div class="il-row-actions" style="margin-top:6px">
                      <button type="button" class="il-btn ghost sm" (click)="startCancel(a)">Cancel team…</button>
                      <button type="button" class="il-btn ghost sm" (click)="startReassign(a)">Reassign…</button>
                    </div>
                  }
                  @if (target() === a.id && panel() === 'cancel') {
                    <form class="il-panel" (ngSubmit)="cancelTeam(a)"><label class="il-field"><span>Why cancel this team? (audited, sent to the team)</span>
                      <input class="il-input" name="cx" [ngModel]="cancelReason()" (ngModelChange)="cancelReason.set($event)" /></label>
                      <button type="submit" class="il-btn danger sm" [disabled]="busy() || !cancelReason().trim()">Cancel team</button>
                      <button type="button" class="il-btn ghost sm" (click)="panel.set('')">Keep</button></form>
                  }
                  @if (target() === a.id && panel() === 'reassign') {
                    <il-dispatch-form title="Reassign — replaces this team" submitLabel="Reassign" [agencies]="agencies()" [presetAgencyId]="a.spec.agencyId"
                                      [presetTask]="a.spec.task" [busyFlag]="busy()" (submitted)="reassign(a, $event)" (cancel)="panel.set('')" />
                  }
                </article>
              }
            </section>
          }
          @case ('help') {
            <section class="il-card" role="tabpanel" aria-labelledby="itab-help"><h2>Help requests from responders</h2>
              <p class="il-muted">Responders can request help without approval. Requests naming specific people were dispatched immediately; agency-only requests wait here for allocation.</p>
              @if (!i.result.assistanceRequests.length) { <p class="il-muted">None.</p> }
              <ul class="il-list">
                @for (q of i.result.assistanceRequests; track q.id) {
                  <li><il-status [value]="q.state" [label]="q.state === 'pending' ? 'Awaiting allocation' : q.state === 'fulfilled' ? 'Dispatched' : 'Cancelled'" />
                    {{ q.requestedAgencyName || 'Any agency' }} · {{ q.requestedCapabilities.join(', ') }} · {{ q.personnelCount }} person(s) · by {{ q.requestedByEmail }} · {{ q.createdAt | date:'short' }}
                    <br /><small>{{ q.reason }}</small>
                    @if (q.state === 'pending' && !i.result.closed) {
                      <div class="il-row-actions"><button type="button" class="il-btn sm" (click)="target.set(q.id); panel.set('fulfil')">Allocate a team…</button>
                        <button type="button" class="il-btn ghost sm" (click)="target.set(q.id); panel.set('rcancel')">Cancel request…</button></div>
                      @if (target() === q.id && panel() === 'fulfil') {
                        <il-dispatch-form title="Allocate this request" submitLabel="Allocate" [agencies]="agencies()" [presetAgencyId]="q.requestedAgencyId"
                                          [presetTask]="'Assist: ' + q.reason" [busyFlag]="busy()" [showEta]="false" (submitted)="fulfil(q, $event)" (cancel)="panel.set('')" />
                      }
                      @if (target() === q.id && panel() === 'rcancel') {
                        <form class="il-panel" (ngSubmit)="cancelRequest(q)"><label class="il-field"><span>Reason (audited)</span>
                          <input class="il-input" name="rq" [ngModel]="cancelReason()" (ngModelChange)="cancelReason.set($event)" /></label>
                          <button type="submit" class="il-btn danger sm" [disabled]="busy() || !cancelReason().trim()">Cancel request</button></form>
                      }
                    }
                  </li>
                }
              </ul>
            </section>
          }
          @case ('audit') {
            <div class="il-grid" role="tabpanel" aria-labelledby="itab-audit">
              <section class="il-card"><h2>Audit trail</h2>
                <table class="il-table"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Detail</th></tr></thead>
                  <tbody>@for (e of auditRows(); track $index) { <tr><td>{{ e.at | date:'short' }}</td><td>{{ e.actorEmail }}</td><td>{{ e.action }}
                    @if (e.fromState || e.toState) { <br /><small>{{ e.fromState }} → {{ e.toState }}</small> }</td><td>{{ e.reason }} {{ e.detail }}</td></tr> }</tbody></table></section>
              <section class="il-card"><h2>Notifications <span class="il-badge sim">MOCK</span></h2>
                <p class="il-muted">No real agency is contacted. "Sent" records a mock delivery attempt — it is never an acknowledgement.</p>
                <ul class="il-list">@for (n of i.result.notifications; track $index) { <li>{{ n.at | date:'short' }} · to {{ n.to }} · {{ n.state }} · {{ n.detail }}</li> }</ul></section>
            </div>
          }
        }
      } @else if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      @else { <p class="il-muted" aria-live="polite">Loading…</p> }
    </div>
  `,
})
export class IncidentBoardComponent implements OnInit {
  protected readonly iTitle = incidentTitle;
  protected readonly closure = closureOutcome;
  protected readonly nextAction = incidentNextAction;
  protected hasCompleted(i: any): boolean { return (i?.result?.assignmentSummary ?? []).some((a: any) => a.state === 'completed'); }
  private readonly svc = inject(IncidentLensService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly tabs: { key: Tab; label: string }[] = [{ key: 'overview', label: 'Overview' }, { key: 'reports', label: 'Reports' },
    { key: 'teams', label: 'Teams' }, { key: 'help', label: 'Help requests' }, { key: 'audit', label: 'Audit' }];
  protected readonly categories = CATEGORIES;
  protected readonly rs = RESPONSE_STATES; protected readonly asl = ASSIGNMENT_STATES; protected readonly psl = PROCESSING_STATES;
  protected readonly cat = categoryLabel; protected readonly src = sourceLabel;
  protected readonly tab = signal<Tab>('teams');
  protected readonly panel = signal<string>('');
  protected readonly target = signal<string>('');
  protected readonly inc = signal<any>(null);
  protected readonly assignments = signal<any[]>([]);
  protected readonly reports = signal<any[]>([]);
  protected readonly agencies = signal<any[]>([]);
  protected readonly ungrouped = signal<any[]>([]);
  protected readonly warnings = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly msg = signal(''); protected readonly error = signal('');
  protected readonly closeReason = signal(''); protected readonly cancelReason = signal(''); protected readonly forceOk = signal(false);
  protected readonly reopenReason = signal(''); protected readonly memberReason = signal(''); protected readonly addId = signal('');
  protected readonly tCat = signal(''); protected readonly tPri = signal(''); protected readonly tJur = signal(''); protected readonly tSum = signal(''); protected readonly tReason = signal('');
  // Read the id live: Angular reuses this component when only the :id changes (in-app navigation between records),
  // so a value captured once would keep showing the previous record.
  private get id(): string { return this.route.snapshot.params['id']; }
  private lastId = '';
  private poll?: Subscription;

  protected readonly blockers = computed(() => ({
    assignments: this.assignments().filter(a => isActiveAssignment(a.result?.state)),
    requests: (this.inc()?.result?.assistanceRequests ?? []).filter((q: any) => q.state === 'pending'),
  }));
  protected readonly needsForce = computed(() => this.blockers().assignments.length > 0 || this.blockers().requests.length > 0);
  protected readonly markers = computed<MapMarker[]>(() => this.reports().map(r => ({ id: r.id, lat: r.latitude, lng: r.longitude, label: r.name, detail: sourceLabel(r.locationSource) })));
  protected readonly auditRows = computed(() => [...(this.inc()?.result?.audit ?? [])].reverse());

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(p => {
      const id = p.get('id') ?? '';
      if (this.lastId && id !== this.lastId) { this.resetForNewId(); this.load(true); }
      this.lastId = id;
    });
  }

  ngOnInit(): void {
    this.load(true);
    this.poll = interval(10000).subscribe(() => { if (!this.panel()) this.load(false); });
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }

  private resetForNewId(): void {
    this.inc.set(null); this.assignments.set([]); this.reports.set([]); this.panel.set(''); this.target.set('');
    this.msg.set(''); this.error.set(''); this.warnings.set([]);
  }
  protected load(first: boolean): void {
    this.svc.board(this.id).subscribe({
      next: b => {
        this.inc.set(b.incident); this.assignments.set(b.assignments ?? []); this.reports.set(b.reports ?? []);
        if (first) { const s = b.incident.spec; this.tCat.set(s.category); this.tPri.set(s.priority); this.tJur.set(s.jurisdiction); this.tSum.set(s.summary ?? ''); }
      },
      error: e => this.error.set(extractErrorMessage(e) || 'Incident not found.'),
    });
    if (first) this.loadAgencies();
    this.svc.reports().subscribe({ next: r => this.ungrouped.set((r ?? []).filter(x => !x.spec?.incidentId)) });
  }

  private loadAgencies(): void {
    this.svc.agencies().subscribe(list => {
      if (!list?.length) { this.agencies.set([]); return; }
      forkJoin(list.map(a => this.svc.agency(a.id).pipe(catchError(() => of(a))))).subscribe(full => this.agencies.set(full));
    });
  }

  private run(obs: any, ok: string, after?: (r: any) => void): void {
    this.busy.set(true); this.error.set(''); this.msg.set('');
    obs.subscribe({
      next: (r: any) => { this.busy.set(false); this.msg.set(ok); this.panel.set(''); this.cancelReason.set(''); after?.(r); this.load(false); this.loadAgencies(); },
      error: (e: any) => { this.busy.set(false); this.error.set(extractErrorMessage(e) || 'The action failed.'); this.load(false); },
    });
  }

  protected count(t: Tab): string {
    if (t === 'teams') return ` (${this.assignments().length})`;
    if (t === 'help') { const n = (this.inc()?.result?.assistanceRequests ?? []).filter((q: any) => q.state === 'pending').length; return n ? ` (${n} pending)` : ''; }
    if (t === 'reports') return ` (${this.reports().length})`;
    return '';
  }
  protected tabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = this.tabs.findIndex(t => t.key === this.tab());
    const next = this.tabs[(i + (e.key === 'ArrowRight' ? 1 : this.tabs.length - 1)) % this.tabs.length].key;
    this.tab.set(next); queueMicrotask(() => document.getElementById('itab-' + next)?.focus());
  }
  protected active(a: any): boolean { return isActiveAssignment(a.result?.state); }
  /** Pre-filled public-source brief for this incident's event and area (Gemini + Google Search). */
  protected openBrief(i: any): void {
    this.router.navigate(['../../briefs'], { relativeTo: this.route,
      queryParams: { q: `${categoryLabel(i.spec.category)} ${i.spec.jurisdiction ?? ''}`.trim(), place: i.spec.jurisdiction ?? '', incident: i.id } });
  }
  protected readonly prov = facilityProvenance;
  protected nextFor(state: string): string[] { return NEXT_STATE[state] ?? []; }
  /** Facility (no app users): the control room records its status, e.g. after a phone call. Completion needs a note. */
  protected facilityState(a: any, state: string): void {
    let note: string | null = null;
    if (state === 'completed') {
      note = window.prompt(`What did ${a.spec.agencyName} report when they finished? (required, recorded as the resolution)`);
      if (!note?.trim()) return;
    }
    this.run(this.svc.facilityState(this.id, a.id, { state, note, expectedVersion: a.result.stateVersion }), `${a.spec.agencyName}: ${this.asl[state]}.`);
  }
  protected lead(a: any): string { return a.spec.members.find((m: any) => m.email === a.spec.leadEmail)?.displayName ?? a.spec.leadEmail; }
  protected members(a: any): string { return a.spec.members.map((m: any) => m.displayName).join(', '); }
  protected resPhoto(aid: string): string { return this.svc.adminResolutionPhotoUrl(this.id, aid); }
  protected openReport(rid: string): void { this.router.navigate(['../../reports', rid], { relativeTo: this.route }); }
  protected back(): void { this.router.navigate(['../..'], { relativeTo: this.route }); }

  protected triage(): void {
    this.run(this.svc.triage(this.id, { category: this.tCat(), priority: this.tPri(), jurisdiction: this.tJur(), summary: this.tSum(),
      reason: this.tReason().trim(), expectedVersion: this.inc().version }), 'Triage saved.', () => this.tReason.set(''));
  }
  protected dispatch(d: DispatchDraft): void {
    this.run(this.svc.dispatch(this.id, { ...d, clientRequestId: newRequestId() }), 'Team dispatched.', r => this.warnings.set(r?.warnings ?? []));
  }
  protected startCancel(a: any): void { this.target.set(a.id); this.panel.set('cancel'); }
  protected startReassign(a: any): void { this.target.set(a.id); this.panel.set('reassign'); }
  protected cancelTeam(a: any): void {
    this.run(this.svc.cancelAssignment(this.id, a.id, { reason: this.cancelReason().trim(), expectedVersion: a.result.stateVersion }), `${a.spec.agencyName} team cancelled.`);
  }
  protected reassign(a: any, d: DispatchDraft): void {
    this.run(this.svc.reassign(this.id, a.id, { ...d, clientRequestId: newRequestId() }), 'Team reassigned.');
  }
  protected fulfil(q: any, d: DispatchDraft): void {
    this.run(this.svc.fulfill(this.id, q.id, { ...d, clientRequestId: newRequestId() }), 'Help request allocated.');
  }
  protected cancelRequest(q: any): void {
    this.run(this.svc.cancelAssistance(this.id, q.id, { reason: this.cancelReason().trim() }), 'Help request cancelled.');
  }
  protected removeReport(rid: string): void {
    const reason = window.prompt('Why does this report belong to a different event? (audited)');
    if (!reason?.trim()) return;
    this.run(this.svc.members(this.id, { remove: [rid], reason: reason.trim(), expectedVersion: this.inc().version }), 'Report removed from the incident.');
  }
  protected addReports(): void {
    this.run(this.svc.members(this.id, { add: [this.addId()], reason: this.memberReason().trim(), expectedVersion: this.inc().version }), 'Report added.',
      () => { this.addId.set(''); this.memberReason.set(''); });
  }
  protected close(): void {
    this.run(this.svc.close(this.id, { reason: this.closeReason().trim(), force: this.needsForce(), cancelReason: this.cancelReason().trim() || null,
      expectedVersion: this.inc().version }), 'Incident closed.', () => { this.closeReason.set(''); this.forceOk.set(false); });
  }
  protected reopen(): void {
    this.run(this.svc.reopen(this.id, { reason: this.reopenReason().trim(), expectedVersion: this.inc().version }), 'Incident reopened.', () => this.reopenReason.set(''));
  }
}
