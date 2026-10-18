import { Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { countBand, localAreaLabel } from './brief-local';
@Component({
  selector: 'il-brief-local', imports: [DatePipe], styleUrl: './brief.scss',
  template: `
    @if (context(); as local) {
      <section class="brief-local-snapshot" aria-labelledby="local-context-h">
        <div class="brief-eyebrow">Local records · server snapshot</div><h2 id="local-context-h">Reported in the selected area</h2>
        <p>{{ local.provenance }}</p>
        <p class="il-muted">Snapshot {{ local.capturedAt | date:'medium':'UTC' }} UTC · {{ local.policy }}</p>
        @if (local.selection; as area) { <p class="il-muted">{{ areaLabel(area) }}<br />{{ area.fromUtc | date:'mediumDate':'UTC' }} to {{ area.untilUtc | date:'mediumDate':'UTC' }} UTC (end exclusive)</p> }
        @if (local.state === 'available') {
          <dl class="brief-local-counts"><div><dt>Incident groups</dt><dd>{{ band(local.incidentCountBand) }}</dd></div><div><dt>Linked complaints</dt><dd>{{ band(local.linkedComplaintCountBand) }}</dd></div></dl>
          <p class="il-muted">Suppressed includes zero and counts below five. These are reported records, not verified events. Hidden counts do not establish safety.</p>
          <details><summary>Categories and recorded progress</summary>
            <h3>Incident categories</h3><dl class="brief-local-breakdown">@for (item of categories; track item[0]) { <div><dt>{{ item[1] }}</dt><dd>{{ band(local.categories?.[item[0]]) }}</dd></div> }</dl>
            <h3>Recorded internal progress</h3><p class="il-muted">Not confirmation that an external agency was dispatched or arrived.</p>
            <dl class="brief-local-breakdown">@for (item of progress; track item[0]) { <div><dt>{{ item[1] }}</dt><dd>{{ band(local.progress?.[item[0]]) }}</dd></div> }</dl>
          </details>
        } @else { <p class="il-alert warn" role="status">{{ local.state === 'withheld' ? 'Counts withheld: membership could not be reconciled reliably.' : 'Local counts are unavailable for this snapshot.' }} This does not mean there were no reports.</p> }
        <details><summary>Coverage and uncertainty</summary><ul class="il-list">@for (limit of local.limitations || []; track $index) { <li>{{ limit }}</li> }</ul></details>
        <p class="il-muted">Saved snapshot, not live tracking. Public news is separate and may describe the same events; do not add these counts together.</p>
      </section>
    } @else { <p class="il-muted">No local database snapshot was requested for this brief. Public news does not represent all complaints in the area.</p> }
  `,
})
export class BriefLocalComponent {
  readonly context = input<any>(null);
  protected readonly areaLabel = localAreaLabel; protected readonly band = countBand;
  protected readonly categories = [['road_collision','Road collisions'],['pothole_road_damage','Road damage'],['waterlogging_flood','Flooding / waterlogging'],['fallen_tree_obstruction','Trees / obstructions'],['smoke_fire_indicator','Smoke / fire indicators'],['other_uncertain','Other / uncertain']];
  protected readonly progress = [['under_review','Under review'],['in_response','Response recorded'],['awaiting_allocation','Awaiting allocation'],['needs_reassignment','Needs reassignment'],['response_complete','Completion recorded'],['closed','Closed'],['unknown','Unknown']];
}
