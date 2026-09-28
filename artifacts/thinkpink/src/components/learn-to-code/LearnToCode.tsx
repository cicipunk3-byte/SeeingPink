import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Code2,
  FileCheck2,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
} from 'lucide-react';
import { Link } from 'wouter';
import type { CodeCheckResult, CodingLanguage } from '@/lib/thinkpinkBridge';
import {
  BRIDGE_LESSONS,
  DEFAULT_LEARN_STATE,
  getAllLearnLessons,
  getTrackLessons,
  type LearnLesson,
  type LearnToCodeState,
} from '@/lib/learnToCode';

const STORAGE_KEY = 'thinkpink.learn-to-code.v1';
const MAX_SOURCE_LENGTH = 30_000;

function getBridge() {
  return typeof window !== 'undefined' ? window.thinkPink : undefined;
}

function readLearnState(canPersist: boolean): LearnToCodeState {
  if (!canPersist || typeof window === 'undefined') return DEFAULT_LEARN_STATE;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_LEARN_STATE;
    const parsed = JSON.parse(saved) as Partial<LearnToCodeState>;
    const validLessonIds = new Set(getAllLearnLessons().map((lesson) => lesson.id));
    const completedLessonIds = Array.isArray(parsed.completedLessonIds)
      ? parsed.completedLessonIds.filter((id): id is string => typeof id === 'string' && validLessonIds.has(id))
      : [];
    const savedDrafts = parsed.drafts && typeof parsed.drafts === 'object' && !Array.isArray(parsed.drafts)
      ? parsed.drafts as Record<string, unknown>
      : {};
    const drafts = Object.fromEntries(
      Object.entries(savedDrafts).filter(([id, value]) =>
        validLessonIds.has(id) && typeof value === 'string' && value.length <= MAX_SOURCE_LENGTH,
      ),
    ) as Record<string, string>;
    return {
      completedLessonIds,
      drafts,
    };
  } catch {
    return DEFAULT_LEARN_STATE;
  }
}

function languageName(language: CodingLanguage) {
  return language === 'java' ? 'Java' : 'Python';
}

function codeCheckLabel(status: CodeCheckResult['status']) {
  const labels: Record<CodeCheckResult['status'], string> = {
    passed: 'Passed',
    'compile-error': 'Needs edits',
    'runtime-missing': 'Runtime not found',
    'timed-out': 'Check stopped at the time limit',
    cancelled: 'Cancelled',
    busy: 'Another check is running',
    'output-limit': 'Output limit reached',
    error: 'Check failed',
  };
  return labels[status];
}

export default function LearnToCode() {
  const previewMode = !getBridge();
  const [language, setLanguage] = useState<CodingLanguage>('java');
  const [state, setState] = useState<LearnToCodeState>(() => readLearnState(!previewMode));
  const [selectedId, setSelectedId] = useState('java-first-class');
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'result'>('idle');
  const [checkResult, setCheckResult] = useState<CodeCheckResult | null>(null);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const checkActiveRef = useRef(false);
  const checkRequestRef = useRef(0);

  const lessons = useMemo(() => getTrackLessons(language), [language]);
  const selectedLesson = useMemo(
    () => getAllLearnLessons().find((lesson) => lesson.id === selectedId) ?? lessons[0],
    [lessons, selectedId],
  );
  const code = state.drafts[selectedLesson.id] ?? selectedLesson.starterCode;
  const completedCount = state.completedLessonIds.length;
  const totalLessons = getAllLearnLessons().length;
  const trackCompleted = lessons.filter((lesson) => state.completedLessonIds.includes(lesson.id)).length;

  useEffect(() => {
    if (previewMode) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      setCheckNotice('ThinkPink could not save this draft to local app storage.');
    }
  }, [previewMode, state]);

  useEffect(() => {
    setSelectedId((current) => {
      const selected = getAllLearnLessons().find((lesson) => lesson.id === current);
      if (selected?.language === language && selected.kind === 'lesson') return current;
      return lessons[0].id;
    });
    setCheckResult(null);
    setCheckNotice(null);
  }, [language, lessons]);

  useEffect(() => () => {
    if (checkActiveRef.current) {
      checkActiveRef.current = false;
      void getBridge()?.cancelCodeCheck();
    }
  }, []);

  const cancelPendingCheck = () => {
    if (!checkActiveRef.current) return;
    checkActiveRef.current = false;
    checkRequestRef.current += 1;
    void getBridge()?.cancelCodeCheck();
  };

  const selectLesson = (lesson: LearnLesson) => {
    cancelPendingCheck();
    setSelectedId(lesson.id);
    setCheckState('idle');
    setCheckResult(null);
    setCheckNotice(null);
  };

  const updateCode = (value: string) => {
    if (new TextEncoder().encode(value).byteLength > MAX_SOURCE_LENGTH) {
      setCheckNotice('Keep the draft under 30 KB to run a local compile or syntax check.');
      return;
    }
    cancelPendingCheck();
    setState((current) => ({
      ...current,
      drafts: { ...current.drafts, [selectedLesson.id]: value },
    }));
    setCheckState('idle');
    setCheckResult(null);
    setCheckNotice(null);
  };

  const resetCode = () => {
    cancelPendingCheck();
    setState((current) => {
      const drafts = { ...current.drafts };
      delete drafts[selectedLesson.id];
      return { ...current, drafts };
    });
    setCheckState('idle');
    setCheckResult(null);
    setCheckNotice(null);
  };

  const toggleComplete = () => {
    setState((current) => {
      const isComplete = current.completedLessonIds.includes(selectedLesson.id);
      return {
        ...current,
        completedLessonIds: isComplete
          ? current.completedLessonIds.filter((id) => id !== selectedLesson.id)
          : [...current.completedLessonIds, selectedLesson.id],
      };
    });
  };

  const checkCode = async () => {
    const bridge = getBridge();
    if (!bridge) {
      setCheckNotice('Code checks are disabled in browser preview. Open the packaged ThinkPink app to check this code on this device.');
      return;
    }
    if (checkActiveRef.current) return;
    const requestId = ++checkRequestRef.current;
    checkActiveRef.current = true;
    setCheckState('checking');
    setCheckResult(null);
    setCheckNotice(null);
    try {
      const result = await bridge.checkCode(selectedLesson.language, code);
      if (!checkActiveRef.current || checkRequestRef.current !== requestId) return;
      setCheckResult(result);
      setCheckState('result');
    } catch {
      if (checkActiveRef.current && checkRequestRef.current === requestId) {
        setCheckState('idle');
        setCheckNotice('ThinkPink could not complete the local code check. Your draft remains on this device.');
      }
    } finally {
      if (checkRequestRef.current === requestId) {
        checkActiveRef.current = false;
      }
    }
  };

  const cancelCheck = async () => {
    const bridge = getBridge();
    if (!bridge || !checkActiveRef.current) return;
    checkActiveRef.current = false;
    checkRequestRef.current += 1;
    try {
      await bridge.cancelCodeCheck();
    } catch {
      setCheckNotice('ThinkPink could not cancel the local code check.');
    }
    setCheckState('idle');
    setCheckNotice('Code check cancelled. Your draft remains unchanged.');
  };

  const chooseTrack = (next: CodingLanguage) => {
    cancelPendingCheck();
    setLanguage(next);
    setSelectedId(getTrackLessons(next)[0].id);
  };

  const openBridgeLesson = (lesson: LearnLesson) => {
    cancelPendingCheck();
    setSelectedId(lesson.id);
    setCheckState('idle');
    setCheckResult(null);
    setCheckNotice(null);
  };

  return (
    <div className="starfield min-h-[100dvh] text-[#43283f]">
      <div className="mx-auto min-h-[100dvh] w-full max-w-[1560px] lg:p-4">
        <div className="min-h-[100dvh] overflow-hidden bg-[#fffaf9]/55 lg:rounded-[1.4rem] lg:border lg:border-[#e8d7e0] lg:shadow-[0_18px_60px_rgba(67,40,63,.08)]">
          <header className="flex items-center justify-between border-b border-[#eadbe2] px-5 py-4 sm:px-8 lg:px-10">
            <div className="flex items-center gap-3">
              <span className="orbit-mark h-8 w-8 text-[#b64378]" aria-hidden="true"><span className="relative z-10 h-1.5 w-1.5 rounded-full bg-[#b64378]" /></span>
              <div>
                <p className="font-display text-xl leading-none tracking-[-.03em]">ThinkPink</p>
                <p className="mt-1 font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#8f2f61]">Learn to Code</p>
              </div>
            </div>
            <Link href="/" data-testid="link-back-to-workspace" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-[#633752] transition hover:bg-[#f2dbe5]">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to workspace
            </Link>
          </header>

          <main className="mx-auto grid w-full max-w-[1380px] gap-7 px-5 pb-14 pt-7 sm:px-8 lg:grid-cols-[265px_minmax(0,1fr)] lg:gap-10 lg:px-10 lg:pt-10">
            <LearnRail
              language={language}
              lessons={lessons}
              selectedId={selectedId}
              completedLessonIds={state.completedLessonIds}
              completedCount={completedCount}
              totalLessons={totalLessons}
              trackCompleted={trackCompleted}
              previewMode={previewMode}
              onChooseTrack={chooseTrack}
              onSelectLesson={selectLesson}
            />
            <section className="min-w-0">
              <div className="rise-in flex flex-col justify-between gap-6 border-b border-[#eadbe2] pb-8 xl:flex-row xl:items-end">
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[.23em] text-[#8f2f61]">A patient place to practice</p>
                  <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[.98] tracking-[-.04em] text-[#43283f] sm:text-7xl">Learn to code, one clear idea at a time.</h1>
                  <p className="mt-5 max-w-2xl text-base leading-7 text-[#785f73]">Start with Java, switch to Python when you are ready, and keep the same small questions in view as you learn.</p>
                </div>
                <div data-testid="status-learning-progress" className="min-w-[205px] rounded-2xl border border-[#d9c5df] bg-[#f5eff7] p-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-[#785f73]">Your progress</span>
                    <span className="font-mono-ui text-sm text-[#633752]">{completedCount}/{totalLessons}</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e5d9e8]" aria-hidden="true">
                    <div className="h-full rounded-full bg-[#b64378] transition-[width] duration-300" style={{ width: `${Math.round((completedCount / totalLessons) * 100)}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-[#785f73]">Saved on this device in the packaged app.</p>
                </div>
              </div>

              {previewMode && <PreviewBanner />}

              <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_275px]">
                <LessonEditor
                  lesson={selectedLesson}
                  code={code}
                  completed={state.completedLessonIds.includes(selectedLesson.id)}
                  checkState={checkState}
                  checkResult={checkResult}
                  checkNotice={checkNotice}
                  previewMode={previewMode}
                  onChange={updateCode}
                  onReset={resetCode}
                  onCheck={() => void checkCode()}
                  onCancelCheck={() => void cancelCheck()}
                  onToggleComplete={toggleComplete}
                />
                <LessonNotes lesson={selectedLesson} />
              </div>

              <BridgeLessons
                lessons={BRIDGE_LESSONS}
                selectedId={selectedId}
                completedLessonIds={state.completedLessonIds}
                onSelect={openBridgeLesson}
              />
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

function LearnRail({
  language,
  lessons,
  selectedId,
  completedLessonIds,
  completedCount,
  totalLessons,
  trackCompleted,
  previewMode,
  onChooseTrack,
  onSelectLesson,
}: {
  language: CodingLanguage;
  lessons: LearnLesson[];
  selectedId: string;
  completedLessonIds: string[];
  completedCount: number;
  totalLessons: number;
  trackCompleted: number;
  previewMode: boolean;
  onChooseTrack: (language: CodingLanguage) => void;
  onSelectLesson: (lesson: LearnLesson) => void;
}) {
  return (
    <aside className="rise-in-delay lg:pt-2">
      <div className="flex items-start justify-between gap-5 lg:block">
        <div>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#785f73]">Learning path</p>
          <p className="mt-2 text-sm leading-6 text-[#633752]">Choose a language. You can return to either track at any time.</p>
        </div>
        <span className="shrink-0 rounded-full bg-[#f2dbe5] px-2.5 py-1 font-mono-ui text-[10px] text-[#8f2f61]">{completedCount}/{totalLessons}</span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 rounded-xl border border-[#e8d7e0] bg-[#eee8f1]/60 p-1.5" role="group" aria-label="Choose a language">
        {(['java', 'python'] as CodingLanguage[]).map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => onChooseTrack(item)}
            aria-pressed={language === item}
            data-testid={`button-track-${item}`}
            className={`rounded-lg px-3 py-2.5 text-sm font-medium transition ${language === item ? 'bg-[#633752] text-[#fff7fa] shadow-[0_4px_12px_rgba(67,40,63,.13)]' : 'text-[#785f73] hover:bg-[#fffaf9] hover:text-[#633752]'}`}
          >
            {languageName(item)}
          </button>
        ))}
      </div>

      <div className="mt-7">
        <div className="flex items-center justify-between">
          <p className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#785f73]">{languageName(language)} foundations</p>
          <span className="font-mono-ui text-[10px] text-[#785f73]">{trackCompleted}/{lessons.length}</span>
        </div>
        <nav className="mt-3 space-y-1.5" aria-label={`${languageName(language)} lessons`}>
          {lessons.map((lesson, index) => {
            const active = selectedId === lesson.id;
            const complete = completedLessonIds.includes(lesson.id);
            return (
              <button
                type="button"
                key={lesson.id}
                onClick={() => onSelectLesson(lesson)}
                data-testid={`button-lesson-${lesson.id}`}
                aria-current={active ? 'step' : undefined}
                className={`group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition ${active ? 'border-[#c589a5] bg-[#fff4f7] shadow-[0_5px_16px_rgba(143,47,97,.08)]' : 'border-transparent hover:border-[#e8d7e0] hover:bg-[#fffaf9]'}`}
              >
                <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono-ui text-[10px] ${complete ? 'bg-[#3f715f] text-white' : active ? 'bg-[#8f2f61] text-white' : 'bg-[#eee8f1] text-[#785f73]'}`}>
                  {complete ? <Check className="h-3.5 w-3.5" /> : String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${active ? 'text-[#633752]' : 'text-[#785f73]'}`}>{lesson.title}</span>
                  <span className="mt-0.5 block text-[11px] text-[#9a8293]">{lesson.concepts.slice(0, 2).join(' · ')}</span>
                </span>
                {active && <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[#8f2f61]" />}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mt-7 rounded-2xl border border-[#d9e3da] bg-[#f0f7f2] p-4">
        <div className="flex items-center gap-2 text-[#3f715f]"><LockKeyhole className="h-3.5 w-3.5" /><p className="text-xs font-medium">A local learning space</p></div>
        <p className="mt-2 text-[11px] leading-5 text-[#567463]">{previewMode ? 'Browser preview does not save drafts or progress.' : 'Drafts and progress stay in ThinkPink app storage on this device.'}</p>
      </div>
    </aside>
  );
}

function PreviewBanner() {
  return (
    <div role="status" data-testid="status-browser-preview" className="mt-6 flex items-start gap-3 rounded-xl border border-[#e1c9d5] bg-[#fff4f7] px-4 py-3.5 text-sm text-[#633752]">
      <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-[#8f2f61]" />
      <p className="leading-6"><span className="font-medium">Browser preview.</span> Drafts and progress reset when this preview closes. Code checks are disabled here because the desktop bridge is not connected.</p>
    </div>
  );
}

function LessonEditor({
  lesson,
  code,
  completed,
  checkState,
  checkResult,
  checkNotice,
  previewMode,
  onChange,
  onReset,
  onCheck,
  onCancelCheck,
  onToggleComplete,
}: {
  lesson: LearnLesson;
  code: string;
  completed: boolean;
  checkState: 'idle' | 'checking' | 'result';
  checkResult: CodeCheckResult | null;
  checkNotice: string | null;
  previewMode: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  onCheck: () => void;
  onCancelCheck: () => void;
  onToggleComplete: () => void;
}) {
  const passed = checkResult?.status === 'passed';
  return (
    <article className="min-w-0 rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 shadow-[0_12px_30px_rgba(67,40,63,.04)]">
      <div className="border-b border-[#eee0e6] px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[#f2dbe5] px-2.5 py-1 font-mono-ui text-[10px] uppercase tracking-[.12em] text-[#8f2f61]">{lesson.eyebrow}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[#eee8f1] px-2.5 py-1 text-[10px] text-[#785f73]"><Code2 className="h-3 w-3" /> {languageName(lesson.language)}</span>
          {lesson.kind === 'bridge' && <span className="rounded-full bg-[#f0f7f2] px-2.5 py-1 text-[10px] text-[#3f715f]">Bridge to {languageName(lesson.targetLanguage ?? 'python')}</span>}
        </div>
        <div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <h2 data-testid="text-current-lesson" className="font-display text-3xl tracking-[-.025em] text-[#43283f] sm:text-4xl">{lesson.title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#785f73]">{lesson.description}</p>
          </div>
          {completed && <span data-testid="status-lesson-complete" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#f0f7f2] px-3 py-2 text-xs font-medium text-[#3f715f]"><CheckCircle2 className="h-4 w-4" /> Complete</span>}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {lesson.concepts.map((concept) => <span key={concept} className="rounded-md border border-[#eadbe2] px-2 py-1 font-mono-ui text-[10px] text-[#785f73]">{concept}</span>)}
        </div>
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="learn-code-editor" className="flex items-center gap-2 text-sm font-medium text-[#633752]"><Terminal className="h-4 w-4 text-[#8f2f61]" /> Edit your starter code</label>
          <button type="button" onClick={onReset} data-testid="button-reset-code" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-[#785f73] hover:bg-[#f2dbe5]"><RotateCcw className="h-3 w-3" /> Reset starter</button>
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-[#513448] bg-[#39283a] shadow-[0_8px_22px_rgba(67,40,63,.14)]">
          <div className="flex items-center justify-between border-b border-[#614656] bg-[#43283f] px-3.5 py-2">
            <span className="font-mono-ui text-[10px] text-[#e5c7d4]">{lesson.language === 'java' ? 'Main.java' : 'main.py'}</span>
            <span className="font-mono-ui text-[10px] text-[#b996a9]">starter code</span>
          </div>
          <textarea
            id="learn-code-editor"
            value={code}
            onChange={(event) => onChange(event.target.value)}
            maxLength={MAX_SOURCE_LENGTH}
            spellCheck={false}
            aria-label={`${languageName(lesson.language)} starter code`}
            data-testid="textarea-lesson-code"
            className="min-h-[285px] w-full resize-y border-0 bg-transparent px-4 py-4 font-mono-ui text-[12px] leading-6 text-[#f7e9ee] outline-none placeholder:text-[#b996a9]"
          />
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-[11px] leading-5 text-[#785f73]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#3f715f]" /> Check compiles Java or checks Python syntax only. It does not run your code.</p>
          {checkState === 'checking' ? (
            <button type="button" onClick={onCancelCheck} data-testid="button-cancel-code-check" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[#dcb9c9] px-3.5 py-2.5 text-xs font-medium text-[#633752] hover:bg-[#f8e9ef]"><Square className="h-3 w-3 fill-current" /> Stop check</button>
          ) : (
            <button type="button" onClick={onCheck} disabled={previewMode} data-testid="button-check-code" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#8f2f61] px-3.5 py-2.5 text-xs font-medium text-white transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45"><FileCheck2 className="h-4 w-4" /> Check code</button>
          )}
        </div>
        {previewMode && <p data-testid="status-code-check-disabled" className="mt-3 rounded-lg bg-[#f5eff7] px-3 py-2.5 text-[11px] leading-5 text-[#785f73]">Code checks are disabled in browser preview. Open the packaged app for the local Java compiler or Python syntax check.</p>}
        {checkNotice && <p role="alert" data-testid="status-code-check-notice" className="mt-3 rounded-lg bg-[#fff0f1] px-3 py-2.5 text-[11px] leading-5 text-[#863f52]">{checkNotice}</p>}
        {checkResult && (
          <div role="status" aria-live="polite" data-testid="status-code-check-result" className={`mt-4 rounded-xl border p-4 ${passed ? 'border-[#cce0d5] bg-[#f0f7f2]' : 'border-[#e4bdc5] bg-[#fff2f3]'}`}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${passed ? 'bg-[#3f715f] text-white' : 'bg-[#b64378] text-white'}`}>{passed ? <Check className="h-4 w-4" /> : <CircleHelp className="h-4 w-4" />}</div>
              <div className="min-w-0">
                <p className={`text-sm font-medium ${passed ? 'text-[#3f715f]' : 'text-[#863f52]'}`}>{checkResult.message}</p>
                <p className="mt-1 text-[11px] leading-5 text-[#785f73]"><span className="font-mono-ui">{codeCheckLabel(checkResult.status)}</span>. No program was executed.</p>
              </div>
            </div>
            {checkResult.output && <pre data-testid="output-code-check" className="mt-3 overflow-x-auto rounded-lg bg-[#fffaf9] px-3 py-2.5 font-mono-ui text-[11px] leading-5 text-[#633752]">{checkResult.output}</pre>}
          </div>
        )}
        <div className="mt-5 flex flex-col gap-3 border-t border-[#eee0e6] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-5 text-[#9a8293]">Program execution is disabled. No isolated runner is implemented or verified in packaged builds.</p>
          <button type="button" onClick={onToggleComplete} data-testid="button-toggle-lesson-complete" className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-medium transition ${completed ? 'border-[#cce0d5] bg-[#f0f7f2] text-[#3f715f] hover:bg-[#e4f1e7]' : 'border-[#dcb9c9] text-[#633752] hover:bg-[#f8e9ef]'}`}>
            <CheckCircle2 className="h-4 w-4" /> {completed ? 'Mark as not complete' : 'Mark lesson complete'}
          </button>
        </div>
      </div>
    </article>
  );
}

function LessonNotes({ lesson }: { lesson: LearnLesson }) {
  return (
    <aside className="space-y-4">
      <div className="rounded-2xl border border-[#e8d7e0] bg-[#eee8f1]/70 p-5">
        <div className="flex items-center gap-2 text-[#633752]"><BookOpen className="h-4 w-4" /><p className="text-sm font-medium">A useful lens</p></div>
        <p data-testid="text-lesson-note" className="mt-3 text-sm leading-6 text-[#785f73]">{lesson.note}</p>
      </div>
      <div className="rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5">
        <div className="flex items-center gap-2 text-[#633752]"><ShieldCheck className="h-4 w-4 text-[#3f715f]" /><p className="text-sm font-medium">What stays here</p></div>
        <p className="mt-3 text-xs leading-5 text-[#785f73]">Your draft and lesson progress stay in local ThinkPink app storage. Nothing in this editor is sent to Ollama.</p>
      </div>
    </aside>
  );
}

function BridgeLessons({
  lessons,
  selectedId,
  completedLessonIds,
  onSelect,
}: {
  lessons: LearnLesson[];
  selectedId: string;
  completedLessonIds: string[];
  onSelect: (lesson: LearnLesson) => void;
}) {
  return (
    <section className="mt-8" aria-labelledby="bridge-lessons-title">
      <div className="flex flex-col justify-between gap-2 border-b border-[#eadbe2] pb-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#8f2f61]">Next perspective</p>
          <h2 id="bridge-lessons-title" className="mt-2 font-display text-3xl tracking-[-.025em] text-[#43283f]">Cross the language bridge.</h2>
        </div>
        <p className="max-w-sm text-xs leading-5 text-[#785f73]">The idea can stay familiar even when the punctuation changes.</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {lessons.map((lesson) => {
          const active = selectedId === lesson.id;
          const complete = completedLessonIds.includes(lesson.id);
          return (
            <button
              type="button"
              key={lesson.id}
              onClick={() => onSelect(lesson)}
              data-testid={`button-bridge-lesson-${lesson.id}`}
              className={`group rounded-2xl border p-4 text-left transition ${active ? 'border-[#c589a5] bg-[#fff4f7]' : 'border-[#e8d7e0] bg-[#fffaf9]/80 hover:border-[#d7b5c5] hover:bg-[#fff4f7]'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-[#8f2f61]">{lesson.eyebrow}</span>
                {complete ? <CheckCircle2 className="h-4 w-4 text-[#3f715f]" /> : <ChevronRight className="h-4 w-4 text-[#b58ba0] transition group-hover:translate-x-0.5" />}
              </div>
              <h3 className="mt-3 text-base font-medium text-[#633752]">{lesson.title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-[#785f73]">{lesson.description}</p>
              <div className="mt-3 flex items-center gap-2 text-[10px] text-[#9a8293]"><span className="rounded bg-[#eee8f1] px-1.5 py-1 font-mono-ui">{languageName(lesson.language)}</span><span>to</span><span className="rounded bg-[#f0f7f2] px-1.5 py-1 font-mono-ui text-[#3f715f]">{languageName(lesson.targetLanguage ?? 'python')}</span></div>
            </button>
          );
        })}
      </div>
    </section>
  );
}