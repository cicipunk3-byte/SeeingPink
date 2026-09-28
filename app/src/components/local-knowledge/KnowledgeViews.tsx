import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { BackupRestorePanel } from '@/components/local-knowledge/BackupRestorePanel';
import { HindsightSettings } from '@/components/local-knowledge/HindsightSettings';
import type {
  ChatThread,
  LocalBackupData,
  LocalBackupImportResult,
  LocalSettings,
  WikiPage,
  WikiPageDraft,
  WikiContextMode,
} from '@/lib/localKnowledge';
import type {
  HindsightSourceInput,
  HindsightSourceKind,
  HindsightStatus,
  InstalledModel,
} from '@/lib/thinkpinkBridge';

type SaveState = 'idle' | 'saved' | 'error';

const modeOptions: Array<{
  value: WikiContextMode;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    value: 'manual',
    label: 'Manual attachment',
    shortLabel: 'Manual',
    description: 'You decide which pages travel with each chat request.',
  },
  {
    value: 'approval',
    label: 'Suggestions for approval',
    shortLabel: 'Ask first',
    description: 'ThinkPink suggests relevant pages, then waits for your approval.',
  },
  {
    value: 'automatic',
    label: 'Automatic relevant pages',
    shortLabel: 'Automatic',
    description: 'Relevant pages are included without an extra confirmation step.',
  },
];

const tokenOptions: Array<LocalSettings['contextWindowTokens']> = [2048, 4096, 8192];

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Updated recently';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function emptyDraft(): WikiPageDraft {
  return { title: '', body: '', category: '', tags: [] };
}

function splitTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, values) => values.indexOf(tag) === index);
}

function pageSearchText(page: WikiPage) {
  return [page.title, page.body, page.category, ...page.tags].join(' ').toLocaleLowerCase();
}

function StatusMessage({ children, tone = 'neutral', testId }: { children: string; tone?: 'neutral' | 'error' | 'success'; testId: string }) {
  const styles = {
    neutral: 'border-[#e5d7df] bg-[#f7f0f4] text-[#6f5267]',
    error: 'border-[#e8c4cc] bg-[#fff2f3] text-[#8c304f]',
    success: 'border-[#c9ded2] bg-[#f0f8f2] text-[#376b58]',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} aria-live="polite" data-testid={testId} className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${styles[tone]}`}>
      {tone === 'error' ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : tone === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

function FieldLabel({ htmlFor, children, hint }: { htmlFor: string; children: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6f5267]">{children}</label>
      {hint && <span className="text-[11px] text-[#987f91]">{hint}</span>}
    </div>
  );
}

export function WikiWorkspace({
  pages,
  busy,
  error,
  onSave,
  onDelete,
}: {
  pages: WikiPage[];
  busy: boolean;
  error: string | null;
  onSave: (id: string | null, draft: WikiPageDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<WikiPageDraft>(emptyDraft);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WikiPage | null>(null);

  const filteredPages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return pages
      .filter((page) => !normalized || pageSearchText(page).includes(normalized))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [pages, query]);

  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? null,
    [pages, selectedPageId],
  );

  useEffect(() => {
    if (isCreating) return;
    if (pages.length === 0) {
      setSelectedPageId(null);
      setDraft(emptyDraft());
      return;
    }
    if (!selectedPageId || !pages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pages[0].id);
    }
  }, [isCreating, pages, selectedPageId]);

  useEffect(() => {
    if (isCreating) return;
    if (selectedPage) {
      setDraft({
        title: selectedPage.title,
        body: selectedPage.body,
        category: selectedPage.category,
        tags: selectedPage.tags,
      });
      setSaveState('idle');
      setActionError(null);
    }
  }, [isCreating, selectedPage]);

  const tagsValue = draft.tags.join(', ');
  const isFilteredEmpty = pages.length > 0 && filteredPages.length === 0;

  function beginCreate() {
    setIsCreating(true);
    setSelectedPageId(null);
    setDraft(emptyDraft());
    setSaveState('idle');
    setActionError(null);
    setDeleteTarget(null);
  }

  function selectPage(page: WikiPage) {
    setIsCreating(false);
    setSelectedPageId(page.id);
    setSaveState('idle');
    setActionError(null);
    setDeleteTarget(null);
  }

  function updateDraft<Key extends keyof WikiPageDraft>(key: Key, value: WikiPageDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState('idle');
    setActionError(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) {
      setActionError('Give this page a title before saving.');
      return;
    }
    const nextDraft: WikiPageDraft = {
      title,
      body: draft.body.trim(),
      category: draft.category.trim(),
      tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
    };
    setActionError(null);
    try {
      await onSave(isCreating ? null : selectedPageId, nextDraft);
      setDraft(nextDraft);
      setSaveState('saved');
      if (isCreating) setIsCreating(false);
    } catch (saveError) {
      setSaveState('error');
      setActionError(saveError instanceof Error ? saveError.message : 'The page could not be saved locally.');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
      setSelectedPageId(null);
      setSaveState('idle');
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : 'The page could not be deleted locally.');
    }
  }

  return (
    <section data-testid="view-wiki-workspace" className="rise-in w-full">
      <div className="flex flex-col gap-6 border-b border-[#e8d7e0] pb-7 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[#8f2f61]">
            <BookOpen className="h-4 w-4" />
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.23em]">Local wiki</p>
          </div>
          <h1 data-testid="text-wiki-heading" className="mt-3 max-w-2xl font-display text-5xl leading-[0.96] tracking-[-0.045em] text-[#43283f] sm:text-6xl">Keep the threads you want to return to.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[#785f73]">A private shelf for ideas, references, and the questions that keep moving.</p>
        </div>
        <button type="button" onClick={beginCreate} disabled={busy} data-testid="button-create-wiki-page" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] shadow-[0_7px_16px_rgba(143,47,97,.16)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-50">
          <Plus className="h-4 w-4" />
          New wiki page
        </button>
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.55fr)]">
        <aside className="min-w-0 rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/80 p-3 shadow-[0_12px_32px_rgba(67,40,63,.05)]">
          <div className="px-2 pb-3 pt-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#987f91]" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search wiki pages"
                placeholder="Search pages"
                data-testid="input-search-wiki-pages"
                className="w-full rounded-xl border border-[#e4d4de] bg-[#fdf7f8] py-2.5 pl-9 pr-3 text-sm text-[#43283f] placeholder:text-[#a58e9e] focus:border-[#b64378] focus:bg-[#fffaf9] focus:outline-none"
              />
            </div>
            <div className="mt-3 flex items-center justify-between px-1">
              <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-[#987f91]">Your pages</p>
              <span data-testid="text-wiki-page-count" className="font-mono-ui text-[11px] text-[#987f91]">{filteredPages.length} of {pages.length}</span>
            </div>
          </div>

          {busy && pages.length === 0 ? (
            <div data-testid="status-wiki-loading" className="space-y-2 p-2" aria-label="Loading wiki pages">
              {[1, 2, 3].map((item) => <div key={item} className="h-[76px] animate-pulse rounded-xl bg-[#f3e8ee]" />)}
            </div>
          ) : isFilteredEmpty ? (
            <div data-testid="empty-wiki-search" className="rounded-xl border border-dashed border-[#ddc7d3] bg-[#fbf3f6] px-4 py-8 text-center">
              <Search className="mx-auto h-5 w-5 text-[#b27d99]" />
              <p className="mt-3 text-sm font-medium text-[#633752]">No pages match that search.</p>
              <button type="button" onClick={() => setQuery('')} data-testid="button-clear-wiki-search" className="mt-2 text-xs font-medium text-[#8f2f61] hover:underline">Clear search</button>
            </div>
          ) : pages.length === 0 ? (
            <div data-testid="empty-wiki-pages" className="rounded-xl border border-dashed border-[#ddc7d3] bg-[#fbf3f6] px-4 py-8 text-center">
              <FileText className="mx-auto h-5 w-5 text-[#b27d99]" />
              <p className="mt-3 text-sm font-medium text-[#633752]">Your wiki is waiting.</p>
              <p className="mt-1 text-xs leading-5 text-[#987f91]">Start with a question, a source, or a useful thread.</p>
              <button type="button" onClick={beginCreate} data-testid="button-create-first-wiki-page" className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8f2f61] hover:underline"><Plus className="h-3.5 w-3.5" /> Create your first page</button>
            </div>
          ) : (
            <div data-testid="list-wiki-pages" className="space-y-1.5">
              {filteredPages.map((page) => {
                const selected = !isCreating && selectedPageId === page.id;
                return (
                  <button
                    type="button"
                    key={page.id}
                    onClick={() => selectPage(page)}
                    aria-pressed={selected}
                    data-testid={`button-select-wiki-page-${page.id}`}
                    className={`group flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition duration-200 ${selected ? 'bg-[#f2dbe5] text-[#43283f]' : 'text-[#6f5267] hover:bg-[#fbf0f4]'}`}
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-[#8f2f61]' : 'bg-[#d2afc0]'}`} />
                    <span className="min-w-0 flex-1">
                      <span data-testid={`text-wiki-page-title-${page.id}`} className="block truncate text-sm font-medium">{page.title || 'Untitled page'}</span>
                      <span className="mt-1 flex items-center gap-2 text-[11px] text-[#987f91]">
                        <span className="truncate">{page.category || 'Unsorted'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatUpdatedAt(page.updatedAt)}</span>
                      </span>
                    </span>
                    <ChevronRight className={`mt-1 h-4 w-4 shrink-0 transition-transform ${selected ? 'translate-x-0 text-[#8f2f61]' : '-translate-x-1 text-[#c3a7b5] opacity-0 group-hover:translate-x-0 group-hover:opacity-100'}`} />
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <div className="min-w-0">
          {error && <StatusMessage tone="error" testId="status-wiki-error">{error}</StatusMessage>}
          {actionError && <div className={error ? 'mt-3' : ''}><StatusMessage tone="error" testId="status-wiki-action-error">{actionError}</StatusMessage></div>}

          {isCreating || selectedPage ? (
            <form onSubmit={handleSave} data-testid="form-wiki-page" className={`${error || actionError ? 'mt-5' : ''} rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5 shadow-[0_12px_32px_rgba(67,40,63,.05)] sm:p-7`}>
              <div className="flex flex-col gap-3 border-b border-[#eee0e6] pb-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[0.2em] text-[#8f2f61]">{isCreating ? 'New entry' : 'Wiki page'}</p>
                  <h2 data-testid="text-wiki-editor-heading" className="mt-2 font-display text-3xl tracking-[-0.03em] text-[#43283f]">{isCreating ? 'Give the thought a place.' : draft.title || 'Untitled page'}</h2>
                </div>
                {!isCreating && selectedPage && (
                  <button type="button" onClick={() => setDeleteTarget(selectedPage)} disabled={busy} data-testid={`button-delete-wiki-page-${selectedPage.id}`} className="inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-2 text-xs font-medium text-[#8c304f] transition hover:bg-[#fff0f2] disabled:cursor-not-allowed disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}
              </div>

              {deleteTarget && (
                <div data-testid="dialog-confirm-delete-wiki-page" role="alertdialog" aria-labelledby="delete-wiki-title" className="mt-5 rounded-xl border border-[#e8c4cc] bg-[#fff2f3] p-4">
                  <div className="flex items-start gap-3">
                    <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8c304f]" />
                    <div className="min-w-0 flex-1">
                      <p id="delete-wiki-title" className="text-sm font-semibold text-[#75304f]">Delete “{deleteTarget.title || 'Untitled page'}”?</p>
                      <p className="mt-1 text-xs leading-5 text-[#8c304f]">This removes the page from your local wiki. This cannot be undone.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void handleDelete()} disabled={busy} data-testid="button-confirm-delete-wiki-page" className="rounded-lg bg-[#8c304f] px-3 py-2 text-xs font-semibold text-[#fff9fb] transition hover:bg-[#6f2948] disabled:opacity-50">Delete page</button>
                        <button type="button" onClick={() => setDeleteTarget(null)} data-testid="button-cancel-delete-wiki-page" className="rounded-lg border border-[#dfb7c2] bg-[#fffaf9] px-3 py-2 text-xs font-medium text-[#75304f] hover:bg-[#fce5ea]">Keep page</button>
                      </div>
                    </div>
                    <button type="button" onClick={() => setDeleteTarget(null)} aria-label="Close delete confirmation" data-testid="button-close-delete-confirmation" className="rounded-md p-1 text-[#8c304f] hover:bg-[#fce5ea]"><X className="h-4 w-4" /></button>
                  </div>
                </div>
              )}

              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <FieldLabel htmlFor="wiki-page-title" hint="Required">Title</FieldLabel>
                  <input id="wiki-page-title" type="text" value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} maxLength={120} placeholder="A clear name for this thread" data-testid="input-wiki-page-title" className="w-full rounded-xl border border-[#e3d2dc] bg-[#fdf8f9] px-3.5 py-3 text-sm text-[#43283f] placeholder:text-[#b19aaa] focus:border-[#b64378] focus:bg-[#fffaf9] focus:outline-none" />
                </div>
                <div>
                  <FieldLabel htmlFor="wiki-page-category">Category</FieldLabel>
                  <input id="wiki-page-category" type="text" value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} maxLength={80} placeholder="Research, notes, questions..." data-testid="input-wiki-page-category" className="w-full rounded-xl border border-[#e3d2dc] bg-[#fdf8f9] px-3.5 py-3 text-sm text-[#43283f] placeholder:text-[#b19aaa] focus:border-[#b64378] focus:bg-[#fffaf9] focus:outline-none" />
                </div>
                <div>
                  <FieldLabel htmlFor="wiki-page-tags" hint="Comma-separated">Tags</FieldLabel>
                  <div className="relative">
                    <Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#a9869a]" />
                    <input id="wiki-page-tags" type="text" value={tagsValue} onChange={(event) => updateDraft('tags', splitTags(event.target.value))} maxLength={1_100} placeholder="attention, source, open question" data-testid="input-wiki-page-tags" className="w-full rounded-xl border border-[#e3d2dc] bg-[#fdf8f9] py-3 pl-9 pr-3.5 text-sm text-[#43283f] placeholder:text-[#b19aaa] focus:border-[#b64378] focus:bg-[#fffaf9] focus:outline-none" />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <FieldLabel htmlFor="wiki-page-body" hint="Private to this local workspace">Body</FieldLabel>
                  <textarea id="wiki-page-body" value={draft.body} onChange={(event) => updateDraft('body', event.target.value)} maxLength={50_000} placeholder="Write what you want to remember..." rows={12} data-testid="textarea-wiki-page-body" className="w-full resize-y rounded-xl border border-[#e3d2dc] bg-[#fdf8f9] px-3.5 py-3 text-sm leading-6 text-[#43283f] placeholder:text-[#b19aaa] focus:border-[#b64378] focus:bg-[#fffaf9] focus:outline-none" />
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-4 border-t border-[#eee0e6] pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-h-5 text-xs text-[#987f91]">
                  {saveState === 'saved' && <span data-testid="status-wiki-saved" className="inline-flex items-center gap-1.5 text-[#376b58]"><Check className="h-3.5 w-3.5" /> Saved to this device</span>}
                  {saveState === 'error' && <span data-testid="status-wiki-save-error" className="text-[#8c304f]">Save did not complete. Try again.</span>}
                  {saveState === 'idle' && !isCreating && selectedPage && <span data-testid="text-wiki-last-updated">Last updated {formatUpdatedAt(selectedPage.updatedAt)}</span>}
                </div>
                <button type="submit" disabled={busy} data-testid="button-save-wiki-page" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] transition duration-200 hover:-translate-y-0.5 hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-50">
                  <Save className="h-4 w-4" />
                  {busy ? 'Saving locally...' : isCreating ? 'Save page' : 'Save changes'}
                </button>
              </div>
            </form>
          ) : (
            <div data-testid="empty-wiki-editor" className={`${error || actionError ? 'mt-5' : ''} flex min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#ddc7d3] bg-[#fbf3f6] px-6 text-center`}>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f2dbe5] text-[#8f2f61]"><BookOpen className="h-5 w-5" /></div>
              <h2 className="mt-5 font-display text-3xl tracking-[-0.03em] text-[#43283f]">Choose a page to begin.</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-[#785f73]">Select an entry from your wiki, or make a new page for the thought you are following.</p>
              <button type="button" onClick={beginCreate} data-testid="button-create-wiki-page-empty-editor" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] hover:bg-[#75304f]"><Plus className="h-4 w-4" /> New wiki page</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function ContextSettings({
  settings,
  hasSavedSettings,
  threads,
  wikiPages,
  busy,
  error,
  hindsightAvailable,
  hindsightStatus,
  hindsightProgress,
  hindsightError,
  models,
  selectedModel,
  onSetupHindsight,
  onSetHindsightEnabled,
  onIndexHindsightSource,
  onForgetHindsightSource,
  onForgetAllHindsight,
  onSave,
  onImportBackup,
}: {
  settings: LocalSettings;
  hasSavedSettings: boolean;
  threads: ChatThread[];
  wikiPages: WikiPage[];
  busy: boolean;
  error: string | null;
  hindsightAvailable: boolean;
  hindsightStatus: HindsightStatus | null;
  hindsightProgress: string | null;
  hindsightError: string | null;
  models: InstalledModel[];
  selectedModel: string;
  onSetupHindsight: (modelName: string) => Promise<void>;
  onSetHindsightEnabled: (enabled: boolean, modelName: string) => Promise<void>;
  onIndexHindsightSource: (source: HindsightSourceInput) => Promise<void>;
  onForgetHindsightSource: (kind: HindsightSourceKind, id: string) => Promise<void>;
  onForgetAllHindsight: () => Promise<void>;
  onSave: (settings: LocalSettings) => Promise<void>;
  onImportBackup: (backup: LocalBackupData, replaceConflicts: boolean) => Promise<LocalBackupImportResult>;
}) {
  const [draft, setDraft] = useState<LocalSettings>(settings);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
    setSaveState('idle');
  }, [settings]);

  function updateSettings(patch: Partial<LocalSettings>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveState('idle');
    setActionError(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    try {
      await onSave(draft);
      setSaveState('saved');
    } catch (saveError) {
      setSaveState('error');
      setActionError(saveError instanceof Error ? saveError.message : 'Settings could not be saved locally.');
    }
  }

  return (
    <section data-testid="view-context-settings" className="rise-in w-full">
      <div className="border-b border-[#e8d7e0] pb-7">
        <div className="flex items-center gap-2 text-[#8f2f61]">
          <Settings2 className="h-4 w-4" />
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.23em]">Local context</p>
        </div>
        <h1 data-testid="text-context-settings-heading" className="mt-3 max-w-2xl font-display text-5xl leading-[0.96] tracking-[-0.045em] text-[#43283f] sm:text-6xl">Choose how much of your shelf enters the room.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-[#785f73]">These preferences shape wiki context in local chats. You stay in control of what ThinkPink includes.</p>
      </div>

      <form onSubmit={handleSave} data-testid="form-context-settings" className="mt-6 max-w-4xl">
        {error && <StatusMessage tone="error" testId="status-context-settings-error">{error}</StatusMessage>}
        {actionError && <div className={error ? 'mt-3' : ''}><StatusMessage tone="error" testId="status-context-action-error">{actionError}</StatusMessage></div>}

        <div className={`${error || actionError ? 'mt-5' : ''} grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]`}>
          <fieldset className="rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5 shadow-[0_12px_32px_rgba(67,40,63,.05)] sm:p-7">
            <legend className="sr-only">Default wiki context behavior</legend>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f2dbe5] text-[#8f2f61]"><SlidersHorizontal className="h-4 w-4" /></div>
              <div>
                <h2 className="font-display text-2xl tracking-[-0.025em] text-[#43283f]">Default wiki behavior</h2>
                <p className="mt-1.5 text-sm leading-6 text-[#785f73]">This applies to threads set to use the settings default. Choose a different mode on a thread to override it.</p>
              </div>
            </div>

            <div role="radiogroup" aria-label="Default wiki context behavior" className="mt-6 space-y-3">
              {modeOptions.map((option) => {
                const selected = draft.defaultWikiContextMode === option.value;
                return (
                  <label key={option.value} data-testid={`option-context-mode-${option.value}`} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition duration-200 ${selected ? 'border-[#b64378] bg-[#fbecf2] shadow-[0_4px_12px_rgba(143,47,97,.06)]' : 'border-[#e7d9e0] bg-[#fdf8f9] hover:border-[#d5b4c4] hover:bg-[#fcf2f5]'}`}>
                    <input
                      type="radio"
                      name="default-wiki-context-mode"
                      value={option.value}
                      checked={selected}
                      onChange={() => updateSettings({ defaultWikiContextMode: option.value })}
                      data-testid={`input-context-mode-${option.value}`}
                      className="mt-1 h-4 w-4 accent-[#8f2f61]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-[#43283f]">{option.label}</span>
                        {option.value === 'manual' && <span className="rounded-full bg-[#ead7e1] px-2 py-0.5 font-mono-ui text-[9px] uppercase tracking-[0.12em] text-[#8f2f61]">Default</span>}
                      </span>
                      <span data-testid={`text-context-mode-description-${option.value}`} className="mt-1 block text-xs leading-5 text-[#785f73]">{option.description}</span>
                    </span>
                    <span className={`hidden rounded-full px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[0.11em] sm:inline-flex ${selected ? 'bg-[#e8c5d5] text-[#8f2f61]' : 'bg-[#f0e5eb] text-[#987f91]'}`}>{option.shortLabel}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-5">
            <section className="rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5 shadow-[0_12px_32px_rgba(67,40,63,.05)] sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eee8f1] text-[#633752]"><FileText className="h-4 w-4" /></div>
                <div>
                  <h2 className="font-display text-2xl tracking-[-0.025em] text-[#43283f]">Context window</h2>
                  <p className="mt-1.5 text-sm leading-6 text-[#785f73]">An approximate token budget for the full local request, including chat history and wiki context.</p>
                </div>
              </div>
              <div className="mt-5">
                <FieldLabel htmlFor="context-window-tokens">Token budget</FieldLabel>
                <select id="context-window-tokens" value={draft.contextWindowTokens} onChange={(event) => updateSettings({ contextWindowTokens: Number(event.target.value) as LocalSettings['contextWindowTokens'] })} data-testid="select-context-window-tokens" className="w-full appearance-none rounded-xl border border-[#e3d2dc] bg-[#fdf8f9] px-3.5 py-3 text-sm text-[#43283f] focus:border-[#b64378] focus:outline-none">
                  {tokenOptions.map((tokens) => <option key={tokens} value={tokens}>{tokens.toLocaleString()} tokens</option>)}
                </select>
              </div>
            </section>

            <section data-testid="panel-local-context-note" className="rounded-2xl border border-[#d5e4db] bg-[#f1f8f3] p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#3f715f]" />
                <div>
                  <h2 className="text-sm font-semibold text-[#376b58]">Your pages stay on this device.</h2>
                  <p className="mt-2 text-xs leading-5 text-[#4f7968]">Manual mode is the default. Wiki pages are sent only to your local Ollama model when they are included in a chat request.</p>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4 border-t border-[#e8d7e0] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-xs text-[#987f91]">
            {saveState === 'saved' && <span data-testid="status-context-settings-saved" className="inline-flex items-center gap-1.5 text-[#376b58]"><Check className="h-3.5 w-3.5" /> Settings saved to this device</span>}
            {saveState === 'error' && <span data-testid="status-context-settings-save-error" className="text-[#8c304f]">Save did not complete. Try again.</span>}
            {saveState === 'idle' && <span data-testid="text-context-settings-local-note">Changes apply to new local chat requests.</span>}
          </div>
          <button type="submit" disabled={busy} data-testid="button-save-context-settings" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] transition duration-200 hover:-translate-y-0.5 hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-50">
            <Save className="h-4 w-4" />
            {busy ? 'Saving locally...' : 'Save settings'}
          </button>
        </div>
      </form>

      <HindsightSettings
        available={hindsightAvailable}
        status={hindsightStatus}
        threads={threads}
        wikiPages={wikiPages}
        models={models}
        selectedModel={selectedModel}
        progress={hindsightProgress}
        error={hindsightError}
        onSetup={onSetupHindsight}
        onSetEnabled={onSetHindsightEnabled}
        onIndex={onIndexHindsightSource}
        onForget={onForgetHindsightSource}
        onForgetAll={onForgetAllHindsight}
      />

      <BackupRestorePanel
        threads={threads}
        wikiPages={wikiPages}
        settings={settings}
        hasSavedSettings={hasSavedSettings}
        onImport={onImportBackup}
      />
    </section>
  );
}