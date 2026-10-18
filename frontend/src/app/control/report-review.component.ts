import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, interval } from 'rxjs';
import { reportPrefill, proposedPicks, proposedTargets } from './report-prefill';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { CATEGORIES, IncidentLensService, categoryLabel, newRequestId } from '../incidentlens.service';
import { AuthImageComponent } from '../shared/auth-image.component';
import { IL_MODE } from '../shell/il-mode';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';
import { StatusChipComponent } from '../shared/status-chip.component';
import { REVIEW_KIND_LABEL, REVIEW_KIND_TONE, matchStrength, processingState, reportTitle, reviewKind, sourceLabel } from '../util';

/**
 * Evidence review for one report. Raw Vision annotations (provenance) and the model's interpretation are shown
 * as two separate blocks; grouping candidates come with reasons + uncertainty; the admin decides membership.
 */
@Component({
  selector: 'il-report-review',
  imports: [DatePipe, DecimalPipe, FormsModule, AuthImageComponent, GeoMapComponent, StatusChipComponent],
  styleUrl: './control.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><button type="button" class="il-link" (click)="back()">← Control room</button></header>
      @if (r(); as r) {
        <header class="il-head">
          <div class="il-grow"><h1>{{ title() }}</h1>
            <p class="il-sub">Ref <span class="il-mono" data-ref>{{ r.name }}</span> · received {{ r.spec.receivedAt | date:'medium' }} · hint: {{ cat(r.spec.categoryHint) }} · {{ src(r.spec.locationSource) }}
              @if (r.spec.gpsAccuracyM) { (±{{ r.spec.gpsAccuracyM }} m) } @if (r.spec.pinAdjusted) { · pin moved {{ r.spec.pinOffsetM | number:'1.0-0' }} m from GPS fix }</p></div>
          <il-status [value]="kindTone[kind()]" [label]="kindLabel[kind()]" />
          @if (!ilMode) { <button type="button" class="il-btn ghost sm" [disabled]="tracking()" (click)="track()">Ask agent</button> }
        </header>
        @if (r.faults?.length) { <p class="il-alert warn" role="status">Assessment note: {{ r.faults[0] }}</p> }
        @if (kind() === 'uncertain') { <p class="il-alert warn" role="status"><strong>AI was uncertain.</strong> The assessment finished, but flagged
          {{ reviewReasons() || 'low confidence' }}. Look at the photo yourself before grouping or dispatching — this is not a processing error.</p> }
        @if (kind() === 'failed') { <p class="il-alert err" role="status"><strong>AI assessment unavailable.</strong> Processing failed or produced no valid
          interpretation, so there is nothing to rely on. Review the photo directly; triage is never blocked.
          {{ ilMode ? 'A platform administrator can review the assessment ticket if needed.' : 'Ask agent shows what happened.' }}</p> }
        <p class="il-next" role="note"><strong>Next step:</strong> {{ r.spec.incidentId ? 'This report is in an incident — open it to dispatch or follow the response.' : kind() === 'pending' ? 'Wait for the assessment, or review the photo now.' : 'Decide whether it is a real event, then create an incident (below) — optionally with matching reports.' }}</p>
        <div class="il-grid">
          <section class="il-card" aria-labelledby="ph-h"><h2 id="ph-h">Photo</h2>
            <il-auth-image [src]="photoUrl()" [alt]="'Reporter photo for ' + r.name" />
            @if (r.spec.captureSource === 'upload') {
              <p class="il-alert info" role="note" style="margin-top:10px"><strong>Uploaded photo</strong> — chosen from the reporter's device, not taken in the app.
                @if (r.spec.exifTakenAt) { File says it was taken {{ r.spec.exifTakenAt | date:'medium' }}. } @else { The file has no capture time. }
                @if (r.spec.exifLatitude != null) { File location {{ r.spec.exifLatitude | number:'1.4-4' }}, {{ r.spec.exifLongitude | number:'1.4-4' }}. }</p> }
            @if (r.result?.vision?.web; as w) {
              @if (w.pagesWithMatches || w.fullMatches) {
                <div class="il-alert warn" role="note" style="margin-top:10px"><strong>Seen online before:</strong> this image already appears on
                  {{ w.pagesWithMatches || w.fullMatches }} web page{{ (w.pagesWithMatches || w.fullMatches) === 1 ? '' : 's' }}
                  ({{ w.fullMatches }} exact, {{ w.partialMatches }} partial match{{ w.partialMatches === 1 ? '' : 'es' }}). It may be old or from elsewhere —
                  check before relying on it. Not proof either way.
                  @if (w.pages?.length) { <ul style="margin:6px 0 0">@for (pg of w.pages; track pg.url) {
                    <li><a [href]="pg.url" target="_blank" rel="noopener noreferrer">{{ pg.title || pg.url }}</a></li> }</ul> }</div>
              } @else if (r.result?.vision?.status === 'ok') {
                <p class="il-muted" style="margin-top:10px">Web check: this image was not found on other web pages.</p>
              }
            }
            @if (r.spec.note) { <p style="margin:10px 0 0"><strong>Reporter note:</strong> {{ r.spec.note }}</p> }
            @if (r.result?.reuseMatches?.length) { <p class="il-alert info" role="note" style="margin-top:10px">The same photo bytes were submitted {{ r.result.reuseMatches.length }} other time(s). This is not independent corroboration — and not, by itself, evidence of bad intent.</p> }
          </section>
          <section class="il-card" aria-labelledby="loc-h"><h2 id="loc-h">Location</h2>
            <il-geo-map [markers]="locMarkers()" ariaLabel="Report location and its GPS fix" listLabel="Report location" />
          </section>
        </div>
        <div class="il-blocks">
          <section class="il-card il-prov model" aria-labelledby="mi-h">
            <h2 id="mi-h">Model interpretation <small class="il-muted">— advisory</small></h2>
            @if (r.result?.assessment; as a) {
              <p>{{ a.observations }}</p>
              <dl class="il-kv">
                <dt>Suggested category</dt><dd>{{ cat(a.suggestedCategory) }}</dd>
                <dt>Uncertainty</dt><dd><strong>{{ a.uncertainty }}</strong> — {{ a.uncertaintyNote }}</dd>
                <dt>Urgency cue</dt><dd>{{ a.urgencyHint ? 'Yes — review promptly (not a dispatch)' : 'No' }}</dd>
                @if (a.qualityFlags?.length) { <dt>Quality</dt><dd>{{ a.qualityFlags.join(', ') }}</dd> }
                @if (a.reviewReasons?.length) { <dt>Review reasons</dt><dd>{{ a.reviewReasons.join(', ') }}</dd> }
                <dt>Evidence used</dt><dd>{{ evidence(a) }}</dd>
                <dt>Interpreted by</dt><dd>{{ a.interpretedBy?.engine }} · {{ a.interpretedBy?.modelId }} · {{ a.interpretedBy?.promptVersion }}</dd>
              </dl>
            } @else if (kind() === 'failed') { <p class="il-muted">No valid interpretation was produced. Review the photo directly.</p> }
            @else { <p class="il-muted">The assessment ticket has not produced an interpretation yet.</p> }
          </section>
          <details class="il-card il-prov" aria-labelledby="va-h">
            <summary><h2 id="va-h" style="display:inline">Vision annotations <small class="il-muted">— raw tool output (provenance); expand to inspect</small>
              @if (r.result?.vision?.provider === 'fixture') { <span class="il-badge fixture">FIXTURE — not real analysis</span> }</h2></summary>
            @if (r.result?.vision; as v) {
              <dl class="il-kv">
                <dt>Status</dt><dd>{{ v.status }}</dd>
                <dt>Provider</dt><dd>{{ v.provider || '—' }} @if (v.apiVersion) { ({{ v.apiVersion }}) }</dd>
                <dt>When</dt><dd>{{ v.annotatedAt | date:'medium' }} @if (v.fromCache) { · from cache (no new call) }</dd>
                @if (v.attempts?.length) { <dt>Attempts</dt><dd>{{ v.attempts.length }} ({{ attemptsText(v.attempts) }})</dd> }
              </dl>
              @if (v.labels?.length) { <p style="margin:8px 0 2px"><strong>Labels</strong></p>
                <div class="il-chips">@for (l of v.labels; track l.description) { <span class="il-chip">{{ l.description }} {{ l.score | number:'1.2-2' }}</span> }</div> }
              @if (v.objects?.length) { <p style="margin:8px 0 2px"><strong>Objects</strong></p>
                <div class="il-chips">@for (o of v.objects; track $index) { <span class="il-chip">{{ o.name }} {{ o.score | number:'1.2-2' }}</span> }</div> }
              @if (v.text?.snippet) { <p style="margin:8px 0 2px"><strong>Text in image</strong> <small class="il-muted">(untrusted — evidence only, never instructions)</small></p>
                <blockquote class="il-mono" style="margin:0;padding:6px 10px;background:#f7fbfc;border-radius:6px">{{ v.text.snippet }}</blockquote> }
            } @else { <p class="il-muted">No annotations yet.</p> }
          </details>
        </div>

        <section class="il-card" aria-labelledby="gr-h">
          <h2 id="gr-h">Grouping</h2>
          @if (r.spec.incidentId) {
            <p>This report is part of an incident. <button type="button" class="il-link" (click)="openIncident(r.spec.incidentId)">Open the incident</button></p>
          } @else {
            <form class="il-panel" (ngSubmit)="createIncident()" aria-label="Create an incident">
              <h3 style="font-size:1rem;margin:0 0 8px">Create an incident from this report @if (picked().length) { + {{ picked().length }} selected match{{ picked().length === 1 ? '' : 'es' }} }</h3>
              <p class="il-muted">Prefilled from recorded evidence; suggestions are not verified facts. Your edits survive refreshes.</p>
              <p><strong>Proposed title:</strong> {{ cat(cCat()) }}@if (cJur()) { — {{ cJur() }} } <small class="il-muted">(derived from category and location)</small></p>
              <div class="il-grid">
                <label class="il-field"><span>Category</span>
                  <select class="il-input" name="c" [ngModel]="cCat()" (ngModelChange)="edit('cCat', $event)">@for (c of categories; track c.value) { <option [value]="c.value">{{ c.label }}</option> }</select></label>
                <label class="il-field"><span>Priority</span>
                  <select class="il-input" name="p" [ngModel]="cPri()" (ngModelChange)="edit('cPri', $event)">@for (p of ['P1','P2','P3','P4']; track p) { <option [value]="p">{{ p }}</option> }</select></label>
              </div>
              <label class="il-field"><span>Jurisdiction / area</span><input class="il-input" name="j" required [ngModel]="cJur()" (ngModelChange)="edit('cJur', $event)" /></label>
              <p class="il-muted">{{ prefill().locationSource }} · {{ prefill().prioritySource }}</p>
              <label class="il-field"><span>Summary</span><input class="il-input" name="s" [ngModel]="cSum()" (ngModelChange)="edit('cSum', $event)" /></label>
              <p class="il-muted">{{ prefill().summarySource }}. Uncertainty: {{ r.result?.assessment?.uncertainty || 'unknown' }}.</p>
              <p class="il-muted">Suggested services (advisory): @for (s of prefill().services; track $index) { {{ s.service }} — {{ s.reason || 'reason unknown' }}; } @empty { unknown. }</p>
              <label class="il-field"><span>Reason for this grouping (audited)</span><input class="il-input" name="r" required [ngModel]="cReason()" (ngModelChange)="edit('cReason', $event)" /></label>
              @if (joinTargets().length) {
                <label class="il-field"><span>Existing same-event incident</span><select class="il-input" name="target" [ngModel]="targetId()" (ngModelChange)="targetId.set($event)">
                  <option value="">Create a new incident</option>
                  @for (c of joinTargets(); track c.incidentId) { <option [value]="c.incidentId">Join existing incident · matched report {{ c.reportName }} · {{ c.distanceM }} m / {{ c.minutesApart }} min</option> }
                </select></label>
                <p class="il-muted">Joining adds the selected complaints and preserves existing triage/history. Check the candidate reasons below; no records move from other incidents.</p>
              }
              @if (formError()) { <p class="il-alert err" role="alert">{{ formError() }}</p> }
              <button type="submit" class="il-btn" [disabled]="busy() || candsLoading() || !cJur().trim() || !cReason().trim()">{{ targetId() ? 'Add selected complaints to existing incident' : 'Create one incident with selected complaints' }}</button>
            </form>
            <h3 style="font-size:1rem;margin:14px 0 4px">Possible matches ({{ cands().length }})</h3>
            <p class="il-muted" style="margin-top:0">Strong same-event suggestions are selected automatically for your review. Untick wrong matches; uncertain reports stay unselected. Tick reports that describe the <em>same event</em> to include them above. <strong>Similarity is a heuristic</strong>
              built from distance, time gap, category and shared photo labels/words — it is <em>not</em> a probability that the reports match and
              <em>not</em> independent corroboration. You decide.</p>
            @if (candsError()) { <p class="il-alert err" role="alert">Possible matches could not be loaded — this does not mean there are none.
                <button type="button" class="il-btn ghost" (click)="loadCands()">Retry</button></p>
            } @else if (!cands().length) { <p class="il-muted">No candidates within this category's window.</p> }
            @else {
              <div style="max-width:100%;overflow-x:auto" tabindex="0" role="region" aria-label="Possible matches table; scroll horizontally for all columns"><table class="il-table">
                <caption class="sr-only">Possible same-event reports</caption>
                <thead><tr><th scope="col"><span class="sr-only">Select</span></th><th scope="col">Report</th><th scope="col">Distance / time</th><th scope="col">Heuristic similarity</th><th scope="col">Why suggested</th></tr></thead>
                <tbody>
                  @for (c of cands(); track c.reportId) {
                    <tr [class.sel]="picked().includes(c.reportId)">
                      <td>@if (c.kind === 'same_event' && !c.incidentId) {
                        <input type="checkbox" [attr.aria-label]="'Include ' + c.reportName" [checked]="picked().includes(c.reportId)" (change)="togglePick(c.reportId)" /> }</td>
                      <td>{{ c.reportName }} @if (c.kind === 'link_suggestion') { <br /><span class="il-chip">in another incident</span> }</td>
                      <td>{{ c.distanceM }} m · {{ c.minutesApart }} min</td>
                      <td>{{ strength(c.score) }} overlap<br /><small class="il-muted">heuristic score {{ c.score | number:'1.2-2' }} — not a probability</small></td>
                      <td><ul style="margin:0;padding-left:18px">@for (x of c.reasons; track x) { <li>{{ x }}</li> }</ul></td>
                    </tr>
                  }
                </tbody>
              </table></div>
            }
          }
        </section>
      } @else if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      @else { <p class="il-muted" aria-live="polite">Loading…</p> }
    </div>
  `,
})
export class ReportReviewComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly categories = CATEGORIES;
  protected readonly cat = categoryLabel;
  protected readonly src = sourceLabel;
  protected readonly r = signal<any>(null);
  protected readonly candsLoading = signal(false);
  protected readonly cands = signal<any[]>([]); protected readonly candsError = signal(false);
  protected readonly picked = signal<string[]>([]);
  protected readonly error = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly tracking = signal(false);
  protected readonly cCat = signal('other_uncertain'); protected readonly cPri = signal('P3');
  protected readonly cJur = signal(''); protected readonly cSum = signal(''); protected readonly cReason = signal('');
  // Read the id live: Angular reuses this component when only the :id changes (in-app navigation between records),
  // so a value captured once would keep showing the previous record.
  private get id(): string { return this.route.snapshot.params['id']; }
  private lastId = '';
  private requestId = newRequestId();
  private readonly edited = new Set<string>();
  private readonly choices = new Map<string, boolean>();
  private submittedBody: any = null;
  protected readonly targetId = signal('');
  protected readonly prefill = computed(() => reportPrefill(this.r()));
  protected readonly joinTargets = computed(() => proposedTargets(this.cands()));
  private poll?: Subscription;

  protected readonly ps = computed(() => processingState(this.r()));
  protected readonly kind = computed(() => reviewKind(this.r()));
  protected readonly kindLabel = REVIEW_KIND_LABEL;
  protected readonly kindTone = REVIEW_KIND_TONE;
  protected readonly strength = matchStrength;
  protected readonly title = computed(() => reportTitle(this.r()));
  protected readonly reviewReasons = computed(() => (this.r()?.result?.assessment?.reviewReasons ?? []).map((x: string) => x.replace(/_/g, ' ')).join(', '));
  protected readonly locMarkers = computed<MapMarker[]>(() => {
    const s = this.r()?.spec; if (!s) return [];
    const m: MapMarker[] = [{ id: 'pin', lat: s.latitude, lng: s.longitude, label: 'Confirmed pin', detail: sourceLabel(s.locationSource) }];
    if (s.gpsLatitude != null && s.pinAdjusted) m.push({ id: 'gps', lat: s.gpsLatitude, lng: s.gpsLongitude, label: 'Original GPS fix', detail: `±${s.gpsAccuracyM ?? '?'} m` });
    return m;
  });
  protected photoUrl = () => this.svc.reportPhotoUrl(this.id);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(p => {
      const id = p.get('id') ?? '';
      if (this.lastId && id !== this.lastId) { this.resetForNewId(); this.load(); this.startPoll(); }
      this.lastId = id;
    });
  }

  ngOnInit(): void {
    this.load();
    this.startPoll();
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }
  private startPoll(): void {
    this.poll?.unsubscribe();
    this.poll = interval(5000).subscribe(() => { if (['received', 'queued', 'analyzing'].includes(this.ps())) this.load(); else this.poll?.unsubscribe(); });
  }
  private resetForNewId(): void {
    this.requestId = newRequestId(); this.submittedBody = null; this.edited.clear(); this.choices.clear(); this.targetId.set('');
    this.cCat.set('other_uncertain'); this.cPri.set('P3'); this.cJur.set(''); this.cSum.set(''); this.cReason.set('');
    this.r.set(null); this.candsError.set(false); this.candsLoading.set(false); this.cands.set([]); this.picked.set([]); this.error.set(''); this.formError.set(''); this.busy.set(false);
  }
  protected edit(field: 'cCat' | 'cPri' | 'cJur' | 'cSum' | 'cReason', value: string): void {
    this.edited.add(field); this[field].set(value);
  }
  private load(): void {
    const id = this.id;
    this.svc.report(id).subscribe({
      next: r => {
        if (id !== this.id) return;
        this.r.set(r); const p = reportPrefill(r);
        for (const [field, value] of Object.entries({ cCat: p.category, cPri: p.priority, cJur: p.jurisdiction, cSum: p.summary, cReason: p.reason })) {
          if (!this.edited.has(field)) this[field as 'cCat'].set(value);
        }
      },
      error: e => { if (id === this.id) this.error.set(extractErrorMessage(e) || 'Report not found.'); },
    });
    this.loadCands();
  }
  protected loadCands(): void {
    const id = this.id;
    this.candsLoading.set(true);
    this.svc.candidates(id).subscribe({ next: c => {
      if (id !== this.id) return;
      this.candsLoading.set(false); this.cands.set(c ?? []); this.picked.set(proposedPicks(c ?? [], this.choices)); this.candsError.set(false);
      if (this.targetId() && !proposedTargets(c ?? []).some(x => x.incidentId === this.targetId())) this.targetId.set('');
    }, error: () => { if (id === this.id) { this.candsLoading.set(false); this.candsError.set(true); } } });
  }
  protected attemptsText(a: any[]): string { return a.map(x => x.outcome + (x.possiblyBilled ? '*' : '')).join(', ') + (a.some(x => x.possiblyBilled) ? ' — * possibly billed' : ''); }
  protected evidence(a: any): string {
    const e = a.evidenceUsed ?? {}; const parts = [...(e.visionLabels ?? []), ...(e.visionObjects ?? [])];
    return (parts.length ? 'Vision: ' + parts.join(', ') + '. ' : 'No Vision annotations relied on. ') + (e.visualObservation ? 'Own observation: ' + e.visualObservation : '');
  }
  protected togglePick(id: string): void { this.choices.set(id, !this.picked().includes(id)); this.picked.update(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }
  protected createIncident(): void {
    if (this.busy() || this.candsLoading()) return;
    const id = this.id;
    const body = { reportIds: [id, ...this.picked()], category: this.cCat(), priority: this.cPri(), jurisdiction: this.cJur().trim(),
      summary: this.cSum().trim() || null, reason: this.cReason().trim(), targetIncidentId: this.targetId() || null };
    // An exact retry keeps its id; changed decisions are a new operation.
    if (this.submittedBody && JSON.stringify(body) !== JSON.stringify(this.submittedBody)) this.requestId = newRequestId();
    this.submittedBody = body;
    this.busy.set(true); this.formError.set('');
    this.svc.createIncident({ ...body, clientRequestId: this.requestId }).subscribe({
      next: inc => { if (id === this.id) this.openIncident(inc.id); },
      error: e => { if (id !== this.id) return; this.busy.set(false); this.formError.set(extractErrorMessage(e) || 'The incident could not be created.'); },
    });
  }
  protected openIncident(id: string): void { this.router.navigate(['../../incidents', id], { relativeTo: this.route }); }
  protected back(): void { this.router.navigate(['../..'], { relativeTo: this.route }); }
  // IncidentLens mode = a non-platform-admin user: the ticket page is a portal page they are routed away from, so the
  // Ask agent control is not offered there (platform admins keep it in the normal portal).
  protected readonly ilMode = IL_MODE;
  protected track(): void {
    if (IL_MODE) return;
    this.tracking.set(true);
    this.svc.ticketName(this.id).subscribe({
      next: name => { this.tracking.set(false); if (!name) return;
        const url = `/ai/service-desk/${this.svc.workspaceId()}/tickets/chat/${name}`;
        this.router.navigateByUrl(url).then(ok => { if (!ok) window.location.assign(url); }).catch(() => window.location.assign(url)); },
      error: () => this.tracking.set(false),
    });
  }
}
