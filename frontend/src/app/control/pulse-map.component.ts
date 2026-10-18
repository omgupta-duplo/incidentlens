import { FormsModule } from '@angular/forms';
import { matchesPulse } from './record-search';
import { Component, DestroyRef, ElementRef, OnInit, afterNextRender, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Subscription, interval } from 'rxjs';
import { IncidentLensService, RESPONSE_STATES, categoryLabel } from '../incidentlens.service';
import { loadMaps } from '../shared/geo-map.component';
import { HEAT_STYLE, HeatLevel, heatOf, incidentTitle, replayAt, pulseInitialFocus, pulseMarkerScale } from '../util';

interface PulseIncident {
  id: string; name: string; category: string; priority: string; jurisdiction: string; summary?: string; responseState: string;
  centroidLat: number; centroidLng: number; radiusM: number; reports: { id: string; receivedAt: string; lat: number; lng: number }[];
  reportCount: number; independentReporters: number; lastReportAt: string | null; windowMinutes: number; teams: number;
}
interface Row { inc: PulseIncident; count: number; last: string | null; level: HeatLevel; score: number }

/**
 * Live Incident Pulse: every open incident is a circle that heats up (teal → amber → orange → red) as reports arrive and
 * cools as time passes; a new report triggers a pulse ring. A replay slider rebuilds the picture at any past moment.
 * Accessibility: the colour is always accompanied by a text level, a list twin ordered by heat, and reduced motion.
 */
@Component({
  selector: 'il-pulse-map',
  imports: [DatePipe, FormsModule],
  styles: [`
    :host { display: block; }
    .searches { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:14px; align-items:end; }
    .searches label { display:grid; gap:5px; flex:1 1 230px; min-width:0; color:#4a5d6e; font-size:.86rem; }
    .searches input { width:100%; box-sizing:border-box; min-width:0; border:1px solid #9fb6c1; border-radius:8px; padding:9px; font:inherit; }
    .wrap { display: grid; grid-template-columns: 1fr minmax(260px, 340px); gap: 16px; }
    @media (max-width: 1000px) { .wrap { grid-template-columns: 1fr; } }
    .map { height: 460px; border-radius: 14px; border: 1px solid #d5e3e8; background: #e9f1f4; }
    .panel { border: 1px dashed #9fb6c1; border-radius: 10px; padding: 14px; color: #4a5d6e; background: #f7fbfc; }
    .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 0; }
    .bar input[type=range] { flex: 1; min-width: 200px; accent-color: #0b6e78; }
    .legend { line-height: 1.7; display: flex; gap: 12px; flex-wrap: wrap; font-size: .82rem; color: #4a5d6e; margin: 8px 0 0; }
    .sw { display: inline-block; width: 12px; height: 12px; border-radius: 50%; vertical-align: -1px; margin-right: 4px; }
    ol { list-style: none; margin: 0; padding: 0; max-height: 470px; overflow-y: auto; }
    li button { width: 100%; text-align: left; background: #fff; border: 1px solid #d5e3e8; border-left: 5px solid; border-radius: 10px;
      padding: 10px 12px; margin-bottom: 8px; cursor: pointer; color: #0b2545; font: inherit; }
    li button[aria-pressed=true] { background: #e3f3f4; }
    li button:focus-visible, .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(11,110,120,.45); }
    .lvl { font-weight: 800; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
    .muted { color: #4a5d6e; font-size: .82rem; }
    .btn { border: 1px solid #0b6e78; background: #0b6e78; color: #fff; border-radius: 8px; padding: 6px 12px; font-weight: 600; cursor: pointer; }
    .btn.ghost { background: #fff; color: #0b6e78; }
  `],
  template: `
    <div class="searches">
      <label>Search Pulse<input type="search" name="pulseSearch" placeholder="Reference, category, summary or priority…" [ngModel]="search()" (ngModelChange)="setSearch($event, area())" /></label>
      <label>Search map area<input type="search" name="pulseArea" placeholder="Recorded area / jurisdiction…" [ngModel]="area()" (ngModelChange)="setSearch(search(), $event)" aria-describedby="area-scope" /></label>
      @if (search() || area()) { <button type="button" class="btn ghost" (click)="setSearch('', '')">Clear searches</button> }
    </div>
    <p id="area-scope" class="muted">Area search matches recorded incident jurisdiction names, not addresses from a map provider. Incidents without a recorded area cannot match. Searches filter both the list and map; ungrouped reports are hidden while searching.</p>
    @if (loading()) { <p class="panel" role="status">Loading incident activity…</p> }
    @if (loadError()) { <p class="panel" role="alert">{{ loadError() }} <button type="button" class="btn ghost" (click)="load()">Retry</button></p> }
    <div class="wrap">
      <div>
        @if (mapState() === 'missing-key') { <div class="panel" role="note"><strong>Map unavailable:</strong> no Google Maps key — use the list.</div> }
        @else if (mapState() === 'failed') { <div class="panel" role="note"><strong>Map could not load.</strong> Use the list.</div> }
        @else { <div #mapEl class="map" role="region" aria-label="Live incident pulse map"></div> }
        @if (overlayError()) { <p class="panel" role="alert">Incident overlays could not render. Use the incident list.</p> }
        <div class="bar">
          <button type="button" class="btn ghost" (click)="fitAll()" [disabled]="mapState() !== 'ready'">{{ search() || area() ? 'Fit matching incidents' : 'Fit all incidents' }}</button>
          <span class="muted" aria-live="polite">{{ extentNote() }}</span>
        </div>
        <div class="bar">
          <button type="button" class="btn ghost" (click)="togglePlay()" [attr.aria-pressed]="playing()">{{ playing() ? 'Pause replay' : 'Replay' }}</button>
          <label class="muted" for="pulse-t">Time</label>
          <input id="pulse-t" type="range" [min]="tMin()" [max]="tMax()" [step]="step()" [value]="t()" (input)="scrub($event)"
                 [attr.aria-valuetext]="(t() | date:'medium') + (live() ? ' (live)' : '')" />
          <span class="muted" aria-live="polite">{{ live() ? 'Live' : (t() | date:'short') }}</span>
          @if (!live()) { <button type="button" class="btn ghost" (click)="goLive()">Back to live</button> }
        </div>
        <p class="legend" aria-label="Report activity legend"><strong>Report activity · not priority:</strong>
          @for (k of levels; track k) { <span><span class="sw" [style.background]="style[k].color"></span>{{ style[k].label }}</span> }
          <span><span class="sw" style="background:#5b6b7b"></span>Report not yet grouped</span><span>Numbered dots locate incidents; circles show their geographic footprint.</span>
        </p>
      </div>
      <section aria-labelledby="pl-h">
        <h3 id="pl-h" style="font-size:1rem;margin:0 0 8px">Incidents by report activity ({{ rows().length }})</h3>
        @if (!rows().length) { <p class="muted">{{ loading() ? 'Waiting for incident activity…' : loadError() && !data() ? 'Incident activity unavailable.' : search() || area() ? 'No incidents match these searches at this time. Clear searches to see all.' : live() ? 'No open incidents.' : 'No incidents at this moment.' }}</p> }
        <ol>
          @for (r of rows(); track r.inc.id; let index = $index) {
            <li><button type="button" [style.border-left-color]="style[r.level].color" [attr.aria-pressed]="sel() === r.inc.id"
                        (click)="select(r.inc.id)" (dblclick)="open.emit(r.inc.id)">
              <span class="lvl" [style.color]="style[r.level].text">{{ style[r.level].label }}</span>
              <span class="muted"> · {{ r.inc.priority }} · {{ rs[r.inc.responseState] || r.inc.responseState }}</span><br />
              <strong>{{ index + 1 }}. {{ title(r.inc) }}</strong><br />
              <span class="muted">{{ r.count }} report{{ r.count === 1 ? '' : 's' }} · {{ r.inc.independentReporters }} reporter{{ r.inc.independentReporters === 1 ? '' : 's' }}
                @if (r.last) { · last {{ r.last | date:'short' }} }</span>
            </button>
            @if (sel() === r.inc.id) { <button type="button" class="btn" style="margin:-2px 0 10px" (click)="open.emit(r.inc.id)">Open incident</button> }</li>
          }
        </ol>
      </section>
    </div>
  `,
})
export class PulseMapComponent implements OnInit {
  readonly open = output<string>();
  private readonly svc = inject(IncidentLensService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');
  protected readonly style = HEAT_STYLE;
  protected readonly levels: HeatLevel[] = ['calm', 'warm', 'hot', 'critical'];
  protected readonly rs = RESPONSE_STATES;
  protected readonly title = (i: PulseIncident) => incidentTitle({ spec: { category: i.category, jurisdiction: i.jurisdiction } });
  protected readonly cat = categoryLabel;
  protected readonly search = signal('');
  protected readonly area = signal('');
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly data = signal<{ now: string; incidents: PulseIncident[]; ungrouped: any[] } | null>(null);
  protected readonly mapState = signal<'loading' | 'ready' | 'missing-key' | 'failed'>('loading');
  protected readonly t = signal(Date.now());
  protected readonly live = signal(true);
  protected readonly playing = signal(false);
  protected readonly sel = signal('');
  protected readonly extentNote = signal('');
  protected readonly overlayError = signal(false);
  private readonly reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private gm: any; private map: any; private drawn: any[] = []; private fitted = false;
  private prevCounts = new Map<string, number>(); private poll?: Subscription; private player?: any;

  protected readonly tMin = computed(() => {
    const all = (this.data()?.incidents ?? []).flatMap(i => i.reports.map(r => new Date(r.receivedAt).getTime()))
      .concat((this.data()?.ungrouped ?? []).map(r => new Date(r.receivedAt).getTime()));
    return all.length ? Math.min(...all) - 60000 : Date.now() - 3600000;
  });
  protected readonly tMax = computed(() => new Date(this.data()?.now ?? Date.now()).getTime());
  protected readonly step = computed(() => Math.max(1000, Math.round((this.tMax() - this.tMin()) / 400)));
  protected readonly rows = computed<Row[]>(() => {
    const now = this.live() ? this.tMax() : this.t();
    return (this.data()?.incidents ?? []).map(inc => {
      const { count, last } = this.live() ? { count: inc.reportCount, last: inc.lastReportAt } : replayAt(inc.reports, now);
      const h = heatOf(count, last, inc.windowMinutes, now);
      return { inc, count, last, level: h.level, score: h.score };
    }).filter(r => (r.count > 0 || this.live()) && matchesPulse(this.search(), this.area(), r.inc, this.title(r.inc))).sort((a, b) => b.score - a.score);
  });

  constructor() {
    afterNextRender(() => {
      loadMaps().then(gm => { this.gm = gm; this.mapState.set('ready'); queueMicrotask(() => this.initMap()); })
        .catch(e => this.mapState.set(e?.message === 'missing-key' ? 'missing-key' : 'failed'));
    });
    effect(() => { this.rows(); this.render(); });
    this.destroyRef.onDestroy(() => { this.poll?.unsubscribe(); clearInterval(this.player); this.clear(); });
  }

  ngOnInit(): void { this.load(); this.poll = interval(10000).subscribe(() => { if (this.live()) this.load(); }); }

  protected load(): void {
    this.svc.pulse().subscribe({ next: d => {
      const grown = (d?.incidents ?? []).filter((i: PulseIncident) => (this.prevCounts.get(i.id) ?? i.reportCount) < i.reportCount).map((i: PulseIncident) => i.id);
      (d?.incidents ?? []).forEach((i: PulseIncident) => this.prevCounts.set(i.id, i.reportCount));
      this.loading.set(false); this.loadError.set(''); this.data.set(d); if (this.live()) this.t.set(new Date(d.now).getTime());
      grown.forEach((id: string) => this.pulseRing(id));
    }, error: () => { this.loading.set(false); this.loadError.set(this.data() ? 'Activity could not refresh. Showing the last received data.' : 'Incident activity could not be loaded.'); } });
  }

  protected setSearch(query: string, area: string): void {
    this.search.set(query); this.area.set(area); this.sel.set(''); this.extentNote.set('');
    this.fitted = false;
  }

  protected select(id: string): void {
    this.sel.set(id);
    const i = this.data()?.incidents.find(x => x.id === id);
    if (i && this.map) {
      this.map.panTo({ lat: i.centroidLat, lng: i.centroidLng });
      this.map.setZoom(Math.max(14, this.map.getZoom() ?? 14));
      this.extentNote.set('Selected incident · Fit all shows the full area');
      this.render();
    }
  }
  protected scrub(e: Event): void { this.stop(); this.live.set(false); this.t.set(+(e.target as HTMLInputElement).value); }
  protected goLive(): void { this.stop(); this.live.set(true); this.t.set(this.tMax()); }
  protected togglePlay(): void {
    if (this.playing()) { this.stop(); return; }
    this.live.set(false); this.playing.set(true);
    if (this.t() >= this.tMax() - this.step()) this.t.set(this.tMin());
    const span = this.tMax() - this.tMin(), tick = Math.max(this.step(), span / 120);   // ~12 s for the whole history
    this.player = setInterval(() => {
      const before = new Map(this.rows().map(r => [r.inc.id, r.count]));
      const next = Math.min(this.tMax(), this.t() + tick); this.t.set(next);
      this.rows().forEach(r => { if ((before.get(r.inc.id) ?? 0) < r.count) this.pulseRing(r.inc.id); });
      if (next >= this.tMax()) { this.stop(); this.live.set(true); }
    }, 100);
  }
  private stop(): void { clearInterval(this.player); this.player = undefined; this.playing.set(false); }

  private initMap(): void {
    const el = this.mapEl()?.nativeElement; if (!el || !this.gm) return;
    this.map = new this.gm.Map(el, { center: { lat: 12.9716, lng: 77.5946 }, zoom: 13, streetViewControl: false, mapTypeControl: false,
      styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }] });
    this.map.addListener('zoom_changed', () => this.render());
    this.render();
  }
  protected fitAll(): void {
    if (!this.map) return;
    const points = this.rows().map(r => ({ lat: r.inc.centroidLat, lng: r.inc.centroidLng }));
    this.frame(points); this.fitted = true;
    this.extentNote.set(`All ${points.length} incidents · numbered markers stay readable at this zoom`);
  }
  private frame(points: {lat:number;lng:number}[]): void {
    if (!points.length) return;
    if (points.length === 1) { this.map.setCenter(points[0]); this.map.setZoom(14); return; }
    const bounds = new this.gm.LatLngBounds(); points.forEach(p => bounds.extend(p));
    this.map.fitBounds(bounds, 56);
    this.gm.event.addListenerOnce(this.map, 'idle', () => { if (this.map.getZoom() > 14) this.map.setZoom(14); });
  }
  private clear(): void { this.drawn.forEach(d => d.setMap?.(null)); this.drawn = []; }

  private render(): void {
    if (!this.map) return;
    this.clear();
    try {
    const points = this.rows().map(r => ({lat:r.inc.centroidLat,lng:r.inc.centroidLng}));
    let index = 0;
    for (const r of this.rows()) {
      const color = HEAT_STYLE[r.level].color, i = r.inc;
      const c = new this.gm.Circle({ map: this.map, center: { lat: i.centroidLat, lng: i.centroidLng }, radius: i.radiusM,
        strokeColor: color, strokeWeight: this.sel() === i.id ? 4 : 2, fillColor: color, fillOpacity: 0.18 + r.score * 0.4, clickable: true });
      c.addListener('click', () => this.select(i.id));
      this.drawn.push(c);
      const selected = this.sel() === i.id;
      const marker = new this.gm.Marker({ map: this.map, position: {lat:i.centroidLat,lng:i.centroidLng},
        icon: { path: this.gm.SymbolPath.CIRCLE, scale: pulseMarkerScale(this.map.getZoom() ?? 10, selected),
          fillColor: '#ffffff', fillOpacity: 1, strokeColor: selected ? '#0b2545' : color, strokeWeight: selected ? 4 : 3 },
        label: { text: String(++index), color: '#0b2545', fontWeight: '800', fontSize: '13px' },
        title: `${index}. ${this.title(i)} · ${HEAT_STYLE[r.level].label} report activity · priority ${i.priority}`,
        zIndex: selected ? 2000 : 1000 + index });
      marker.addListener('click', () => this.select(i.id)); this.drawn.push(marker);
    }
    const t = this.live() ? Infinity : this.t();
    for (const u of (this.search().trim() || this.area().trim()) ? [] : this.data()?.ungrouped ?? []) {
      if (new Date(u.receivedAt).getTime() > t) continue;
      this.drawn.push(new this.gm.Marker({ map: this.map, position: { lat:u.lat, lng:u.lng }, icon: {path:this.gm.SymbolPath.CIRCLE, scale:6, fillColor:'#5b6b7b', fillOpacity:1, strokeColor:'#fff', strokeWeight:2}, title:'Report not yet grouped', clickable:false }));
      if (!this.rows().length) points.push({lat:u.lat,lng:u.lng});
    }
    if (points.length && !this.fitted) {
      this.fitted = true;
      const focus = pulseInitialFocus(points); this.frame(focus);
      this.extentNote.set(focus.length < points.length
        ? `Initial view: ${focus.length} of ${points.length} nearby incidents. Fit all shows the others.`
        : `All ${points.length} locations · numbers match the list`);
    }
    this.overlayError.set(false);
    } catch { this.overlayError.set(true); }
  }

  /** 2 s expanding ring on an incident that just gained a report (skipped with prefers-reduced-motion). */
  private pulseRing(id: string): void {
    if (this.reduceMotion || !this.map || !this.rows().some(r => r.inc.id === id)) return;
    const i = this.data()?.incidents.find(x => x.id === id); if (!i) return;
    const color = HEAT_STYLE[this.rows().find(r => r.inc.id === id)?.level ?? 'hot'].color;
    const ring = new this.gm.Circle({ map: this.map, center: { lat: i.centroidLat, lng: i.centroidLng }, radius: i.radiusM, strokeColor: color, strokeWeight: 3, fillOpacity: 0, clickable: false });
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 2000);
      ring.setOptions({ radius: i.radiusM * (1 + k * 2.2), strokeOpacity: 1 - k });
      if (k < 1) requestAnimationFrame(step); else ring.setMap(null);
    };
    requestAnimationFrame(step);
  }
}
