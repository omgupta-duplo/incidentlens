import { Component, DestroyRef, ElementRef, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';

/**
 * Camera-ONLY capture: live preview → capture → JPEG (≤ maxEdge px) → retake. There is deliberately no file
 * input or gallery path. Camera denial or absence is explained honestly with a retry.
 */
@Component({
  selector: 'il-camera-capture',
  styles: [`
    :host { display: block; }
    .stage { position: relative; background: #0b2545; border-radius: 10px; overflow: hidden; aspect-ratio: 4 / 3; max-height: 420px; }
    video, img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .bar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .msg { border-radius: 8px; padding: 10px 12px; background: #fde8ea; color: #a61b29; border: 1px solid #f2b8bf; margin-bottom: 10px; }
    button { border: 1px solid #0b6e78; background: #0b6e78; color: #fff; border-radius: 8px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
    button.ghost { background: #fff; color: #0b6e78; }
    button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(11,110,120,.45); }
    button:disabled { opacity: .55; }
  `],
  template: `
    @if (error()) {
      <div class="msg" role="alert">{{ error() }}</div>
      <div class="bar"><button type="button" (click)="start()">Try the camera again</button></div>
    } @else {
      <div class="stage">
        @if (preview()) { <img [src]="preview()" [alt]="captureLabel() + ' preview'" /> }
        <video #video [hidden]="!!preview()" playsinline muted [attr.aria-label]="'Live camera view'"></video>
      </div>
      <div class="bar">
        @if (!preview()) {
          <button type="button" [disabled]="!live()" (click)="capture()">{{ captureLabel() }}</button>
          @if (!live()) { <span aria-live="polite">Starting camera…</span> }
        } @else {
          <button type="button" class="ghost" (click)="retake()">Retake</button>
          <span aria-live="polite">Photo captured. Retake if it is unclear.</span>
        }
      </div>
    }
  `,
})
export class CameraCaptureComponent {
  readonly maxEdge = input(1600);
  readonly captureLabel = input('Capture photo');
  readonly captured = output<Blob | null>();
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  protected readonly preview = signal<string | null>(null);
  protected readonly live = signal(false);
  protected readonly error = signal('');
  private stream?: MediaStream;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.stop(); const p = this.preview(); if (p) URL.revokeObjectURL(p); });
    afterNextRender(() => this.start());
  }

  async start(): Promise<void> {
    this.error.set(''); this.live.set(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('This browser cannot open a camera here. Use a device with a camera over a secure (https or localhost) page.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = this.video()?.nativeElement;
      if (v) { v.srcObject = this.stream; await v.play(); }
      this.live.set(true);
    } catch (e: any) {
      const n = e?.name ?? '';
      this.error.set(n === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again. Reports need a photo taken now — gallery uploads are not accepted.'
        : n === 'NotFoundError' ? 'No camera was found on this device.' : 'The camera could not be started. Close other apps using it and try again.');
    }
  }

  capture(): void {
    const v = this.video()?.nativeElement;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, this.maxEdge() / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(b => {
      if (!b) return;
      this.preview.set(URL.createObjectURL(b));
      this.captured.emit(b);
      this.stop();
    }, 'image/jpeg', 0.85);
  }

  retake(): void {
    const p = this.preview(); if (p) URL.revokeObjectURL(p);
    this.preview.set(null); this.captured.emit(null); this.start();
  }

  private stop(): void { this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.live.set(false); }
}
