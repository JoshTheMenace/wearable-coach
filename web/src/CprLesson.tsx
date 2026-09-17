import type { Snapshot } from '../../contracts/index.ts';
import type { LessonIntro } from './lesson-media.ts';
import './lesson.css';

type Props = { snapshot: Snapshot; intro?: LessonIntro; ready: boolean; readOnly?: boolean; now: number; send: (type: string, payload?: Record<string, unknown>) => void };
type Page = NonNullable<Snapshot['hud']['lessonPage']>;
const steps = [{ id: 'intro', title: 'Learn' }, { id: 'demonstration', title: 'Watch' }, { id: 'placement', title: 'Position' }, { id: 'practice', title: 'Practise' }, { id: 'complete', title: 'Recap' }];

export function LessonPageView({ page, display = false }: { page: Page; display?: boolean }) {
  return <article className={`lesson-authored-page template-${page.template}${display ? ' in-display' : ''}`} data-page-id={page.id} aria-label={page.title}>
    <p className="lesson-chapter">{page.chapter}</p><h3>{page.title}</h3><p className="lesson-page-body">{page.body}</p>
    {page.support && <div className="lesson-page-support">{page.support.title && <h4>{page.support.title}</h4>}<p>{page.support.body}</p></div>}
    <p className="lesson-voice-hint">{page.hint}</p>
  </article>;
}

export function CprLesson({ snapshot, intro, ready, readOnly, now, send }: Props) {
  const lesson = snapshot.lesson;
  if (!lesson) return null;
  const page = snapshot.hud.lessonPage, observation = lesson.lastObservation, demo = snapshot.demonstration;
  const scripted = !!lesson.scriptedStage;
  const paused = lesson.status === 'paused', done = lesson.phase === 'complete', practice = ['placement', 'practice'].includes(lesson.phase);
  const canAct = ready && !readOnly && snapshot.status === 'active';
  const act = (action: string) => send('lesson_action', { action, expectedRevision: lesson.revision });
  const age = observation ? Math.max(0, Math.floor((now - observation.at) / 1000)) : null;
  const stale = !!observation && (now < observation.at || now - observation.at > 5000);
  const availableClips = Array.isArray(snapshot.device?.demoAssets) ? snapshot.device.demoAssets as { lessonKey?: string }[] : [];
  const hasClip = (key: string) => availableClips.some(clip => clip.lessonKey === key);
  const canPlay = (key: string) => canAct && !paused && !demo && hasClip(key);
  const adjustment = observation?.placement === 'too_low' || observation?.placement === 'off_target';
  const placement = lesson.ready === false ? 'Waiting for your “Ready”' : lesson.needsPlacementCheck ? 'Fresh placement check needed' : !observation ? 'Waiting for a clear view' : stale ? 'Waiting for a fresh observation' : adjustment ? 'Adjustment needed' : observation.placement === 'correct' ? 'Hand position observed' : 'Contact point unclear';
  const unverified = lesson.completed.some(item => item.step === 'placement' && item.evidence === 'learner_confirmed');
  return <section className="lesson-panel" aria-label="CPR practice lesson">
    <div className="lesson-topline"><span className="eyebrow">ADULT CPR · MANIKIN PRACTICE</span><span className={`lesson-live ${paused ? 'paused' : ''}`}><span className="dot" />{paused ? 'Paused' : demo ? demo.status === 'playing' ? 'Video playing' : 'Preparing video' : snapshot.status === 'active' ? 'Coach connected' : snapshot.status}</span></div>
    <ol className="lesson-progress" aria-label="Lesson progress">{steps.map(step => <li key={step.id} aria-current={step.id === lesson.phase ? 'step' : undefined}>{step.title}</li>)}</ol>
    <div className={`lesson-content${practice && !demo && !scripted ? ' lesson-practice-grid' : ''}`}>
      {demo && demo.status !== 'cueing' ? <div className="lesson-media-state" role="status"><span className="lesson-chapter">{demo.lessonKey === 'hand-placement' ? 'HAND PLACEMENT · 5-SECOND REPLAY' : 'WATCH · DEMONSTRATION'}</span><h3>{demo.status === 'playing' ? 'Video playing on the display' : 'Preparing your video…'}</h3><p>{demo.status === 'playing' ? 'The coach stays silent while the clip plays. Say “Pause the video” to interrupt.' : 'Playback has been requested. Waiting for the device to report that it started.'}</p><p className="lesson-media-note">A paused clip restarts from the beginning; playback position is not saved.</p></div> : page ? <LessonPageView page={page} /> : <p role="status">Waiting for the current lesson page…</p>}
      {practice && !demo && !scripted && <aside className={`lesson-observation ${!stale && adjustment ? 'adjust' : ''}`} aria-live="polite"><span className="tiny">OBSERVATION EVIDENCE</span><h4>{paused ? 'Practice checks paused' : placement}</h4><p>{paused ? 'Progress is saved. The coach keeps listening for “Resume.”' : stale ? 'The previous frame is no longer current.' : observation?.reason ?? 'The coach needs a fresh view of both hands and the manikin’s chest.'}</p>{unverified && <p className="lesson-feedback">Placement not verified · you chose to continue.</p>}<div className="lesson-observation-meta"><span>{observation?.cameraSource === 'recorded_video' ? 'Recorded simulation' : observation?.cameraSource === 'mock' ? 'Synthetic simulation' : observation ? 'Camera frame' : 'No observation yet'}</span>{age !== null && <span>{age}s ago</span>}<span>{lesson.observerStatus === 'observing' ? 'Checking view…' : lesson.observerStatus === 'unavailable' ? 'Placement check unavailable' : ''}</span></div>{lesson.observerError && <p className="lesson-observer-error" role="status">{lesson.observerError}</p>}</aside>}
    </div>
    {!readOnly && <details className="lesson-controls"><summary>Optional controls <span>Use your voice to move through the lesson</span></summary><div className="lesson-actions">
      {demo ? <><button className="secondary" disabled={!canAct} onClick={() => act('pause')}>Pause video</button>{demo.lessonKey === 'overview' && <button className="plain" disabled={!canAct} onClick={() => act('skip_demo')}>Skip demonstration</button>}</> : paused ? <button className="primary" disabled={!canAct || !!lesson.pausedClip && !hasClip(lesson.pausedClip)} onClick={() => act('resume')}>{lesson.pausedClip ? 'Restart clip from beginning' : 'Resume lesson'}</button> : <>
        {(lesson.phase === 'intro' || done) && <><button className="secondary" disabled={!canAct || (done ? !lesson.recapPage : !lesson.teachingPage || lesson.teachingPage === 'opening')} onClick={() => act('back')}>Back</button><button className="primary" disabled={!canAct || (lesson.phase === 'intro' && lesson.teachingPage === 'compression-pattern' && !hasClip('overview')) || (done && lesson.recapPage === 1)} onClick={() => act('next')}>{lesson.phase === 'intro' && lesson.teachingPage === 'compression-pattern' ? 'Show the demo' : 'Next'}</button></>}
        <button className="secondary" disabled={!canAct} onClick={() => act('repeat')}>Repeat explanation</button>
        {lesson.phase === 'intro' && <button className="plain" disabled={!canPlay('overview')} onClick={() => send('play_training_video', { clipId: 'overview' })}>Watch demo now</button>}
        {lesson.phase === 'demonstration' && <><button className="primary" disabled={!canPlay('overview')} onClick={() => send('play_training_video', { clipId: 'overview' })}>Play overview from beginning</button><button className="plain" disabled={!canAct} onClick={() => act('skip_demo')}>Skip demonstration</button></>}
        {practice && <>{(lesson.phase === 'placement' || lesson.needsPlacementCheck) && (scripted || !lesson.ready) && <button className="primary" disabled={!canAct} onClick={() => act('ready')}>{scripted ? 'Ready to continue' : 'Ready for the placement check'}</button>}<button className="secondary" disabled={!canPlay('hand-placement')} onClick={() => send('play_training_video', { clipId: 'hand-placement' })}>Replay hand placement · 5 seconds</button>{!scripted && (lesson.phase === 'placement' || lesson.needsPlacementCheck) && <button className="plain" disabled={!canAct} onClick={() => act('skip_placement')}>Continue without visual check</button>}{lesson.phase === 'practice' && <button className="primary" disabled={!canAct} onClick={() => act('finish_practice')}>I’m done</button>}</>}
        {done ? <button className="secondary" disabled={!canAct} onClick={() => act('restart')}>Practise again</button> : <button className="plain" disabled={!canAct} onClick={() => act('pause')}>Pause lesson</button>}
      </>}
    </div>{paused && lesson.pausedClip && <p className="lesson-media-note">The interrupted clip will restart from the beginning.</p>}{!done && !demo && !hasClip(lesson.phase === 'intro' || lesson.phase === 'demonstration' ? 'overview' : 'hand-placement') && <p className="lesson-media-note">The requested video must finish caching on the device before playback is available.</p>}</details>}
    {intro && <details className="lesson-reference"><summary>Training reference and sources</summary><p>{intro.scope}</p>{intro.facts.map(fact => <p key={fact.id}>{fact.text}<a className="lesson-fact-source" href={fact.source.url} target="_blank" rel="noreferrer">{fact.source.title} ↗</a></p>)}</details>}
    <details className="lesson-reference"><summary>Session settings</summary><p>{scripted ? 'Scripted demo · Planned corrections; no visual assessment.' : 'Live practice · Camera checks hand placement.'}</p></details>
    <div className="lesson-footnote"><span>Manikin practice · voice-led lesson</span>{!scripted && <span>Visible placement is qualitative; depth and force are not measured.</span>}</div>
  </section>;
}
