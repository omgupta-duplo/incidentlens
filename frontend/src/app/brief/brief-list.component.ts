import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { IncidentLensService, newRequestId } from '../incidentlens.service';
import { briefDisplay } from '../util';
import { LocalArea, localAreaRequest, localAreaLabel } from './brief-local';

/** Situation Brief: ask about a real event → a cited timeline, affected areas, rumour checks and travel feasibility. */
@Component({
  selector: 'il-brief-list',
  imports: [DatePipe, FormsModule],
  styleUrl: './brief.scss',
  template: `
    <div class="il-page brief-page brief-list-page">
      <header class="il-head"><div class="il-grow"><h1>Situation brief</h1>
        <p class="il-sub">Explore reported conditions — a timeline from public sources with links, the affected areas,
          whether rumours hold up, and whether a trip looks feasible. Source and provider details are recorded in each brief.</p></div></header>
      <p class="il-alert warn" role="note"><strong>Not an official advisory.</strong> Always follow local authorities and emergency services.
        Check each statement’s recorded sources and uncertainty before relying on it.</p>
      <form class="il-card" (ngSubmit)="create()" aria-labelledby="bq-h">
        <h2 id="bq-h">What do you want to know?</h2>
        <label class="il-field"><span>Event (required)</span>
          <input class="il-input" name="q" required maxlength="200" [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="e.g. flood in Kathmandu valley" /></label>
        <label class="il-field"><span>Place (optional, helps the map)</span>
          <input class="il-input" name="p" maxlength="120" [ngModel]="place()" (ngModelChange)="place.set($event)" placeholder="e.g. Kathmandu, Nepal" /></label>
        <fieldset class="brief-local-selector"><legend>Local incident context (optional)</legend>
          <label class="brief-local-toggle"><input type="checkbox" name="local" [ngModel]="includeLocal()" (ngModelChange)="includeLocal.set($event)" /> Include a coarse area snapshot</label>
          <p class="il-muted">Adds privacy-limited counts from this workspace, separately from public news. Reported events are not independently verified.</p>
          @if (includeLocal()) {
            <p class="il-muted">Enter a point in the area. Only its fixed 0.25° tile is selected. No device location or map lookup is used.</p>
            <div class="brief-local-fields">
              <label class="il-field"><span>Area latitude</span><input class="il-input" name="localLat" inputmode="decimal" required [ngModel]="localLat()" (ngModelChange)="localLat.set($event)" placeholder="e.g. 18.57" /></label>
              <label class="il-field"><span>Area longitude</span><input class="il-input" name="localLng" inputmode="decimal" required [ngModel]="localLng()" (ngModelChange)="localLng.set($event)" placeholder="e.g. 73.97" /></label>
              <label class="il-field"><span>From (UTC date)</span><input class="il-input" type="date" name="localFrom" required [ngModel]="localFrom()" (ngModelChange)="localFrom.set($event)" /></label>
              <label class="il-field"><span>Through (UTC date)</span><input class="il-input" type="date" name="localThrough" required [ngModel]="localThrough()" (ngModelChange)="localThrough.set($event)" /></label>
            </div>
            <p class="il-muted" aria-live="polite">{{ localPreview() }}</p>
            <p class="il-muted">1–7 calendar days within the last 30 days. Counts below five are hidden; remaining counts are bands of five. News may describe the same events and is not added to these counts.</p>
          }
        </fieldset>
        <label class="il-field"><span>Rumours or claims to check (optional, one per line, up to 5)</span>
          <textarea class="il-input" name="c" rows="3" [ngModel]="claims()" (ngModelChange)="claims.set($event)" placeholder="e.g. The Bagmati bridge collapsed"></textarea></label>
        <fieldset class="il-field il-grid3"><legend style="font-weight:600">Travel check (optional)</legend>
          <label class="il-field"><span>From</span><input class="il-input" name="tf" maxlength="120" [ngModel]="from()" (ngModelChange)="from.set($event)" placeholder="Pokhara, Nepal" /></label>
          <label class="il-field"><span>To</span><input class="il-input" name="tt" maxlength="120" [ngModel]="to()" (ngModelChange)="to.set($event)" placeholder="Kathmandu, Nepal" /></label>
          <label class="il-field"><span>When</span><input class="il-input" name="td" maxlength="40" [ngModel]="date()" (ngModelChange)="date.set($event)" placeholder="tomorrow morning" /></label>
        </fieldset>
        @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
        <button type="submit" class="il-btn" [disabled]="busy() || query().trim().length < 3">{{ busy() ? 'Starting…' : 'Build brief' }}</button>
      </form>
      <section class="il-card" aria-labelledby="bl-h">
        <h2 id="bl-h">Recent briefs</h2>
        @if (listError()) {
          <div class="il-alert err" role="alert"><p style="margin:0">Briefs could not be loaded{{ rows().length ? ' — showing the last list we had' : '' }}.</p>
            <button type="button" class="il-btn ghost" (click)="loadList()" [disabled]="listLoading()">{{ listLoading() ? 'Retrying…' : 'Retry' }}</button></div>
        } @else if (listLoading() && !rows().length) { <p class="il-muted" role="status">Loading briefs…</p>
        } @else if (!rows().length) { <p class="il-muted">No briefs yet.</p> }
        <ul class="il-list">
          @for (b of rows(); track b.id) {
            <li><button type="button" class="il-link" (click)="open(b.id)">{{ b.result?.headline || b.query }}</button>
              <br /><small class="il-muted">{{ b.createdAt | date:'short' }} · {{ stateText(b) }}
                @if (b.result?.provider === 'fixture') { · <span class="il-badge fixture">SIMULATED</span> }</small></li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class BriefListComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly rows = signal<any[]>([]);
  protected readonly listLoading = signal(true); protected readonly listError = signal(false);
  protected readonly query = signal(''); protected readonly place = signal(''); protected readonly claims = signal('');
  protected readonly from = signal(''); protected readonly to = signal(''); protected readonly date = signal('');
  protected readonly busy = signal(false); protected readonly error = signal('');
  protected readonly includeLocal = signal(false);
  protected readonly localLat = signal(''); protected readonly localLng = signal('');
  protected readonly localFrom = signal(new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  protected readonly localThrough = signal(new Date().toISOString().slice(0, 10));
  protected readonly localPreview = computed(() => {
    try { return 'Selected tile: ' + localAreaLabel(localAreaRequest(this.localLat(), this.localLng(), this.localFrom(), this.localThrough())); }
    catch (e) { return (e as Error).message; }
  });
  private requestId = newRequestId();

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('q')) this.query.set(q.get('q')!.slice(0, 200));
    if (q.get('place')) this.place.set(q.get('place')!.slice(0, 120));
    this.loadList();
  }
  /** Loading, empty, loaded and failed are distinct states; a failed refresh keeps the rows already shown. */
  protected loadList(): void {
    this.listLoading.set(true);
    this.svc.briefs().subscribe({
      next: r => { this.rows.set(r ?? []); this.listError.set(false); this.listLoading.set(false); },
      error: () => { this.listError.set(true); this.listLoading.set(false); },
    });
  }
  protected stateText(b: any): string {
    return briefDisplay(b).label;
  }
  protected create(): void {
    if (this.busy() || this.query().trim().length < 3) return;
    const claims = this.claims().split('\n').map(x => x.trim()).filter(Boolean).slice(0, 5);
    const travel = this.from().trim() || this.to().trim() ? { from: this.from().trim(), to: this.to().trim(), date: this.date().trim() || null } : null;
    let localArea: LocalArea | undefined;
    try { if (this.includeLocal()) localArea = localAreaRequest(this.localLat(), this.localLng(), this.localFrom(), this.localThrough()); }
    catch (e) { this.error.set((e as Error).message); return; }
    this.busy.set(true); this.error.set('');
    this.svc.createBrief(this.asAction(), { query: this.query().trim(), place: this.place().trim() || null, claims, travel, localArea, clientRequestId: this.requestId,
                           incidentId: this.route.snapshot.queryParamMap.get('incident') }).subscribe({
      next: b => { this.requestId = newRequestId(); this.open(b.id); },
      error: e => { this.busy.set(false); this.error.set(extractErrorMessage(e) || 'The brief could not be started.'); },
    });
  }
  /** The mount this list is under decides which IncidentLens action authorises the create. */
  private asAction(): 'report' | 'triage' | 'respond' {
    const u = this.router.url;
    return /incidentlens-incidents/.test(u) ? 'triage' : /incidentlens-inbox/.test(u) ? 'respond' : 'report';
  }
  protected open(id: string): void { this.router.navigate([id], { relativeTo: this.route }); }
}
