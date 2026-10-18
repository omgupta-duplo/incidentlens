import { Component, computed, input } from '@angular/core';

// Status in TEXT + symbol (never colour alone). tone drives colour only as a secondary cue.
const TONES: Record<string, { tone: string; sym: string }> = {
  ready_for_review: { tone: 'ok', sym: '✓' }, completed: { tone: 'ok', sym: '✓' }, response_complete: { tone: 'ok', sym: '✓' },
  closed: { tone: 'neutral', sym: '■' }, fulfilled: { tone: 'ok', sym: '✓' },
  manual_review: { tone: 'warn', sym: '!' }, needs_reassignment: { tone: 'danger', sym: '!' }, awaiting_allocation: { tone: 'warn', sym: '…' },
  pending: { tone: 'warn', sym: '…' }, cancelled: { tone: 'neutral', sym: '✕' }, failed: { tone: 'danger', sym: '!' },
  requested: { tone: 'info', sym: '○' }, acknowledged: { tone: 'info', sym: '◐' }, en_route: { tone: 'info', sym: '→' },
  on_scene: { tone: 'info', sym: '●' }, in_response: { tone: 'info', sym: '●' }, under_review: { tone: 'info', sym: '○' },
  checking: { tone: 'info', sym: '◐' }, with_control_room: { tone: 'info', sym: '○' }, grouped: { tone: 'info', sym: '○' },
  team_assigned: { tone: 'info', sym: '◐' }, teams_responding: { tone: 'info', sym: '●' }, awaiting_team: { tone: 'warn', sym: '!' }, response_completed: { tone: 'ok', sym: '✓' },
  closed_completed: { tone: 'neutral', sym: '■' }, closed_unresolved: { tone: 'warn', sym: '■' },
  received: { tone: 'info', sym: '○' }, queued: { tone: 'info', sym: '○' }, analyzing: { tone: 'info', sym: '◐' },
};

@Component({
  selector: 'il-status',
  styles: [`
    :host { display: inline-block; }
    span { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 1px 10px 1px 8px;
           font-size: .8rem; font-weight: 700; border: 1px solid; white-space: nowrap; }
    .ok { background: #e4f4ea; color: #1d6b3a; border-color: #b8e0c6; }
    .warn { background: #fff4dc; color: #8a5a00; border-color: #f0d49a; }
    .danger { background: #fde8ea; color: #a61b29; border-color: #f2b8bf; }
    .info { background: #e3f3f4; color: #0b2545; border-color: #b6dfe2; }
    .neutral { background: #eef1f6; color: #13315c; border-color: #c9d3e3; }
  `],
  template: `<span [class]="t().tone"><span aria-hidden="true">{{ t().sym }}</span>{{ label() || value() }}</span>`,
})
export class StatusChipComponent {
  readonly value = input<string>('');
  readonly label = input<string>('');
  protected readonly t = computed(() => TONES[this.value() ?? ''] ?? { tone: 'neutral', sym: '•' });
}
