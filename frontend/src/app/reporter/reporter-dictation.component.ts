import { Component, DestroyRef, computed, inject, model, output, signal } from '@angular/core';
import { DICTATION_PROVIDER, NOTE_LANGUAGES } from './dictation';

/** Compact note-field control. The default provider remains unconfigured: no recording or transmission. */
@Component({
  selector: 'il-reporter-dictation',
  styleUrl: './reporter.scss',
  template: `
    <div class="rp-note-tools">
      <label class="sr-only" for="dict-lang">Language of your note</label>
      <select id="dict-lang" class="rp-note-language" [disabled]="busy()" [value]="language()" (change)="language.set($any($event.target).value)">
        @for (l of languages; track l.tag) { <option [value]="l.tag">{{ l.native }}</option> }
      </select>
      <button type="button" class="rp-note-mic" [class.listening]="busy()" [attr.aria-label]="busy() ? 'Stop dictation' : 'Dictate note'"
              [attr.aria-pressed]="busy()" aria-describedby="dict-status" [title]="busy() ? 'Stop dictation' : 'Dictate note'" (click)="toggle()">
        @if (busy()) { <span aria-hidden="true">■</span> }
        @else { <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg> }
      </button>
    </div>
    <p id="dict-status" class="rp-note-status" role="status" aria-live="polite">{{ status() }}</p>
  `,
})
export class ReporterDictationComponent {
  private readonly provider = inject(DICTATION_PROVIDER);
  private readonly destroy = inject(DestroyRef);
  protected readonly languages = NOTE_LANGUAGES;
  readonly language = model('en-IN');
  readonly append = output<string>();
  protected readonly busy = signal(false);
  private readonly message = signal('');
  private disposed = false;
  protected readonly configured = this.provider.status() === 'ready' && typeof this.provider.stop === 'function';
  protected readonly status = computed(() => this.message() || (this.configured ? 'Tap the mic to dictate; edit the text here before submitting.' : 'Voice input unavailable. Type in any language.'));
  constructor() { this.destroy.onDestroy(() => { this.disposed = true; if (this.busy()) this.provider.stop?.(); }); }
  protected async toggle(): Promise<void> {
    if (this.busy()) { this.provider.stop?.(); this.message.set('Stopping…'); return; }
    if (!this.configured) { this.message.set('Voice input is not configured. Nothing was recorded or sent. Please type your note.'); return; }
    this.busy.set(true); this.message.set('Listening… Tap stop when finished.');
    try {
      const text = await this.provider.transcribe(this.language());
      if (this.disposed) return;
      if (text?.trim()) this.append.emit(text.trim());
      this.message.set(text?.trim() ? 'Text added to your note. Edit it before submitting.' : 'No speech detected. You can type your note.');
    } catch { if (!this.disposed) this.message.set('Voice input failed. Please type your note.'); }
    finally { if (!this.disposed) this.busy.set(false); }
  }
}
