// Provider generation often finishes seconds before the speakers drain.
export class TutorInputGate {
  private until = 0;
  queue(bytes:number,rate:number,now=Date.now()) {
    if(bytes)this.until=Math.max(now,this.until)+bytes*500/rate;
  }
  playback(pendingMs:number,now=Date.now()) {
    if(pendingMs>0)this.until=Math.max(this.until,now+pendingMs);
  }
  flush(now=Date.now()) {this.until=Math.min(this.until,now);}
  blocked(now=Date.now()) {return this.until>0&&now<this.until+750;}
}
