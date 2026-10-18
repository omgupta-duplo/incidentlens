import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { BriefLocalComponent } from './brief-local.component';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, interval } from 'rxjs';
import { briefDisplay } from '../util';
import { IncidentLensService } from '../incidentlens.service';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';

const VERDICT: Record<string, string> = { supported: 'Supported', contradicted: 'Contradicted', outdated: 'Outdated', unverified: 'Unverified' };
const FEAS: Record<string, string> = { ok: 'Looks feasible', caution: 'Caution', avoid: 'Avoid for now', unknown: 'Not enough information' };

@Component({
  selector: 'il-brief-view',
  imports: [DatePipe, GeoMapComponent, BriefLocalComponent],
  styleUrl: './brief.scss',
  template: `
    <div class="il-page brief-page brief-detail-page">
      <header class="il-head"><button type="button" class="il-link" (click)="back()">← Situation briefs</button></header>
      @if (b(); as b) {
        <div class="brief-layout"><section class="brief-summary">
        <div class="brief-eyebrow">Situation brief</div>
        <header class="il-hero brief-cover">
          <div class="row"><span class="il-hero-state">{{ view().label }}</span>
            @if (simulated()) { <span class="il-badge fixture">SIMULATED — not real events</span> }
            @if (view().state === 'ready' && r()?.provider === 'gemini-grounded') { <span class="il-hero-state">Gemini + Google Search</span> }
            @if (view().state === 'ready' && r()?.provider === 'agent-research') { <span class="il-hero-state">Agent research · fetched sources</span> }
            <span class="il-grow"></span><span class="il-mono">{{ b.name }}</span></div>
          <h1>{{ r()?.headline || b.query }}</h1>
          <p class="il-hero-sub">{{ b.query }}@if (b.place) { · {{ b.place }} }</p>
          <div class="il-hero-foot"><span>@if (r()?.asOf) { As of {{ r().asOf | date:'medium' }} · } @else { Update time not recorded · } {{ view().citedEvents }} cited event{{ view().citedEvents === 1 ? '' : 's' }}
            @if (view().syntheticEntries) { · {{ view().syntheticEntries }} simulated entr{{ view().syntheticEntries === 1 ? 'y' : 'ies' }} (not cited) }
            @if (r()?.droppedUnsourced) { · {{ r().droppedUnsourced }} unsourced item{{ r().droppedUnsourced === 1 ? '' : 's' }} removed }</span></div>
        </header>
        <p class="il-alert warn" role="note"><strong>Not an official advisory.</strong> Follow local authorities and emergency services. {{ r()?.limits }}</p>
        @if (building()) { <p class="il-alert info" aria-live="polite">Gathering the picture. Searching public sources… You can leave this page and return later; research continues.</p> }
        @if (view().state === 'not_configured') { <p class="il-alert warn" role="alert"><strong>Not configured.</strong> Live search (Gemini with Google Search grounding)
            is not set up for this workspace, so no brief was produced — nothing below is a finding. Ask an administrator to configure it.</p> }
        @if (view().state === 'unavailable') { <p class="il-alert warn" role="alert"><strong>Unavailable.</strong> No public source could be searched or fetched,
            so no brief was produced{{ r()?.error ? ' — ' + r().error : '' }}. Nothing below is a finding.</p> }
        @if (r()?.provider === 'agent-research' && view().state === 'ready') { <p class="il-alert info" role="note">Written by the research agent from pages it fetched.
            Every event below quotes the fetched page; the wording, times and verdicts are the agent's reading of those pages.</p>
          @if (r()?.limitations?.length) { <ul class="il-list">@for (l of r().limitations; track $index) { <li class="il-muted">{{ l }}</li> }</ul> } }
        @if (view().state === 'failed') { <p class="il-alert err" role="alert">The brief could not be built{{ r()?.error ? ': ' + r().error : '' }}. Try again later or rephrase.</p> }
        @if (simulated()) { <p class="il-alert warn" role="note"><strong>Simulated demo brief.</strong> Built from fixture data without any live search —
            the timeline entries are synthetic, have no sources and are not real events.</p> }
        @if (view().state === 'unverified') { <p class="il-alert warn" role="note">This brief's source is not recorded — treat it as unverified.</p> }
        </section><section class="brief-reading">
        <il-brief-local [context]="b.localContext" />
        @if (hasContent()) {
          <nav class="brief-nav" aria-label="Brief sections">
            @for (item of tabs; track item.key) { <button type="button" [attr.aria-pressed]="tab() === item.key" (click)="tab.set(item.key)">{{ item.label }}</button> }
          </nav>
        }
        @if (hasContent() && tab() === 'overview') {
          <section aria-labelledby="summary-h"><h2 id="summary-h">At a glance</h2>
            @if (r()?.summary) { <p class="il-lead">{{ r().summary }}</p> }
            @else { <p class="il-muted">No summary was recorded.</p> }
            <div class="brief-gap"><span class="brief-eyebrow">What remains uncertain</span>
              <p>{{ r()?.limits || 'The available sources may be incomplete or out of date. This brief cannot establish that conditions are safe.' }}</p>
              @for (limit of r()?.limitations || []; track $index) { <p>{{ limit }}</p> }
            </div>
          </section>

        @if (r()?.claimChecks?.length) {
          <section class="il-card" aria-labelledby="cc-h"><h2 id="cc-h">Rumour check</h2>
            <ul class="il-claims">
              @for (c of r().claimChecks; track $index) {
                <li [attr.data-v]="c.verdict"><span class="il-verdict" [attr.data-v]="c.verdict">{{ verdict[c.verdict] || c.verdict }}</span>
                  <strong>{{ c.claim }}</strong><p>{{ c.evidence }}</p>
                  <small class="il-muted">@if (c.asOf) { As of {{ c.asOf }} · } @for (s of c.sources; track s.url) { <a [href]="safeUrl(s.url)" target="_blank" rel="noopener noreferrer">{{ s.domain || s.title }}</a> }
                    @if (!c.sources?.length) { no retrievable source }</small></li>
              }
            </ul>
          </section>
        }
        @if (r()?.travelAssessment; as t) {
          <section class="il-card" aria-labelledby="tv-h"><h2 id="tv-h">Travel: {{ b.travel?.from }} → {{ b.travel?.to }} @if (b.travel?.date) { · {{ b.travel.date }} }</h2>
            <p><span class="il-verdict" [attr.data-v]="'feas-' + t.feasibility">{{ feas[t.feasibility] || t.feasibility }}</span>
              @if (t.routeEtaMin != null) { · usual drive about {{ t.routeEtaMin }} min ({{ t.routeKm }} km, {{ r()?.provider === 'gemini-grounded' ? 'Google Routes now' : r()?.provider === 'fixture' ? 'simulated — fixture data' : 'source not recorded' }}) }</p>
            <ul class="il-list">@for (x of t.reasons; track $index) { <li>{{ x }}</li> }</ul>
            <small class="il-muted">@for (s of t.sources; track s.url) { <a [href]="safeUrl(s.url)" target="_blank" rel="noopener noreferrer">{{ s.domain || s.title }}</a> }</small>
          </section>
        }
        }
        <div class="brief-content">
          @if (hasContent() && tab() === 'timeline') {
          <section class="il-card" aria-labelledby="tl-h"><h2 id="tl-h">Timeline</h2>
            @if (!r()?.timeline?.length) { <p class="il-muted">{{ building() ? 'Collecting…' : view().state === 'not_configured' ? 'No timeline — live search is not configured.' : 'No sourced events.' }}</p> }
            <ol class="il-tl">
              @for (e of r()?.timeline || []; track $index) {
                <li><span class="il-tl-at">{{ e.at }}</span><p>@if (simulated() || e.synthetic) { <span class="il-badge fixture">SIMULATED</span> } {{ e.summary }}</p>
                  @if (simulated() || e.synthetic) { <small class="il-muted">synthetic entry — no source, not a real event</small> }
                  @else { <small class="il-muted">confidence {{ e.confidence || 'not recorded' }} · @for (s of e.sources; track $index) { <a [href]="safeUrl(s.url)" target="_blank" rel="noopener noreferrer">{{ s.domain || s.title }}</a>@if (s.sourceId) { ({{ s.sourceId }}) } }</small>
                    @for (s of e.sources; track $index) { @if (s.quote) { <blockquote class="il-muted" style="margin:4px 0 0 0;font-size:.85rem">“{{ s.quote }}” — {{ s.domain }}, fetched {{ s.fetchedAt | date:'short' }}@if (s.publishedAt) { · published {{ s.publishedAt }} }</blockquote> } } }</li>
              }
            </ol>
          </section>
          }
          @if (hasContent() && tab() === 'sources') {
          @if (!sources().length && !r()?.ledger?.length) { <p class="il-muted">No retrievable source was recorded. A missing source is not confirmation.</p> }
          <div class="brief-desktop-sources">
            @if (sourceGroups().length) { <h2>Evidence, with its limits</h2><p class="il-muted brief-source-intro">{{ sourceGroups().length }} source{{ sourceGroups().length === 1 ? '' : 's' }} · Quoted passages support only the statements they address.</p> }
            @for (group of sourceGroups(); track group.url) {
              <article class="il-card brief-source brief-source-group">
                <span class="brief-eyebrow">{{ group.domain || 'Source' }}</span>
                <h2><a [href]="safeUrl(group.url)" target="_blank" rel="noopener noreferrer">{{ group.title || group.url }}</a></h2>
                <details><summary>{{ group.passages.length }} recorded passage{{ group.passages.length === 1 ? '' : 's' }} · view evidence</summary>
                  @for (source of group.passages; track $index) {
                    <div class="brief-passage"><span class="brief-eyebrow">{{ source.sourceId || 'Source' }}</span>
                      @if (source.title && source.title !== group.title) { <p>{{ source.title }}</p> }
                      @if (source.quote) { <blockquote>{{ source.quote }}</blockquote> }
                      <p class="il-muted">Published: {{ source.publishedAt || 'Not recorded' }}<br />Fetched: {{ source.fetchedAt ? (source.fetchedAt | date:'medium') : 'Not recorded' }}</p>
                    </div>
                  }
                </details>
              </article>
            }
          </div>
          <div class="brief-mobile-sources">
          @for (source of sources(); track $index) {
            <article class="il-card brief-source"><span class="brief-eyebrow">{{ source.sourceId || 'Source' }}</span>
              <h2><a [href]="safeUrl(source.url)" target="_blank" rel="noopener noreferrer">{{ source.title || source.domain || source.url }}</a></h2>
              @if (source.quote) { <blockquote>{{ source.quote }}</blockquote> }
              <p class="il-muted">Published: {{ source.publishedAt || 'Not recorded' }}<br />Fetched: {{ source.fetchedAt ? (source.fetchedAt | date:'medium') : 'Not recorded' }}</p>
              <p class="il-muted">A source supports only the statements it addresses; it does not establish the whole situation.</p>
            </article>
          }
          </div>
          @if (r()?.ledger?.length) {
            <section class="il-card" aria-labelledby="ld-h"><h2 id="ld-h">Fetched sources</h2>
              <p class="il-muted" style="margin-top:0">Recorded by the fetcher (not the model): address, HTTP status and retrieval time.</p>
              <ul class="il-list">@for (x of r().ledger; track x.id) { <li><span class="il-mono">{{ x.id }}</span> <a [href]="safeUrl(x.url)" target="_blank" rel="noopener noreferrer">{{ x.title || x.domain }}</a>
                <small class="il-muted"> · {{ x.domain }} · HTTP {{ x.httpStatus }} · fetched {{ x.fetchedAt | date:'short' }}@if (!x.cited) { · not cited }</small></li> }</ul>
            </section>
          }
          }
          @if (hasContent() && tab() === 'overview') {
          <section class="il-card" aria-labelledby="ar-h"><h2 id="ar-h">Affected areas</h2>
            @if (markers().length) { <il-geo-map [markers]="markers()" ariaLabel="Affected areas" listLabel="Affected areas" /> }
            @if (!r()?.affectedAreas?.length) { <p class="il-muted">No affected areas were recorded.</p> }
            <ul class="il-list">@for (a of r()?.affectedAreas || []; track $index) { <li><strong>{{ a.name }}</strong> — {{ a.note }}</li> }</ul>
            @if (r()?.searchQueries?.length) {
              <p class="il-muted" style="margin:10px 0 4px">{{ r()?.provider === 'agent-research' ? 'Searches the agent reports it ran (not verified):' : 'Google Search queries used:' }}</p>
              <div class="il-chips">@for (q of r().searchQueries; track q) { <a class="il-chip" [href]="'https://www.google.com/search?q=' + enc(q)" target="_blank" rel="noopener noreferrer">{{ q }}</a> }</div>
            }
          </section>
          }
        </div>
        </section></div>
      } @else if (loadError()) {
        <section class="il-card" role="alert"><h1>Brief unavailable</h1><p>We couldn’t load this brief. It may be unavailable or you may no longer have access.</p><button type="button" class="il-btn" (click)="load()" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Retry loading' }}</button></section>
      } @else { <section class="il-card" role="status"><h1>Gathering the picture</h1><p class="il-muted">Loading the saved brief…</p></section> }
      @if (b() && loadError()) { <p class="il-alert warn" role="alert">The latest update could not be loaded. Showing the last saved brief. <button type="button" class="il-link" (click)="load()" [disabled]="loading()">Retry loading</button></p> }
    </div>
  `,
})
export class BriefViewComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly b = signal<any>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal(false);
  protected readonly tab = signal('overview');
  protected readonly tabs = [{ key: 'overview', label: 'Overview' }, { key: 'timeline', label: 'Timeline' }, { key: 'sources', label: 'Sources' }];
  protected readonly hasContent = computed(() => ['ready', 'unverified', 'simulated'].includes(this.view().state));
  protected readonly sources = computed(() => {
    const result = this.r();
    const all = [...(result?.timeline || []).filter((e: any) => !e.synthetic).flatMap((e: any) => e.sources || []), ...(result?.claimChecks || []).flatMap((c: any) => c.sources || []), ...(result?.travelAssessment?.sources || [])];
    if (this.simulated()) return [];
    return all.filter((s: any, i: number) => !!this.safeUrl(s.url) && all.findIndex((x: any) => x.url === s.url && x.quote === s.quote) === i);
  });
  // Desktop presentation groups repeated passages by exact source URL; no evidence is removed.
  protected readonly sourceGroups = computed(() => {
    const groups = new Map<string, { url: string; title: string; domain: string; passages: any[] }>();
    for (const source of this.sources()) {
      let group = groups.get(source.url);
      if (!group) { group = { url: source.url, title: source.title || '', domain: source.domain || '', passages: [] }; groups.set(source.url, group); }
      group.passages.push(source);
    }
    return [...groups.values()];
  });
  protected safeUrl(value: unknown): string | null { return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null; }
  protected readonly r = computed(() => this.b()?.result);
  protected readonly verdict = VERDICT; protected readonly feas = FEAS;
  protected readonly view = computed(() => briefDisplay(this.b()));
  protected readonly building = computed(() => !!this.b() && this.view().state === 'building');
  protected readonly simulated = computed(() => this.view().state === 'simulated');
  protected readonly markers = computed<MapMarker[]>(() => (this.r()?.affectedAreas ?? []).filter((a: any) => a.lat != null && a.lng != null)
    .map((a: any, i: number) => ({ id: 'a' + i, lat: a.lat, lng: a.lng, label: a.name, detail: a.note })));
  protected readonly enc = encodeURIComponent;
  private poll?: Subscription;
  private request?: Subscription;
  private get id(): string { return this.route.snapshot.params['id']; }

  constructor() { this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(() => { this.request?.unsubscribe(); this.loading.set(false); this.loadError.set(false); this.tab.set('overview'); this.b.set(null); this.load(); }); }
  ngOnInit(): void {
    this.poll = interval(5000).subscribe(() => { if (this.building()) this.load(); });
    this.destroyRef.onDestroy(() => { this.poll?.unsubscribe(); this.request?.unsubscribe(); });
  }
  protected load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.request = this.svc.brief(this.id).subscribe({
      next: b => { this.b.set(b); this.loadError.set(!b); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }
  protected back(): void { this.router.navigate(['..'], { relativeTo: this.route }); }
}
