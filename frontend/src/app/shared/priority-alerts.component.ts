import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { IncidentLensService } from '../incidentlens.service';
import { Subscription, timeout } from 'rxjs';
import { PriorityAlert, alertLedger } from './priority-alert-state';
import { mountUrl } from '../shell/il-mode';

/** In-app opt-in alerts; no OS permission, external delivery, automatic dispatch or background guarantee. */
@Component({
  selector:'il-priority-alerts',
  template:`
    <section class="alerts" aria-label="Priority alerts">
      <div><strong>Priority alerts</strong> <span>P1 critical / P2 high · while this page is open</span>
        <button type="button" (click)="toggleSound()">{{ sound() ? 'Mute sound' : 'Enable sound' }}</button>
        @if(sound()) { <button type="button" (click)="tone()">Test sound</button> }
      </div>
      <p role="status">{{ message() }}</p>
      @if(error()) { <p role="alert">{{ error() }}</p> }
      <div aria-live="polite">
      @for(a of visible(); track a.key) {
        <p><strong>{{ a.priority }} · {{ a.reference }}</strong> — {{ a.basis }}.
          <button type="button" (click)="open(a)">{{ a.kind === 'report' ? 'Review complaint' : 'Open incident' }}</button>
          <button type="button" (click)="ack(a.key)">Acknowledge alert</button>
          <button type="button" (click)="snooze(a.key)">Snooze 5 min</button></p>
      }
      </div>
      <small>Alerts refresh every 15 seconds. Acknowledging only dismisses this tab’s alert; it does not accept an assignment or dispatch anyone. Each tab controls its own sound.</small>
    </section>`,
  styles:[`.alerts{margin:12px 24px 0;padding:12px 16px;background:#fff8ec;border:1px solid #ead7b7;border-radius:12px;font-size:13px;color:#353c3a}span,small{color:#59635e}button{font:inherit;margin-left:10px;border:1px solid #a5b9ac;border-radius:7px;padding:5px 9px;background:white;color:#244c39;cursor:pointer}button:focus-visible{outline:3px solid #217d67;outline-offset:2px}p{margin:8px 0}small{display:block;margin-top:6px}@media(max-width:600px){.alerts{margin:8px}button{margin:5px}}`],
})
export class PriorityAlertsComponent {
  readonly audience=input.required<'control'|'responder'>();
  readonly identity=input.required<string>();
  private svc=inject(IncidentLensService);
  private router=inject(Router);
  private destroy=inject(DestroyRef);
  protected sound=signal(false);
  protected message=signal('Sound is off. Visual alerts remain available.');
  protected error=signal('');
  protected visible=signal<PriorityAlert[]>([]);
  private context='';
  private audio?:AudioContext;
  private request?:Subscription;
  private loading=false;
  private disposed=false;
  private timer=setInterval(()=>this.poll(),15000);
  constructor() {
    effect(()=>{ const audience=this.audience(), identity=this.identity(); untracked(()=>{
      const context=this.svc.workspaceId()+':'+identity+':'+audience;
      if(context===this.context)return;
      this.request?.unsubscribe();this.loading=false;this.context=context;this.visible.set([]);this.error.set('');
      this.sound.set(false);this.message.set('Sound is off. Visual alerts remain available.');void this.audio?.close();this.audio=undefined;this.poll();
    }); });
    this.destroy.onDestroy(()=>{this.disposed=true;clearInterval(this.timer);this.request?.unsubscribe();void this.audio?.close();});
  }
  private poll() {
    if(this.disposed||this.loading||!this.context||!this.identity())return;
    // Workspace switches must never retain an old feed or an old request.
    if(!this.context.startsWith(this.svc.workspaceId()+':')) {this.request?.unsubscribe();this.visible.set([]);this.sound.set(false);return;}
    const context=this.context;this.loading=true;
    this.request=this.svc.priorityAlerts(this.audience()).pipe(timeout(10000)).subscribe({
      next:rows=>{this.loading=false;if(this.disposed)return;if(context!==this.context||!context.startsWith(this.svc.workspaceId()+':')){this.visible.set([]);this.sound.set(false);return;}
        const state=alertLedger(context).reconcile(rows??[]);this.visible.set(state.active);this.error.set('');
        if(state.fresh&&this.sound())this.tone();},
      error:()=>{if(this.disposed)return;if(context!==this.context||!context.startsWith(this.svc.workspaceId()+':')){this.visible.set([]);this.sound.set(false);return;}this.loading=false;this.visible.set([]);this.error.set('Alerts could not refresh. Check the incident list; this tab is not a guaranteed warning channel.');},
    });
  }
  protected async toggleSound() {
    if(this.sound()){this.sound.set(false);this.message.set('Sound is off. Visual alerts remain available.');return;}
    const context=this.context;
    try {const audio=this.audio??=new AudioContext();await audio.resume();if(this.disposed||context!==this.context)return;
      if(audio.state!=='running')throw new Error();this.sound.set(true);this.message.set('Sound enabled in this tab. Browser sleep or closing the page stops alerts.');this.tone();}
    catch {if(!this.disposed&&context===this.context){this.sound.set(false);this.message.set('Sound unavailable. Visual alerts remain available.');}}
  }
  protected tone() {
    if(!this.audio||this.audio.state!=='running'){this.message.set('Sound paused by the browser. Enable it again; visual alerts remain available.');this.sound.set(false);return;}
    try {const osc=this.audio.createOscillator(),gain=this.audio.createGain(),now=this.audio.currentTime;
      osc.connect(gain);gain.connect(this.audio.destination);osc.frequency.value=660;
      gain.gain.setValueAtTime(0.08,now);gain.gain.exponentialRampToValueAtTime(0.001,now+0.4);osc.start(now);osc.stop(now+0.4);}
    catch{this.sound.set(false);this.message.set('Sound unavailable. Visual alerts remain available.');}
  }
  protected ack(key:string){alertLedger(this.context).ack(key);this.visible.update(rows=>rows.filter(a=>a.key!==key));}
  protected snooze(key:string){alertLedger(this.context).snooze(key);this.visible.update(rows=>rows.filter(a=>a.key!==key));}
  protected open(a:PriorityAlert) {
    const responder=this.audience()==='responder';
    const sub=a.kind==='report'?'reports/'+encodeURIComponent(a.resourceId):(responder?'':'incidents/')+encodeURIComponent(a.resourceId);
    void this.router.navigateByUrl(mountUrl(this.svc.workspaceId(),responder?'incidentlens-inbox':'incidentlens-incidents','/'+sub));
  }
}
