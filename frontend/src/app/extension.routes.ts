import { Routes } from '@angular/router';
import { AgenciesComponent } from './agencies/agencies.component';
import { BriefListComponent } from './brief/brief-list.component';
import { BriefViewComponent } from './brief/brief-view.component';
import { ControlRoomComponent } from './control/control-room.component';
import { IncidentBoardComponent } from './control/incident-board.component';
import { ReportReviewComponent } from './control/report-review.component';
import { AssignedIncidentComponent } from './responder/assigned-incident.component';
import { MyAssignmentsComponent } from './responder/my-assignments.component';
import { MyReportComponent } from './reporter/my-report.component';
import { MyReportsComponent } from './reporter/my-reports.component';
import { ReportWizardComponent } from './reporter/report-wizard.component';
import { capGuard } from './shell/cap.guard';
import { mountIs } from './shell/mount';
import { IlShellComponent } from './shell/il-shell.component';
import { NotGrantedComponent } from './shell/not-granted.component';

const REPORT = 'incidentlens.report', TRIAGE = 'incidentlens.triage', RESPOND = 'incidentlens.respond';

// Situation briefs live under every mount (guarded by that mount's own capability), so the host's IncidentLens
// route rules need no new mount. The backend checks "any IncidentLens role" again.
const briefRoutes = (cap: string): Routes => [
  { path: 'briefs', pathMatch: 'full', component: BriefListComponent, canActivate: [capGuard(cap)] },
  { path: 'briefs/:id', component: BriefViewComponent, canActivate: [capGuard(cap)] },
];

// What the host lazy-loads (manifest frontend.remote.exposedModule = './Extension'). Four manifest routes mount
// this same array; `canMatch` picks the subtree for the mount the URL is under (see shell/mount.ts).
// Every leaf route points DIRECTLY at its screen component, so the router can never reuse one screen's instance for
// another route. IlShellComponent is a layout-only parent (frame + <router-outlet>, never picks screens); outside
// IncidentLens mode it renders just the outlet. Leaf '' routes use pathMatch 'full'.
export const Extension: Routes = [
  { path: '', canMatch: [mountIs('incidentlens-reports')], component: IlShellComponent, children: [
    { path: '', pathMatch: 'full', component: MyReportsComponent, canActivate: [capGuard(REPORT)] },
    { path: 'new', component: ReportWizardComponent, canActivate: [capGuard(REPORT)] },
    { path: 'view/:id', component: MyReportComponent, canActivate: [capGuard(REPORT)] },
    ...briefRoutes(REPORT),
    { path: 'not-granted', component: NotGrantedComponent },
  ] },
  { path: '', canMatch: [mountIs('incidentlens-incidents')], component: IlShellComponent, children: [
    { path: '', pathMatch: 'full', component: ControlRoomComponent, canActivate: [capGuard(TRIAGE)] },
    { path: 'reports/:id', component: ReportReviewComponent, canActivate: [capGuard(TRIAGE)] },
    { path: 'incidents/:id', component: IncidentBoardComponent, canActivate: [capGuard(TRIAGE)] },
    ...briefRoutes(TRIAGE),
    { path: 'not-granted', component: NotGrantedComponent },
  ] },
  { path: '', canMatch: [mountIs('incidentlens-inbox')], component: IlShellComponent, children: [
    { path: '', pathMatch: 'full', component: MyAssignmentsComponent, canActivate: [capGuard(RESPOND)] },
    { path: 'not-granted', component: NotGrantedComponent },
    ...briefRoutes(RESPOND),
    { path: ':id', component: AssignedIncidentComponent, canActivate: [capGuard(RESPOND)] },
  ] },
  { path: '', canMatch: [mountIs('incidentlens-agencies')], component: IlShellComponent, children: [
    { path: '', pathMatch: 'full', component: AgenciesComponent, canActivate: [capGuard(TRIAGE)] },
    { path: 'not-granted', component: NotGrantedComponent },
  ] },
];
