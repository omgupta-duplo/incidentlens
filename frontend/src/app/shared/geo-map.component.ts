import { Component, DestroyRef, ElementRef, OnChanges, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';
import { MAPS_BROWSER_KEY } from './maps-key';
import { responseMarkerAppearance } from '../util';

export interface MapMarker { id: string; lat: number; lng: number; label: string; detail?: string; kind?: 'incident' | 'facility'; }

let mapsLoading: Promise<any> | null = null;
export function loadMaps(): Promise<any> {
  const w = window as any;
  if (w.google?.maps) return Promise.resolve(w.google.maps);
  if (!MAPS_BROWSER_KEY) return Promise.reject(new Error('missing-key'));
  if (!mapsLoading) {
    mapsLoading = new Promise((resolve, reject) => {
      w.__ilMapsReady = () => resolve(w.google.maps);
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_BROWSER_KEY)}&callback=__ilMapsReady&loading=async`;
      s.async = true; s.onerror = () => { mapsLoading = null; reject(new Error('load-failed')); };
      document.head.appendChild(s);
    });
  }
  return mapsLoading;
}

/**
 * Google Maps view with an always-present LIST TWIN (accessibility + no-key fallback). In `pick` mode a single
 * draggable pin reports its position; the same position can be adjusted from the keyboard via the lat/lng fields
 * the parent renders. Without a key it shows an explicit "Maps key missing" panel — never a silent blank.
 */
@Component({
  selector: 'il-geo-map',
  styles: [`
    :host { display: block; }
    .map { height: 300px; border-radius: 10px; border: 1px solid #d5e3e8; background: #e9f1f4; }
    .panel { border: 1px dashed #9fb6c1; border-radius: 10px; padding: 14px; color: #4a5d6e; background: #f7fbfc; }
    ol { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 2px 0; }
    button { background: none; border: 0; color: #0b6e78; text-decoration: underline; cursor: pointer; padding: 0; font: inherit; }
    button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(11,110,120,.45); }
    .legend { display: flex; flex-wrap: wrap; gap: 16px; margin: 8px 0; font-size: 13px; font-weight: 600; }
    .marker-kind { font-weight: 600; margin-right: 5px; }
    .mono { font-family: ui-monospace, Menlo, monospace; font-size: .85em; }
  `],
  template: `
    @if (status() === 'missing-key') {
      <div class="panel" role="note"><strong>Map unavailable:</strong> no Google Maps browser key is configured
        (GOOGLE_MAPS_BROWSER_KEY). Locations are listed below and can be set with the coordinate fields.</div>
    } @else if (status() === 'failed') {
      <div class="panel" role="note"><strong>Map could not load.</strong> Use the list and coordinate fields below.</div>
    } @else {
      <div #mapEl class="map" role="region" [attr.aria-label]="ariaLabel()"></div>
    }
    @if (showLegend()) {
      <div class="legend" role="group" aria-label="Map marker legend">
        <span [style.color]="appearance('incident').color"><span aria-hidden="true">◆ !</span> Incident</span>
        <span [style.color]="appearance('facility').color"><span aria-hidden="true">● ▤</span> Response facility</span>
      </div>
    }
    @if (markers().length && showList()) {
      <ol [attr.aria-label]="listLabel()">
        @for (m of markers(); track m.id) {
          <li>
            @if (m.kind) { <span class="marker-kind" [style.color]="appearance(m.kind).color"><span aria-hidden="true">{{ appearance(m.kind).symbol }}</span> {{ appearance(m.kind).name }}:</span> }
            @if (selectable()) { <button type="button" (click)="selected.emit(m.id)">{{ m.label }}</button> } @else { {{ m.label }} }
            — <span class="mono">{{ m.lat.toFixed(5) }}, {{ m.lng.toFixed(5) }}</span>@if (m.detail) { · {{ m.detail }} }
          </li>
        }
      </ol>
    }
  `,
})
export class GeoMapComponent implements OnChanges {
  readonly markers = input<MapMarker[]>([]);
  readonly pick = input<{ lat: number; lng: number; accuracyM?: number | null } | null>(null);
  readonly selectable = input(false);
  readonly showList = input(true);
  readonly showLegend = input(false);
  protected readonly appearance = responseMarkerAppearance;
  readonly ariaLabel = input('Map');
  readonly listLabel = input('Locations');
  readonly pickChange = output<{ lat: number; lng: number }>();
  readonly selected = output<string>();
  private readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');
  protected readonly status = signal<'loading' | 'ready' | 'missing-key' | 'failed'>('loading');
  private map: any; private gm: any; private drawn: any[] = []; private pin: any; private circle: any;

  constructor() {
    afterNextRender(() => {
      loadMaps().then(gm => { this.gm = gm; this.status.set('ready'); queueMicrotask(() => this.init()); })
        .catch(e => this.status.set(e?.message === 'missing-key' ? 'missing-key' : 'failed'));
    });
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  ngOnChanges(): void { if (this.map) this.render(); }

  private init(): void {
    const el = this.mapEl()?.nativeElement;
    if (!el || !this.gm) return;
    const c = this.pick() ?? this.markers()[0] ?? { lat: 12.9716, lng: 77.5946 };
    this.map = new this.gm.Map(el, { center: { lat: c.lat, lng: c.lng }, zoom: 16, streetViewControl: false, mapTypeControl: false });
    this.render();
  }

  private clear(): void {
    this.drawn.forEach(d => d.setMap?.(null)); this.drawn = [];
    this.pin?.setMap?.(null); this.pin = null; this.circle?.setMap?.(null); this.circle = null;
  }

  private render(): void {
    if (!this.map) return;
    this.clear();
    const bounds = new this.gm.LatLngBounds();
    for (const m of this.markers()) {
      const appearance = m.kind ? responseMarkerAppearance(m.kind) : null;
      const mk = new this.gm.Marker({ position: { lat: m.lat, lng: m.lng }, map: this.map,
        title: appearance ? `${appearance.name}: ${m.label}` : m.label,
        ...(appearance ? { icon: { url: appearance.iconUrl, scaledSize: new this.gm.Size(36, 36), anchor: new this.gm.Point(18, 18) }, zIndex: appearance.zIndex } : {}) });
      if (this.selectable()) mk.addListener('click', () => this.selected.emit(m.id));
      this.drawn.push(mk); bounds.extend(mk.getPosition());
    }
    const p = this.pick();
    if (p) {
      this.pin = new this.gm.Marker({ position: { lat: p.lat, lng: p.lng }, map: this.map, draggable: true, title: 'Report location (drag to adjust)' });
      this.pin.addListener('dragend', () => { const q = this.pin.getPosition(); this.pickChange.emit({ lat: q.lat(), lng: q.lng() }); });
      this.map.addListener('click', (ev: any) => this.pickChange.emit({ lat: ev.latLng.lat(), lng: ev.latLng.lng() }));
      if (p.accuracyM) this.circle = new this.gm.Circle({ map: this.map, center: { lat: p.lat, lng: p.lng }, radius: p.accuracyM, strokeOpacity: .4, fillOpacity: .08, strokeColor: '#0b6e78', fillColor: '#0b6e78' });
      this.map.setCenter({ lat: p.lat, lng: p.lng });
    } else if (this.markers().length > 1) {
      this.map.fitBounds(bounds);
    } else if (this.markers().length === 1) {
      this.map.setCenter({ lat: this.markers()[0].lat, lng: this.markers()[0].lng });
    }
  }
}
