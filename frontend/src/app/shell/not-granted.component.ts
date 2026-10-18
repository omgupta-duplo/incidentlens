import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { IncidentLensService } from '../incidentlens.service';

const ROLE: Record<string, string> = {
  'incidentlens.report': 'Reporter', 'incidentlens.triage': 'Control room', 'incidentlens.respond': 'Responder',
};

@Component({
  selector: 'il-not-granted',
  styles: [`.msg { margin: 16px; padding: 14px 16px; border: 1px solid #d5e3e8; border-radius: 10px; background: #fff; color: #0b2545; }`],
  template: `
    <div class="msg" role="alert">
      @if (need() === 'error') { Your IncidentLens access could not be checked. Reload the page to try again. }
      @else { <strong>This IncidentLens area is not available to your account.</strong>
        <p style="margin:6px 0 0">Signed in as {{ who()?.email }}. Ask an administrator for the "{{ role() }}" IncidentLens role if you need it.</p> }
    </div>
  `,
})
export class NotGrantedComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly need = toSignal(this.route.queryParamMap.pipe(map(q => q.get('need') ?? '')), { initialValue: '' });
  protected readonly who = toSignal(inject(IncidentLensService).whoami(), { initialValue: null });
  protected role(): string { return ROLE[this.need()] ?? 'appropriate'; }
}
