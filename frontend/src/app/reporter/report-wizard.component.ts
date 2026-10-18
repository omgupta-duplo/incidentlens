import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { CATEGORIES, IncidentLensService, newRequestId } from '../incidentlens.service';
import { CameraCaptureComponent } from '../shared/camera-capture.component';
import { GeoMapComponent } from '../shared/geo-map.component';
import { ExifHints, readExif } from '../shared/exif';
import { toJpeg } from '../shared/image-encode';
import { ReporterNavComponent } from './reporter-nav.component';
import { ReporterDictationComponent } from './reporter-dictation.component';
import { completePin, coordinateValue, PhotoRevision } from './report-input';
import { NOTE_LANGUAGES, NOTE_MAX, noteCheck } from './dictation';

type Fix = { lat: number; lng: number; accuracyM: number; at: string };

/**
 * Reporter submission on ONE page: photo (camera or upload), location (read only when the user asks, or a pin they
 * place), optional details, Submit. Laptops show the three sections side by side; phones stack them vertically.
 * The submit payload is unchanged (idempotent request id; the device fix is kept separately from the confirmed pin).
 */
@Component({
  selector: 'il-report-wizard',
  imports: [DatePipe, FormsModule, CameraCaptureComponent, GeoMapComponent, ReporterNavComponent, ReporterDictationComponent],
  styleUrl: './reporter.scss',
  template: `
    <div class="il-page rp-page">
      <div class="rp" [class.rp-form-shell]="!submittedId() && !saving()">
        <main class="rp-main">
          @if (submittedId(); as id) {
            <div class="rp-done">
            <div class="rp-icon" aria-hidden="true">✓</div>
            <span class="rp-eyebrow">Report received · <span class="il-mono">{{ submittedRef() || 'reference pending' }}</span></span>
            <h1 #heading tabindex="-1">You’ve made it<br />visible.</h1>
            <p class="rp-muted">Your report was received. A human review is the next step.</p>
            <div class="rp-card"><span class="rp-pill">Awaiting review</span>
              <h2 style="margin-top:15px">What happens next?</h2>
              <p class="rp-small rp-muted">The control room checks the report and may group it with other reports of the same incident.</p>
              <p class="rp-small" style="margin:0"><strong>No emergency service has been contacted.</strong> If anyone is in danger, call your local emergency number.</p></div>
            <button type="button" class="rp-primary" (click)="track(id)">Track my report <span aria-hidden="true">→</span></button>
            <button type="button" class="rp-text" style="width:100%" (click)="cancel()">Back to home</button>
            </div>
          } @else if (saving()) {
            <div class="rp-done">
            <div class="rp-icon" aria-hidden="true">↑</div>
            <span class="rp-eyebrow">Sending your report</span>
            <h1 #heading tabindex="-1">Giving your report<br />a place to start.</h1>
            <p class="rp-muted" role="status">Uploading your photo and location…</p>
            <div class="rp-bar" role="progressbar" aria-label="Sending your report" aria-busy="true"><span></span></div>
            <ol class="rp-timeline">
              <li><span class="mk" aria-hidden="true">✓</span><strong>Photo added</strong><p>{{ source() === 'upload' ? 'Uploaded from your device' : 'Taken in the app' }}</p></li>
              <li><span class="mk" aria-hidden="true">✓</span><strong>Location attached</strong><p>{{ pinText() }}</p></li>
              <li class="pending"><span class="mk" aria-hidden="true">·</span><strong>Preparing your tracking page</strong><p>Your report is reviewed by people; any automated first look is only a starting point.</p></li>
            </ol>
            </div>
          } @else {
          <form class="rp-submit" novalidate aria-labelledby="rp-form-h" (ngSubmit)="submit()">
            <header class="rp-form-head">
              <div class="rp-form-title">
                <span class="rp-eyebrow">New report</span>
                <h1 #heading tabindex="-1" id="rp-form-h">Report an incident</h1>
                <p class="rp-small rp-muted">A photo, where it is, and a few words. <strong>Not an emergency service</strong> — if anyone is in danger, call your local emergency number first.</p>
              </div>
              <button type="button" class="rp-text" (click)="cancel()">Cancel</button>
            </header>

            <div class="rp-form-grid">
              <section class="rp-panel" aria-labelledby="s1">
                <h2 id="s1"><span class="rp-num" aria-hidden="true">1</span> Photo <span class="rp-tag" [class.ok]="!!photo()">{{ photo() ? 'Added' : 'Required' }}</span></h2>
                <div class="rp-seg" role="group" aria-label="How to add the photo">
                  <button type="button" [attr.aria-pressed]="source() === 'camera'" (click)="setSource('camera')">Take a photo</button>
                  <button type="button" [attr.aria-pressed]="source() === 'upload'" (click)="setSource('upload')">Upload a photo</button>
                </div>
                <div class="rp-capture">
                  @if (source() === 'camera') {
                    <il-camera-capture (captured)="photo.set($event)" />
                  } @else {
                    <label class="rp-label-block" for="rp-file">Photo file (JPEG, PNG or WebP, up to 10 MB)</label>
                    <input id="rp-file" class="rp-input" type="file" accept="image/jpeg,image/png,image/webp" (change)="pickFile($event)" />
                    @if (uploadError()) { <p class="rp-err" role="alert">{{ uploadError() }}</p> }
                    @if (preview()) {
                      <div class="rp-photo"><img [src]="preview()" alt="Selected photo preview" /><span class="rp-label">Your photo</span></div>
                      <p class="rp-small rp-muted" role="status" style="margin:8px 0 0">
                        @if (exif().takenAt) { Taken {{ exif().takenAt | date:'medium' }} (from the file). } @else { No capture time in the file. }
                        @if (exif().lat != null) { The file also has a location you can use. }</p>
                    } @else { <p class="rp-small rp-muted" style="margin:8px 0 0">Uploaded photos are marked <strong>Uploaded</strong> and checked against images already on the web.</p> }
                  }
                </div>
                <p class="rp-small rp-muted rp-panel-note">Stay at a safe distance. Avoid faces, licence plates and personal information. A photo helps a reviewer; it doesn’t prove what happened.</p>
              </section>

              <section class="rp-panel" aria-labelledby="s2">
                <h2 id="s2"><span class="rp-num" aria-hidden="true">2</span> Location <span class="rp-tag" [class.ok]="pinValid()">{{ pinValid() ? 'Set' : 'Required' }}</span></h2>
                <button type="button" class="rp-secondary rp-locate" [disabled]="geo() === 'asking'" (click)="locate()">
                  <span aria-hidden="true">◎ </span>{{ geo() === 'asking' ? 'Finding your location…' : fix() ? 'Use my current location again' : 'Use my current location' }}</button>
                @switch (geo()) {
                  @case ('idle') { <p class="rp-small rp-muted rp-geo">Your location is only read when you press the button. You can also place the pin on the map or enter coordinates.</p> }
                  @case ('asking') { <p class="rp-ok rp-geo" aria-live="polite">Asking your browser for your current location…</p> }
                  @case ('granted') { <p class="rp-ok rp-geo" aria-live="polite">Location found (±{{ fix()?.accuracyM }} m). Drag the pin or edit the coordinates if it is not exactly where the problem is.</p> }
                  @case ('denied') { <p class="rp-hint rp-geo" role="status">Location access was not granted. Place the pin yourself; it will be labelled <strong>manual · lower confidence</strong>.</p> }
                  @case ('unavailable') { <p class="rp-hint rp-geo" role="status">Your location could not be determined. Place the pin yourself; it will be labelled <strong>manual · lower confidence</strong>.</p> }
                }
                <div class="rp-map"><il-geo-map [pick]="pin()" (pickChange)="setPin($event.lat, $event.lng)" ariaLabel="Map — click or drag the pin to set the report location" listLabel="Selected location" [markers]="[]" /></div>
                <div class="rp-coords">
                  <label class="rp-label-block"><span>Latitude</span>
                    <input class="rp-input" type="number" step="0.00001" name="lat" [ngModel]="latitude()" (ngModelChange)="editCoordinate('lat', $event)" /></label>
                  <label class="rp-label-block"><span>Longitude</span>
                    <input class="rp-input" type="number" step="0.00001" name="lng" [ngModel]="longitude()" (ngModelChange)="editCoordinate('lng', $event)" /></label>
                </div>
                <p class="rp-small rp-muted rp-panel-note">{{ pinBasis() }}</p>
                @if (source() === 'upload' && exif().lat != null) {
                  <button type="button" class="rp-text" (click)="setPin(exif().lat!, exif().lng!)">Use the photo's location ({{ exif().lat }}, {{ exif().lng }})</button>
                }
              </section>

              <section class="rp-panel" aria-labelledby="s3">
                <h2 id="s3"><span class="rp-num" aria-hidden="true">3</span> Details <span class="rp-tag">Optional</span></h2>
                <label class="rp-label-block" for="rp-hint">What did you notice?</label>
                <select id="rp-hint" class="rp-input" name="hint" [ngModel]="hint()" (ngModelChange)="hint.set($event)">
                  <option [ngValue]="null">I'm not sure</option>
                  @for (c of categories; track c.value) { <option [ngValue]="c.value">{{ c.label }}</option> }
                </select>
                <label class="rp-label-block" for="rp-note">Anything a reviewer should know?</label>
                <div class="rp-note-compose">
                <textarea id="rp-note" class="rp-input" name="note" rows="3" [attr.lang]="noteLang()" [attr.dir]="noteDir()"
                          [attr.aria-invalid]="!noteState().ok" [ngModel]="note()" (ngModelChange)="note.set($event)"
                          aria-describedby="note-help" placeholder="Describe what you saw, in any language."></textarea>
                <il-reporter-dictation [(language)]="noteLang" (append)="appendToNote($event)" />
                </div>
                @if (noteState().ok) {
                  <p id="note-help" class="rp-small rp-muted rp-count">{{ noteMax - noteState().length }} of {{ noteMax }} characters left · no personal details</p>
                } @else {
                  <p id="note-help" class="rp-err rp-count" role="alert">Your note is {{ noteState().over }} character{{ noteState().over === 1 ? '' : 's' }} over the {{ noteMax }}-character limit. Shorten it before submitting — nothing has been cut.</p>
                }
                <details class="rp-phone">
                  <summary>Mobile number (optional) — not collected yet</summary>
                  <label class="rp-label-block" for="rp-phone">Mobile number</label>
                  <input id="rp-phone" class="rp-input" type="tel" disabled aria-describedby="rp-phone-why" placeholder="Not available yet" />
                  <p id="rp-phone-why" class="rp-small rp-muted">To protect your privacy, phone numbers can’t be collected until a separately protected channel is ready.
                    This field is switched off: nothing is stored or sent, and no one will call or text you through IncidentLens.</p>
                </details>
                @if (error()) { <p class="rp-err" role="alert">{{ error() }}</p> }
                <button type="submit" class="rp-primary rp-submit-btn" [disabled]="!ready()" aria-describedby="rp-submit-why">Submit report <span aria-hidden="true">→</span></button>
                <p id="rp-submit-why" class="rp-small rp-muted rp-submit-why">{{ readyText() }}</p>
              </section>
            </div>
          </form>
          }
        </main>
        @if (submittedId()) { <il-reporter-nav [active]="null" /> }
      </div>
    </div>
  `,
})
export class ReportWizardComponent {
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  protected readonly categories = CATEGORIES;
  protected readonly noteMax = NOTE_MAX;
  protected readonly photo = signal<Blob | null>(null);
  protected readonly source = signal<'camera' | 'upload'>('upload');
  protected readonly preview = signal<string | null>(null);
  protected readonly exif = signal<ExifHints>({});
  protected readonly uploadError = signal('');
  protected readonly geo = signal<'idle' | 'asking' | 'granted' | 'denied' | 'unavailable'>('idle');
  protected readonly fix = signal<Fix | null>(null);
  protected readonly pin = signal<{ lat: number; lng: number; accuracyM?: number | null } | null>(null);
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);
  private readonly photoRevision = new PhotoRevision();
  protected readonly hint = signal<string | null>(null);
  protected readonly note = signal('');
  protected readonly noteLang = signal('en-IN');
  protected readonly noteDir = computed(() => NOTE_LANGUAGES.find(l => l.tag === this.noteLang())?.dir ?? 'ltr');
  protected readonly noteState = computed(() => noteCheck(this.note()));
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly submittedId = signal<string | null>(null);
  protected readonly submittedRef = signal<string | null>(null);
  private readonly capturedAt = new Date().toISOString();
  private readonly requestId = newRequestId();   // stable across retries → the server never duplicates

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.photoRevision.next();
      const preview = this.preview(); if (preview) URL.revokeObjectURL(preview);
    });
  }

  protected pinValid(): boolean {
    const p = this.pin();
    return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  }

  /** Reads the device position only on this explicit request (the user may instead place the pin themselves). */
  protected locate(): void {
    if (!navigator.geolocation) { this.geo.set('unavailable'); return; }
    this.geo.set('asking');
    navigator.geolocation.getCurrentPosition(
      p => {
        const f = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), at: new Date(p.timestamp).toISOString() };
        this.fix.set(f); this.setPin(f.lat, f.lng); this.geo.set('granted');
      },
      e => this.geo.set(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  protected ready(): boolean { return !!this.photo() && this.pinValid() && this.noteState().ok && !this.saving(); }
  protected readyText(): string {
    const need = [!this.photo() && 'add a photo', !this.pinValid() && 'set the location', !this.noteState().ok && 'shorten the note'].filter(Boolean);
    return need.length ? `To submit: ${need.join(' · ')}.` : 'Ready to submit. This does not summon emergency help.';
  }
  protected appendToNote(text: string): void { const cur = this.note().trim(); this.note.set(cur ? `${cur} ${text}` : text); }

  protected setSource(s: 'camera' | 'upload'): void {
    if (s === this.source()) return;
    this.photoRevision.next();
    this.source.set(s); this.photo.set(null); this.exif.set({}); this.uploadError.set('');
    const p = this.preview(); if (p) URL.revokeObjectURL(p); this.preview.set(null);
  }

  /** Reads EXIF hints from the ORIGINAL file, then re-encodes to JPEG (same format as the camera path). */
  protected async pickFile(e: Event): Promise<void> {
    const revision = this.photoRevision.next();
    const current = () => this.photoRevision.current(revision) && this.source() === 'upload';
    const f = (e.target as HTMLInputElement).files?.[0];
    this.uploadError.set(''); this.photo.set(null); this.exif.set({});
    const old = this.preview(); if (old) URL.revokeObjectURL(old); this.preview.set(null);
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { this.uploadError.set('Choose a JPEG, PNG or WebP photo.'); return; }
    if (f.size > 10 * 1024 * 1024) { this.uploadError.set('That photo is larger than 10 MB.'); return; }
    try {
      const exif = f.type === 'image/jpeg' ? readExif(await f.arrayBuffer()) : {};
      if (!current()) return;
      const jpeg = await toJpeg(f);
      if (!current()) return;
      if (jpeg.size > 8 * 1024 * 1024) { this.uploadError.set('That photo is too large even after resizing.'); return; }
      this.exif.set(exif); this.photo.set(jpeg); this.preview.set(URL.createObjectURL(jpeg));
    } catch { if (current()) this.uploadError.set('That file could not be read as a photo.'); }
  }

  protected setPin(lat: number, lng: number): void {
    this.latitude.set(coordinateValue(lat)); this.longitude.set(coordinateValue(lng));
    this.updatePin();
  }

  protected editCoordinate(axis: 'lat' | 'lng', value: unknown): void {
    (axis === 'lat' ? this.latitude : this.longitude).set(coordinateValue(value));
    this.updatePin();
  }
  private updatePin(): void {
    const p = completePin(this.latitude(), this.longitude());
    this.pin.set(p ? { ...p, accuracyM: this.fix()?.accuracyM ?? null } : null);
  }

  protected pinText(): string {
    const p = this.pin(); return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? `${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}` : 'No location yet';
  }
  protected pinBasis(): string {
    const f = this.fix(), p = this.pin();
    if (!p) return 'Place the pin on the map or enter coordinates.';
    if (f && Math.abs(f.lat - p.lat) < 1e-7 && Math.abs(f.lng - p.lng) < 1e-7) return `From your device · ±${f.accuracyM} m`;
    return f ? 'Adjusted by you · your device fix is kept separately' : 'Manually placed · lower confidence';
  }
  protected track(id: string): void { this.router.navigate(['..', 'view', id], { relativeTo: this.route }); }
  protected cancel(): void { this.router.navigate(['..'], { relativeTo: this.route }); }

  protected submit(): void {
    const p = this.pin(), photo = this.photo(), f = this.fix();
    if (!p || !photo || !this.ready()) return;              // never truncates: an over-long note blocks submit instead
    const payload = {
      clientRequestId: this.requestId, capturedAt: this.capturedAt, latitude: p.lat, longitude: p.lng,
      gpsLatitude: f?.lat ?? null, gpsLongitude: f?.lng ?? null, gpsAccuracyM: f?.accuracyM ?? null, gpsFixAt: f?.at ?? null,
      categoryHint: this.hint(), note: this.note().trim() || null,
      captureSource: this.source(),
      ...(this.source() === 'upload' ? { exifTakenAt: this.exif().takenAt ?? null, exifLatitude: this.exif().lat ?? null, exifLongitude: this.exif().lng ?? null } : {}),
    };
    const form = new FormData();
    form.append('photo', photo, this.source() === 'upload' ? 'upload.jpg' : 'camera.jpg');
    form.append('payload', JSON.stringify(payload));
    this.photoRevision.next();
    this.saving.set(true); this.error.set(''); this.focusHeading();
    this.svc.submit(form).subscribe({
      next: r => { this.submittedRef.set(r?.name ?? null); this.submittedId.set(r.id); this.saving.set(false); this.focusHeading(); },
      error: e => { this.saving.set(false); this.focusHeading(); this.error.set(extractErrorMessage(e) || 'The report could not be sent. Check your connection and try again — retrying will not create a duplicate.'); },
    });
  }

  private focusHeading(): void { setTimeout(() => this.heading()?.nativeElement.focus()); }
}
