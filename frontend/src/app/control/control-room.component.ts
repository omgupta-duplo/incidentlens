import { matchesEvidence } from './record-search';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { ASSIGNMENT_STATES, CATEGORIES, IncidentLensService, PROCESSING_STATES, RESPONSE_STATES, categoryLabel } from '../incidentlens.service';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';
import { PulseMapComponent } from './pulse-map.component';
import { StatusChipComponent } from '../shared/status-chip.component';
import { REVIEW_KIND_LABEL, REVIEW_KIND_TONE, closureOutcome, incidentNextAction, incidentTitle, isActiveAssignment, processingState, reportTitle, reviewKind, sourceLabel } from '../util';
import { IL_MODE } from '../shell/il-mode';

type Tab = 'pulse' | 'queue' | 'incidents' | 'settings';

/** Control room home: evidence queue (map + list), incidents, and IncidentLens settings. */
@Component({
  selector: 'il-control-room',
  imports: [DatePipe, FormsModule, GeoMapComponent, StatusChipComponent, PulseMapComponent],
  styleUrl: './control.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><div class="il-grow"><h1>Control room</h1>
        <p class="il-sub">Review complaints, group reports into incidents and coordinate response teams. AI output is advisory; every decision is yours and is audited.</p></div></header>
      <div class="il-tabs" role="tablist" aria-label="Control room sections" (keydown)="tabKey($event)">
        @for (t of tabs; track t.key) {
          <button type="button" role="tab" [id]="'tab-' + t.key" [attr.aria-selected]="tab() === t.key" [attr.aria-controls]="'panel-' + t.key"
                  [attr.tabindex]="tab() === t.key ? 0 : -1" (click)="tab.set(t.key); remember(t.key)">{{ t.label }}@if (t.key === 'incidents' && attention()) { ({{ attention() }} need attention) }</button>
        }
      </div>
      @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      <ul class="il-stats" aria-label="Summary">
        <li><span class="ico" aria-hidden="true">◈</span><strong>{{ stats().open }}</strong><span>Open incidents</span></li>
        <li><span class="ico" aria-hidden="true">◎</span><strong>{{ stats().awaiting }}</strong><span>Reports not yet grouped</span></li>
        <li><span class="ico" aria-hidden="true">⇄</span><strong>{{ stats().teams }}</strong><span>Active response teams</span></li>
        <li><span class="ico" aria-hidden="true">↗</span><strong>{{ stats().requests }}</strong><span>Help requests to allocate</span></li>
      </ul>

      @if (tab() === 'pulse') {
        <section role="tabpanel" id="panel-pulse" aria-labelledby="tab-pulse" class="il-card">
          <h2 style="margin-top:0">Live incident pulse</h2>
          <p class="il-muted" style="margin-top:0">Each open incident heats up as reports arrive and cools as time passes. Use Replay to watch how it developed.</p>
          <il-pulse-map (open)="openIncident($event)" />
        </section>
      }

      @if (tab() === 'queue') {
        <section role="tabpanel" id="panel-queue" aria-labelledby="tab-queue">
          <div class="il-filters">
            <label class="il-field"><span>Search complaints</span>
              <input class="il-input" type="search" name="complaintSearch" placeholder="Reference, category or reported details…" [ngModel]="qSearch()" (ngModelChange)="qSearch.set($event)" /></label>
            @if (qSearch()) { <button type="button" class="il-btn ghost sm" (click)="qSearch.set('')">Clear complaint search</button> }
            <label class="il-field"><span>Processing</span>
              <select class="il-input" name="fs" [ngModel]="fState()" (ngModelChange)="fState.set($event)">
                <option value="">All</option>@for (k of psKeys; track k) { <option [value]="k">{{ ps[k] }}</option> }
              </select></label>
            <label class="il-field"><span>Category</span>
              <select class="il-input" name="fc" [ngModel]="fCat()" (ngModelChange)="fCat.set($event)">
                <option value="">All</option>@for (c of categories; track c.value) { <option [value]="c.value">{{ c.label }}</option> }
              </select></label>
            <label class="il-field"><span><input type="checkbox" name="fu" [ngModel]="fUngrouped()" (ngModelChange)="fUngrouped.set($event)" /> Not yet grouped</span></label>
            <label class="il-field"><span><input type="checkbox" name="fx" [ngModel]="fUrgent()" (ngModelChange)="fUrgent.set($event)" /> Urgency cue only</span></label>
            <button type="button" class="il-btn ghost sm" (click)="load()">Refresh</button>
          </div>
          <div class="il-split">
            <section class="il-card" aria-labelledby="q-h">
              <h2 id="q-h">Complaints queue ({{ queue().length }})</h2>
              @if (!queue().length) { <p class="il-muted">No reports match.</p> }
              @else {
                <table class="il-table">
                  <caption class="sr-only">Reports awaiting review</caption>
                  <thead><tr><th scope="col">Report</th><th scope="col">Received</th><th scope="col">Category</th><th scope="col">State</th><th scope="col">Cues</th></tr></thead>
                  <tbody>
                    @for (r of queue(); track r.id) {
                      <tr>
                        <td><button type="button" class="il-link" [attr.aria-label]="rTitle(r) + ', ref ' + r.name" (click)="openReport(r.id)">{{ rTitle(r) }}</button>
                          <br /><small class="il-muted il-mono">{{ r.name }}</small>
                          @if (r.spec.incidentId) { <br /><small class="il-muted">in an incident</small> }</td>
                        <td>{{ r.spec.receivedAt | date:'short' }}</td>
                        <td>{{ cat(r.result?.assessment?.suggestedCategory || r.spec.categoryHint) }}</td>
                        <td><il-status [value]="kindTone[r._kind]" [label]="kindLabel[r._kind]" /></td>
                        <td>
                          @if (r.result?.assessment?.urgencyHint) { <span class="il-chip">urgency cue</span> }
                          @if (r.result?.reuseMatches?.length) { <span class="il-chip">photo reused</span> }
                          @if (r.spec.captureSource === 'upload') { <span class="il-chip">uploaded</span> }
                          @if (r.result?.vision?.web?.pagesWithMatches || r.result?.vision?.web?.fullMatches) { <span class="il-chip">seen online</span> }
                          @if (r.result?.vision?.provider === 'fixture') { <span class="il-badge fixture">FIXTURE</span> }
                          <span class="il-chip">{{ src(r.spec.locationSource) }}</span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>
            <section class="il-card" aria-labelledby="m-h">
              <h2 id="m-h">Map of open reports</h2>
              <il-geo-map [markers]="markers()" [selectable]="true" (selected)="openReport($event)" ariaLabel="Map of open reports" listLabel="Open reports by location" />
            </section>
          </div>
        </section>
      }

      @if (tab() === 'incidents') {
        <section role="tabpanel" id="panel-incidents" aria-labelledby="tab-incidents" class="il-iq-split">
          <section class="il-card il-iq" aria-labelledby="iq-h">
            <h2 id="iq-h">Incident queue <span class="il-count">{{ shownIncidents().length }}</span></h2>
            <label class="il-field"><span class="sr-only">Search incidents</span>
              <input class="il-input" type="search" name="iq" placeholder="Search incidents…" [ngModel]="iSearch()" (ngModelChange)="iSearch.set($event)" /></label>
            <div class="il-seg" role="group" aria-label="Filter incidents">
              @for (f of iFilters; track f.key) { <button type="button" [attr.aria-pressed]="iFilter() === f.key" (click)="iFilter.set(f.key)">{{ f.label }}</button> }
            </div>
            @if (!shownIncidents().length) { <p class="il-muted">{{ incidents().length ? 'No incidents match.' : 'No incidents yet — create one from the complaints queue.' }}</p> }
            <ul class="il-iq-list">
              @for (i of shownIncidents(); track i.id) {
                <li><button type="button" class="il-iq-item" [class.sel]="sel()?.id === i.id" [attr.aria-pressed]="sel()?.id === i.id"
                            [attr.aria-label]="iTitle(i) + ', ' + i.spec.priority + ', ' + rs[i.result.responseState] + ', ref ' + i.name" (click)="selId.set(i.id)">
                  <span class="row"><span class="il-pri" [attr.data-p]="i.spec.priority">{{ i.spec.priority }}</span><span class="il-mono il-muted">{{ i.name }}</span></span>
                  <strong>{{ iTitle(i) }}</strong>
                  <span class="row il-muted"><span>{{ i.spec.memberReportIds?.length || 0 }} report{{ (i.spec.memberReportIds?.length || 0) === 1 ? '' : 's' }}</span>
                    <span>{{ rs[i.result.responseState] }}</span></span>
                </button></li>
              }
            </ul>
          </section>
          <div class="il-iq-detail">
            @if (sel(); as i) {
              <section class="il-hero" aria-labelledby="hero-h">
                <div class="row"><span class="il-pri" [attr.data-p]="i.spec.priority">{{ i.spec.priority }} · {{ priLabel(i.spec.priority) }}</span>
                  <span class="il-hero-state">{{ rs[i.result.responseState] }}</span><span class="il-grow"></span><span class="il-mono">{{ i.name }}</span></div>
                <h2 id="hero-h">{{ iTitle(i) }}</h2>
                <p class="il-hero-sub">{{ cat(i.spec.category) }}@if (i.spec.summary) { · {{ i.spec.summary }} }</p>
                <div class="il-hero-foot">
                  <span>◎ {{ i.spec.memberReportIds?.length || 0 }} report{{ (i.spec.memberReportIds?.length || 0) === 1 ? '' : 's' }} connected · updated {{ i.result.lastUpdatedAt | date:'short' }}</span>
                  <button type="button" class="il-hero-btn" (click)="openIncident(i.id)">Open incident</button>
                </div>
              </section>
              @if (closure(i); as c) { <p class="il-alert" [class.warn]="!hasCompleted(i)" [class.info]="hasCompleted(i)" role="status"><strong>Outcome:</strong> {{ c }}</p> }
              @if (next(i); as n) { <p class="il-next" role="note"><strong>Next step:</strong> {{ n }}</p> }
              @if (i.result.responseState === 'needs_reassignment') { <p class="il-alert err" role="status"><strong>Needs reassignment:</strong> every team was cancelled and none completed.</p> }
              @if (i.result.responseState === 'awaiting_allocation') { <p class="il-alert warn" role="status"><strong>Awaiting allocation:</strong> a help request has not been allocated yet.</p> }
              <section class="il-card" aria-labelledby="pt-h">
                <h3 id="pt-h" class="il-h3">Teams ({{ i.result.assignmentSummary?.length || 0 }})</h3>
                @if (!i.result.assignmentSummary?.length) { <p class="il-muted">No team dispatched yet. Open the incident to dispatch one.</p> }
                <ul class="il-list">@for (a of i.result.assignmentSummary; track a.assignmentId) {
                  <li><strong>{{ a.agencyName }}</strong> — <il-status [value]="a.state" [label]="asl[a.state] || a.state" /> · lead {{ a.leadDisplayName }} · {{ a.memberCount }} member{{ a.memberCount === 1 ? '' : 's' }}
                    <br /><small>{{ a.task }} · updated {{ a.lastUpdatedAt | date:'short' }}</small></li> }</ul>
              </section>
            } @else { <section class="il-card"><p class="il-muted">Select an incident to see its summary.</p></section> }
          </div>
        </section>
      }

      @if (tab() === 'settings') {
        <section role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
          <section class="il-card" aria-labelledby="gw-h">
            <h2 id="gw-h">Grouping windows</h2>
            <p class="il-muted">Reports are only <em>suggested</em> as the same event when they fall inside these windows and agree on category. Nothing merges automatically.</p>
            <table class="il-table">
              <thead><tr><th scope="col">Category</th><th scope="col">Max distance (m)</th><th scope="col">Max time apart (minutes)</th></tr></thead>
              <tbody>
                @for (w of windows(); track w.category; let i = $index) {
                  <tr><td>{{ cat(w.category) }}</td>
                    <td><input class="il-input" type="number" min="5" max="5000" [attr.aria-label]="'Max distance for ' + cat(w.category)" [name]="'d' + i" [(ngModel)]="w.maxDistanceM" /></td>
                    <td><input class="il-input" type="number" min="5" [attr.aria-label]="'Max minutes for ' + cat(w.category)" [name]="'t' + i" [(ngModel)]="w.maxMinutes" /></td></tr>
                }
              </tbody>
            </table>
            <div style="margin-top:10px"><button type="button" class="il-btn" [disabled]="saving()" (click)="savePolicy()">Save windows</button>
              @if (saved()) { <span class="il-muted" role="status"> Saved.</span> }</div>
          </section>
          <section class="il-card" aria-labelledby="vs-h">
            <h2 id="vs-h">Image analysis</h2>
            <dl class="il-kv">
              <dt>Cloud Vision</dt><dd>{{ visionConfigured() ? 'Configured (server-side scope)' : 'Not configured — integration blocker until a Vision credential scope is attached' }}</dd>
              <dt>Fixture mode</dt><dd>{{ fixture() ? 'ON — canned local annotations, labelled FIXTURE everywhere' : 'Off' }}</dd>
            </dl>
            <button type="button" class="il-btn ghost sm" style="margin-top:8px" (click)="toggleFixture()">{{ fixture() ? 'Turn fixture mode off' : 'Turn fixture mode on (local development only)' }}</button>
          </section>
        </section>
      }
    </div>
  `,
})
export class ControlRoomComponent implements OnInit {
  protected readonly kindLabel: Record<string, string> = REVIEW_KIND_LABEL;
  protected readonly kindTone: Record<string, string> = REVIEW_KIND_TONE;
  protected readonly rTitle = (r: any) => reportTitle(r);
  protected readonly iTitle = incidentTitle;
  protected readonly closure = closureOutcome;
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly tabs: { key: Tab; label: string }[] = [{ key: 'pulse', label: 'Pulse' }, { key: 'queue', label: 'Complaints' }, { key: 'incidents', label: 'Incidents' }, { key: 'settings', label: 'Settings' }];
  protected readonly tab = signal<Tab>((sessionStorage.getItem('il-cr-tab') as Tab) || (IL_MODE ? 'pulse' : 'queue'));
  protected readonly categories = CATEGORIES;
  protected readonly ps = PROCESSING_STATES;
  protected readonly psKeys = Object.keys(PROCESSING_STATES);
  protected readonly rs = RESPONSE_STATES;
  protected readonly cat = categoryLabel;
  protected readonly src = sourceLabel;
  protected readonly reports = signal<any[]>([]);
  protected readonly incidents = signal<any[]>([]);
  protected readonly windows = signal<any[]>([]);
  protected readonly visionConfigured = signal(false);
  protected readonly fixture = signal(false);
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly qSearch = signal('');
  protected readonly fState = signal(''); protected readonly fCat = signal('');
  protected readonly fUngrouped = signal(true); protected readonly fUrgent = signal(false);

  protected readonly queue = computed(() => this.reports().filter(r =>
    matchesEvidence(this.qSearch(), r, this.rTitle(r), this.cat(r.result?.assessment?.suggestedCategory || r.spec.categoryHint)) &&
    (!this.fState() || r._ps === this.fState()) &&
    (!this.fCat() || (r.result?.assessment?.suggestedCategory || r.spec.categoryHint) === this.fCat()) &&
    (!this.fUngrouped() || !r.spec.incidentId) && (!this.fUrgent() || r.result?.assessment?.urgencyHint)));
  protected readonly markers = computed<MapMarker[]>(() => this.queue().map(r => ({ id: r.id, lat: r.spec.latitude, lng: r.spec.longitude,
    label: this.rTitle(r), detail: `${r.name} · ${REVIEW_KIND_LABEL[r._kind as keyof typeof REVIEW_KIND_LABEL]}` })));
  protected readonly asl = ASSIGNMENT_STATES;
  protected readonly next = incidentNextAction;
  protected readonly iSearch = signal('');
  protected readonly iFilter = signal<'open' | 'attention' | 'all'>('open');
  protected readonly iFilters = [{ key: 'open' as const, label: 'Open' }, { key: 'attention' as const, label: 'Needs attention' }, { key: 'all' as const, label: 'All incl. closed' }];
  protected readonly selId = signal('');
  protected readonly shownIncidents = computed(() => {
    const q = this.iSearch().trim().toLowerCase(), f = this.iFilter();
    return this.incidents().filter(i =>
      (f === 'all' || (f === 'open' && !i.result?.closed) || (f === 'attention' && ['needs_reassignment', 'awaiting_allocation', 'under_review'].includes(i.result?.responseState))) &&
      (!q || [i.name, this.iTitle(i), i.spec?.summary, i.spec?.jurisdiction].some(x => (x ?? '').toLowerCase().includes(q))));
  });
  protected readonly sel = computed(() => this.shownIncidents().find(i => i.id === this.selId()) ?? this.shownIncidents()[0] ?? null);
  protected readonly stats = computed(() => {
    const inc = this.incidents(), open = inc.filter(i => !i.result?.closed);
    return {
      open: open.length,
      awaiting: this.reports().filter(r => !r.spec.incidentId).length,
      teams: open.reduce((n, i) => n + (i.result?.assignmentSummary ?? []).filter((a: any) => isActiveAssignment(a.state)).length, 0),
      requests: open.reduce((n, i) => n + (i.result?.assistanceRequests ?? []).filter((x: any) => x.state === 'pending').length, 0),
    };
  });
  protected priLabel(p: string): string { return ({ P1: 'Urgent', P2: 'High', P3: 'Normal', P4: 'Low' } as Record<string, string>)[p] ?? p; }
  protected hasCompleted(i: any): boolean { return (i?.result?.assignmentSummary ?? []).some((a: any) => a.state === 'completed'); }
  protected readonly attention = computed(() => this.incidents().filter(i => ['needs_reassignment', 'awaiting_allocation'].includes(i.result?.responseState)).length);

  ngOnInit(): void { this.load(); }

  load(): void {
    this.error.set('');
    this.svc.reports().subscribe({
      next: rows => this.reports.set((rows ?? []).map(r => ({ ...r, _ps: processingState(r), _kind: reviewKind(r) }))
                                     .sort((a, b) => +(b.result?.assessment?.urgencyHint ?? 0) - +(a.result?.assessment?.urgencyHint ?? 0) || b.spec.receivedAt.localeCompare(a.spec.receivedAt))),
      error: e => this.error.set(extractErrorMessage(e) || 'Reports could not be loaded — control-room access is required.'),
    });
    this.svc.incidents().subscribe({ next: rows => this.incidents.set((rows ?? []).sort((a, b) => (a.result?.closed ? 1 : 0) - (b.result?.closed ? 1 : 0) || b.createdAt.localeCompare(a.createdAt))) });
    this.svc.groupingPolicy().subscribe({ next: s => { this.windows.set((s?.groupingWindows ?? []).map((w: any) => ({ ...w }))); this.fixture.set(!!s?.visionFixtureMode); this.visionConfigured.set(!!s?.visionScopeId); } });
  }

  protected tabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = this.tabs.findIndex(t => t.key === this.tab());
    const next = this.tabs[(i + (e.key === 'ArrowRight' ? 1 : this.tabs.length - 1)) % this.tabs.length].key;
    this.tab.set(next); sessionStorage.setItem('il-cr-tab', next);
    queueMicrotask(() => document.getElementById('tab-' + next)?.focus());
  }
  protected remember(t: Tab): void { try { sessionStorage.setItem('il-cr-tab', t); } catch { /* optional */ } }
  protected openReport(id: string): void { this.router.navigate(['reports', id], { relativeTo: this.route }); }
  protected openIncident(id: string): void { this.router.navigate(['incidents', id], { relativeTo: this.route }); }

  protected savePolicy(): void {
    this.saving.set(true); this.saved.set(false);
    this.svc.saveGroupingPolicy(this.windows().map(w => ({ category: w.category, maxDistanceM: +w.maxDistanceM, maxMinutes: +w.maxMinutes }))).subscribe({
      next: () => { this.saving.set(false); this.saved.set(true); },
      error: e => { this.saving.set(false); this.error.set(extractErrorMessage(e) || 'Windows could not be saved.'); },
    });
  }
  protected toggleFixture(): void {
    this.svc.visionSettings({ visionFixtureMode: !this.fixture() }).subscribe({
      next: () => this.fixture.update(v => !v), error: (e: any) => this.error.set(extractErrorMessage(e) || 'Could not change fixture mode.'),
    });
  }
}
