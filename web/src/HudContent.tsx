import type { Hud } from '../../contracts/index.ts';
import { LessonPageView } from './CprLesson.tsx';

export function HudContent({ hud, now }: { hud: Hud; now: number }) {
  return <>
    {hud.brand === 'marines' && <img className="marine-seal" src="/marines-emblem.png" alt="United States Marine Corps seal" />}
    {hud.lessonPage ? <LessonPageView page={hud.lessonPage} /> : <>
      {hud.card && <><span className="tiny">{hud.card.title ?? 'COACH'}</span><p>{hud.card.body}</p></>}
      {hud.checklist?.map(item => <div className="hud-check" key={item.id}><span>{item.checked ? '☑' : '☐'}</span>{item.text}</div>)}
      {hud.timer && <div className="hud-timer">{Math.max(0, Math.ceil(((hud.timer.startedAt ?? now) + hud.timer.durationMs - now) / 1000))}s</div>}
    </>}
    {!Object.keys(hud).length && <div className="hud-empty"><span>□</span>Display clear<small>Accepted guidance appears here.</small></div>}
    {hud.imageAssetId && <small>Image asset: {hud.imageAssetId}</small>}
  </>;
}
