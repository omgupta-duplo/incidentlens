import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface DispatchDraft {
  agencyId: string; memberEmails: string[]; leadEmail: string; task: string; reason: string; simulatedEtaMinutes: number | null;
}

/**
 * Pick ONE agency, then SPECIFIC roster users (never the whole agency), a lead-eligible lead, and a task.
 * Busy members are flagged (warning, not a block). Used for dispatch, reassignment and allocating help requests.
 */
@Component({
  selector: 'il-dispatch-form',
  imports: [FormsModule],
  styleUrl: './control.scss',
  template: `
    <form class="il-panel" (ngSubmit)="submit()" [attr.aria-label]="title()">
      <h3 style="font-size:1rem;margin:0 0 8px">{{ title() }}</h3>
      <label class="il-field"><span>Agency</span>
        <select class="il-input" name="agency" required [ngModel]="agencyId()" (ngModelChange)="pickAgency($event)" [disabled]="lockAgency()">
          <option [ngValue]="''" disabled>Choose an agency</option>
          @for (a of agencies(); track a.id) { <option [ngValue]="a.id">{{ a.spec.displayName }} — {{ a.spec.capabilities.join(', ') }}</option> }
        </select></label>
      @if (agency(); as a) {
        <fieldset class="il-field"><legend style="font-weight:600;font-size:1rem">Team members (select only who should go)</legend>
          <ul class="il-roster">
            @for (m of activeRoster(); track m.email) {
              <li><label>
                <input type="checkbox" [checked]="selected().includes(m.email)" (change)="toggle(m.email)" [name]="'m_' + m.email" />
                {{ m.displayName }} @if (m.leadEligible) { <span class="il-muted">(can lead)</span> }
                @if (busy(m.email); as n) { <span class="il-warn-text">· busy on {{ n }} other assignment{{ n > 1 ? 's' : '' }}</span> }
              </label></li>
            }
          </ul>
          <small class="il-muted">{{ selected().length }} of {{ activeRoster().length }} selected.</small>
        </fieldset>
        <label class="il-field"><span>Team lead</span>
          <select class="il-input" name="lead" required [ngModel]="lead()" (ngModelChange)="lead.set($event)">
            <option [ngValue]="''" disabled>Choose the lead</option>
            @for (m of leadOptions(); track m.email) { <option [ngValue]="m.email">{{ m.displayName }}</option> }
          </select>
          @if (selected().length && !leadOptions().length) { <small class="il-warn-text">Select at least one lead-eligible member.</small> }</label>
      }
      <label class="il-field"><span>Task</span>
        <input class="il-input" name="task" required maxlength="300" [ngModel]="task()" (ngModelChange)="task.set($event)" placeholder="e.g. Traffic control and scene safety" /></label>
      <label class="il-field"><span>Reason (audited)</span>
        <input class="il-input" name="reason" required maxlength="500" [ngModel]="reason()" (ngModelChange)="reason.set($event)" /></label>
      @if (showEta()) {
        <label class="il-field"><span>ETA in minutes <span class="il-badge sim">SIMULATED</span></span>
          <input class="il-input" type="number" min="0" max="600" name="eta" [ngModel]="eta()" (ngModelChange)="eta.set($event)" />
          <small>Demo value only — IncidentLens does not track locations.</small></label>
      }
      @if (warnings().length) { <p class="il-alert warn" role="status">{{ warnings().join(' ') }}</p> }
      <div style="display:flex;gap:8px">
        <button type="submit" class="il-btn" [disabled]="!valid() || busyFlag()">{{ busyFlag() ? 'Working…' : submitLabel() }}</button>
        <button type="button" class="il-btn ghost" (click)="cancel.emit()">Cancel</button>
      </div>
    </form>
  `,
})
export class DispatchFormComponent {
  readonly agencies = input<any[]>([]);
  readonly presetAgencyId = input<string | null>(null);
  readonly lockAgency = input(false);
  readonly presetTask = input('');
  readonly title = input('Dispatch a team');
  readonly submitLabel = input('Dispatch');
  readonly showEta = input(true);
  readonly busyFlag = input(false);
  readonly warnings = input<string[]>([]);
  readonly submitted = output<DispatchDraft>();
  readonly cancel = output<void>();

  protected readonly agencyId = signal('');
  protected readonly selected = signal<string[]>([]);
  protected readonly lead = signal('');
  protected readonly task = signal('');
  protected readonly reason = signal('');
  protected readonly eta = signal<number | null>(null);

  protected readonly agency = computed(() => this.agencies().find(a => a.id === (this.agencyId() || this.presetAgencyId())));
  protected readonly activeRoster = computed(() => (this.agency()?.spec?.roster ?? []).filter((m: any) => m.active !== false));
  protected readonly leadOptions = computed(() => this.activeRoster().filter((m: any) => m.leadEligible && this.selected().includes(m.email)));
  protected readonly valid = computed(() => !!this.agency() && this.selected().length > 0 && !!this.lead()
    && this.selected().includes(this.lead()) && !!this.task().trim() && !!this.reason().trim());

  constructor() {
    // Apply presets once they arrive (fulfilling a help request pre-selects the requested agency and task).
    effect(() => {
      const a = this.presetAgencyId(), t = this.presetTask();
      untracked(() => {
        if (a && !this.agencyId()) this.agencyId.set(a);
        if (t && !this.task()) this.task.set(t);
      });
    });
  }

  protected busy(email: string): number {
    return this.agency()?.result?.availability?.find((x: any) => x.email === email)?.activeAssignmentCount ?? 0;
  }
  protected pickAgency(id: string): void { this.agencyId.set(id); this.selected.set([]); this.lead.set(''); }
  protected toggle(email: string): void {
    this.selected.update(s => s.includes(email) ? s.filter(x => x !== email) : [...s, email]);
    if (!this.selected().includes(this.lead())) this.lead.set('');
  }
  protected submit(): void {
    if (!this.valid()) return;
    this.submitted.emit({ agencyId: this.agency()!.id, memberEmails: this.selected(), leadEmail: this.lead(), task: this.task().trim(),
                          reason: this.reason().trim(), simulatedEtaMinutes: this.eta() ?? null });
  }
}
