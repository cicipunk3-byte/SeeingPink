import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle, LockKeyhole, MessageCircle, Settings2, ShieldCheck } from 'lucide-react';
import { ChatWorkspace } from '@/components/local-knowledge/ChatWorkspace';
import { ContextSettings, WikiWorkspace } from '@/components/local-knowledge/KnowledgeViews';
import type {
  HindsightSourceInput,
  HindsightSourceKind,
  HindsightStatus,
  HindsightWikiDraft,
  InstalledModel,
  ThinkPinkBridge,
} from '@/lib/thinkpinkBridge';
import {
  createEmptyThread,
  createLocalId,
  DEFAULT_LOCAL_SETTINGS,
  localKnowledgeStore,
  type ChatThread,
  type LocalBackupData,
  type LocalBackupImportResult,
  type LocalSettings,
  type WikiPage,
  type WikiPageDraft,
} from '@/lib/localKnowledge';
import {
  buildHindsightThreadSource,
  buildHindsightWikiSource,
} from '@/lib/hindsightSources';

type WorkspaceView = 'chat' | 'wiki' | 'settings';

const views: Array<{ id: WorkspaceView; label: string; description: string; icon: typeof MessageCircle }> = [
  { id: 'chat', label: 'Threads', description: 'Local conversations', icon: MessageCircle },
  { id: 'wiki', label: 'Wiki', description: 'Your shared context', icon: BookOpen },
  { id: 'settings', label: 'Settings', description: 'Control what is sent', icon: Settings2 },
];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ThinkPinkWorkspace({
  models,
  selectedModel,
  onSelectModel,
  previewMode,
}: {
  models: InstalledModel[];
  selectedModel: string;
  onSelectModel: (name: string) => void;
  previewMode: boolean;
}) {
  const [view, setView] = useState<WorkspaceView>('chat');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPage[]>([]);
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_LOCAL_SETTINGS);
  const [hasSavedSettings, setHasSavedSettings] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageAttention, setStorageAttention] = useState(false);
  const [savingWiki, setSavingWiki] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [hindsightStatus, setHindsightStatus] = useState<HindsightStatus | null>(null);
  const [hindsightProgress, setHindsightProgress] = useState<string | null>(null);
  const [hindsightError, setHindsightError] = useState<string | null>(null);
  const hindsightOperationQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStorageError(null);
    void Promise.all([
      localKnowledgeStore.listThreads(),
      localKnowledgeStore.listWikiPages(),
      localKnowledgeStore.loadSettings(),
      localKnowledgeStore.hasSavedSettings(),
    ]).then(([loadedThreads, loadedPages, loadedSettings, loadedSettingsExist]) => {
      if (cancelled) return;
      setThreads(loadedThreads);
      setWikiPages(loadedPages);
      setSettings(loadedSettings);
      setHasSavedSettings(loadedSettingsExist);
      const mostRecentThread = loadedThreads.find((thread) => !thread.archived) ?? null;
      setActiveThreadId(mostRecentThread?.id ?? null);
      setStorageAttention(false);
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setStorageError(errorText(error, 'ThinkPink could not open its local workspace.'));
      setStorageAttention(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const bridge = window.thinkPink;
    if (!bridge) return undefined;
    let cancelled = false;
    const unsubscribe = bridge.onHindsightProgress((event) => {
      if (!cancelled) setHindsightProgress(event.stage);
    });
    void bridge.getHindsightStatus().then((status) => {
      if (!cancelled) setHindsightStatus(status);
    }).catch((error: unknown) => {
      if (!cancelled) setHindsightError(errorText(error, 'ThinkPink could not read local Hindsight status.'));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads],
  );

  function enqueueHindsightOperation<Result>(action: () => Promise<Result>): Promise<Result> {
    const operation = hindsightOperationQueue.current.catch(() => undefined).then(action);
    hindsightOperationQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function runHindsightAction<Result>(
    action: (bridge: ThinkPinkBridge) => Promise<Result>,
    getStatus: (result: Result) => HindsightStatus,
  ): Promise<Result> {
    const bridge = window.thinkPink;
    if (!bridge) throw new Error('Local Hindsight is available only in the ThinkPink desktop app.');
    setHindsightError(null);
    setHindsightProgress('Working with local Hindsight');
    try {
      const result = await enqueueHindsightOperation(() => action(bridge));
      setHindsightStatus(getStatus(result));
      return result;
    } catch (error) {
      setHindsightError(errorText(error, 'The local Hindsight operation failed.'));
      throw error;
    } finally {
      setHindsightProgress(null);
    }
  }

  async function setupHindsight(modelName: string) {
    await runHindsightAction((bridge) => bridge.setupHindsight(modelName), (status) => status);
  }

  async function setHindsightEnabled(enabled: boolean, modelName: string) {
    await runHindsightAction(
      (bridge) => bridge.setHindsightEnabled(enabled, modelName),
      (status) => status,
    );
  }

  async function indexHindsightSource(source: HindsightSourceInput) {
    await runHindsightAction((bridge) => bridge.indexHindsightSource(source), (status) => status);
  }

  async function forgetHindsightSource(kind: HindsightSourceKind, id: string) {
    await runHindsightAction(
      (bridge) => bridge.forgetHindsightSource(kind, id),
      (status) => status,
    );
  }

  async function forgetAllHindsight() {
    await runHindsightAction((bridge) => bridge.forgetAllHindsight(), (status) => status);
  }

  async function searchHindsight(query: string) {
    return runHindsightAction(
      (bridge) => bridge.recallHindsight(query, 20),
      (result) => result.status,
    );
  }

  async function generateHindsightDraft(thread: ChatThread): Promise<HindsightWikiDraft> {
    return runHindsightAction(async (bridge) => {
      const draft = await bridge.generateHindsightDraft(buildHindsightThreadSource(thread));
      const status = await bridge.getHindsightStatus();
      return { draft, status };
    }, (result) => result.status).then((result) => result.draft);
  }

  function queueHindsightSync(source: HindsightSourceInput) {
    void enqueueHindsightOperation(async () => {
      const bridge = window.thinkPink;
      if (!bridge) return;
      try {
        const status = await bridge.getHindsightStatus();
        const wasIndexed = status.indexedSources.some(
          (item) => item.kind === source.kind && item.id === source.id,
        );
        if (!wasIndexed) {
          setHindsightStatus(status);
          return;
        }
        const result = await bridge.syncIndexedHindsightSource(source);
        setHindsightStatus(result.status);
        setHindsightError(null);
      } catch (error) {
        setHindsightError(`The local source was saved, but Hindsight could not sync it. ${errorText(error, 'Try again from Settings.')}`);
      }
    });
  }

  async function forgetHindsightBeforeDelete(kind: HindsightSourceKind, id: string) {
    const bridge = window.thinkPink;
    if (!bridge) return;
    const status = await enqueueHindsightOperation(() => bridge.forgetHindsightSource(kind, id));
    setHindsightStatus(status);
  }

  async function reconcileHindsightAfterImport(
    importedThreads: ChatThread[],
    importedPages: WikiPage[],
  ) {
    const bridge = window.thinkPink;
    if (!bridge) return;
    try {
      let status = await enqueueHindsightOperation(() => bridge.getHindsightStatus());
      for (const source of [...status.indexedSources]) {
        const thread = source.kind === 'thread'
          ? importedThreads.find((item) => item.id === source.id)
          : undefined;
        const page = source.kind === 'wiki'
          ? importedPages.find((item) => item.id === source.id)
          : undefined;
        if (thread) {
          status = (await enqueueHindsightOperation(() => bridge.syncIndexedHindsightSource(buildHindsightThreadSource(thread)))).status;
        } else if (page) {
          status = (await enqueueHindsightOperation(() => bridge.syncIndexedHindsightSource(buildHindsightWikiSource(page)))).status;
        } else {
          status = await enqueueHindsightOperation(() => bridge.forgetHindsightSource(source.kind, source.id));
        }
        setHindsightStatus(status);
      }
      setHindsightError(null);
    } catch (error) {
      setHindsightError(`Backup restored, but local Hindsight sources could not be reconciled. ${errorText(error, 'Review the selected sources in Settings.')}`);
    }
  }

  async function createThread() {
    setStorageError(null);
    const thread = createEmptyThread();
    try {
      await localKnowledgeStore.saveThread(thread);
      setThreads((current) => [thread, ...current]);
      setActiveThreadId(thread.id);
      setView('chat');
      setStorageAttention(false);
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not create a local thread.'));
      setStorageAttention(true);
    }
  }

  async function saveThread(thread: ChatThread) {
    setStorageError(null);
    if (thread.title.length > 100 || thread.summary.length > 12_000) {
      throw new Error('Thread title or summary exceeds the local size limit.');
    }
    if (thread.messages.some((message) => message.content.length > 50_000)) {
      throw new Error('A message is too large to save in this thread.');
    }
    try {
      await localKnowledgeStore.saveThread(thread);
      setThreads((current) => {
        const found = current.some((item) => item.id === thread.id);
        const next = found ? current.map((item) => item.id === thread.id ? thread : item) : [...current, thread];
        return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      });
      setStorageAttention(false);
      queueHindsightSync(buildHindsightThreadSource(thread));
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not save this local thread.'));
      setStorageAttention(true);
      throw error;
    }
  }

  async function archiveThread(id: string, archived: boolean) {
    const thread = threads.find((item) => item.id === id);
    if (!thread) return;
    try {
      await saveThread({ ...thread, archived, updatedAt: new Date().toISOString() });
      if (archived && activeThreadId === id) {
        const next = threads.find((item) => item.id !== id && !item.archived);
        setActiveThreadId(next?.id ?? null);
      }
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not update this local thread.'));
      setStorageAttention(true);
      throw error;
    }
  }

  async function deleteThread(id: string) {
    setStorageError(null);
    try {
      await forgetHindsightBeforeDelete('thread', id);
      await localKnowledgeStore.deleteThread(id);
      setThreads((current) => current.filter((thread) => thread.id !== id));
      setStorageAttention(false);
      if (activeThreadId === id) {
        const next = threads.find((thread) => thread.id !== id && !thread.archived);
        setActiveThreadId(next?.id ?? null);
      }
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not delete this local thread.'));
      setStorageAttention(true);
      throw error;
    }
  }

  async function saveWikiPage(id: string | null, draft: WikiPageDraft) {
    setSavingWiki(true);
    setStorageError(null);
    try {
      const existing = id ? wikiPages.find((page) => page.id === id) : undefined;
      if (id && !existing) throw new Error('This wiki page no longer exists. Reload local data and try again.');
      const normalized: WikiPageDraft = {
        title: draft.title.trim(),
        body: draft.body,
        category: draft.category.trim(),
        tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
      };
      if (!normalized.title) throw new Error('Give this wiki page a title before saving.');
      if (normalized.title.length > 120 || normalized.body.length > 50_000 || normalized.category.length > 80) {
        throw new Error('Wiki title, body, or category exceeds the local size limit. Shorten it and try again.');
      }
      if (normalized.tags.length > 24 || normalized.tags.some((tag) => tag.length > 40)) {
        throw new Error('Use at most 24 tags, with no tag longer than 40 characters.');
      }
      const now = new Date().toISOString();
      const page: WikiPage = {
        id: existing?.id ?? createLocalId(),
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await localKnowledgeStore.saveWikiPage(page);
      setWikiPages((current) => {
        const found = current.some((item) => item.id === page.id);
        return (found ? current.map((item) => item.id === page.id ? page : item) : [...current, page])
          .sort((left, right) => left.title.localeCompare(right.title));
      });
      setStorageAttention(false);
      queueHindsightSync(buildHindsightWikiSource(page));
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not save this local wiki page.'));
      setStorageAttention(true);
      throw error;
    } finally {
      setSavingWiki(false);
    }
  }

  async function deleteWikiPage(id: string) {
    setSavingWiki(true);
    setStorageError(null);
    try {
      await forgetHindsightBeforeDelete('wiki', id);
      await localKnowledgeStore.deleteWikiPage(id);
      setWikiPages((current) => current.filter((page) => page.id !== id));
      setThreads((current) => current.map((thread) => thread.wikiPageIds.includes(id)
        ? { ...thread, wikiPageIds: thread.wikiPageIds.filter((pageId) => pageId !== id) }
        : thread));
      setStorageAttention(false);
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not delete this local wiki page.'));
      setStorageAttention(true);
      throw error;
    } finally {
      setSavingWiki(false);
    }
  }

  async function saveSettings(nextSettings: LocalSettings) {
    setSavingSettings(true);
    setStorageError(null);
    try {
      await localKnowledgeStore.saveSettings(nextSettings);
      setSettings(nextSettings);
      setHasSavedSettings(true);
      setStorageAttention(false);
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not save local context settings.'));
      setStorageAttention(true);
      throw error;
    } finally {
      setSavingSettings(false);
    }
  }

  async function importBackup(backup: LocalBackupData, replaceConflicts: boolean): Promise<LocalBackupImportResult> {
    setStorageError(null);
    try {
      const result = await localKnowledgeStore.importBackup(backup, replaceConflicts);
      const [loadedThreads, loadedPages, loadedSettings, loadedSettingsExist] = await Promise.all([
        localKnowledgeStore.listThreads(),
        localKnowledgeStore.listWikiPages(),
        localKnowledgeStore.loadSettings(),
        localKnowledgeStore.hasSavedSettings(),
      ]);
      setThreads(loadedThreads);
      setWikiPages(loadedPages);
      setSettings(loadedSettings);
      setHasSavedSettings(loadedSettingsExist);
      setStorageAttention(false);
      void reconcileHindsightAfterImport(loadedThreads, loadedPages);
      return result;
    } catch (error) {
      setStorageError(errorText(error, 'ThinkPink could not restore this local backup.'));
      setStorageAttention(true);
      throw error;
    }
  }

  return (
    <section className="w-full" data-testid="workspace-local-ground-control">
      <header className="mb-5 flex flex-col gap-4 border-b border-[#eadbe2] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.22em] text-[#8f2f61]"><ShieldCheck className="h-3.5 w-3.5" /> ThinkPink Ground Control</p>
          <h2 className="mt-3 font-display text-3xl tracking-[-.035em] text-[#43283f] sm:text-4xl">{views.find((item) => item.id === view)?.label}</h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#785f73]">Long-running local conversations and a shared wiki, with context choices visible before each request.</p>
        </div>
        <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-2 text-[10px] ${storageAttention ? 'border-[#e6bfc7] bg-[#fff2f3] text-[#863f52]' : 'border-[#cce0d5] bg-[#f0f7f2] text-[#3f715f]'}`} data-testid="status-local-storage">
          <LockKeyhole className="h-3.5 w-3.5" />{storageAttention ? 'Local storage needs attention' : loading ? 'Checking this device' : 'Saved on this device'}
        </span>
      </header>

      <nav className="mb-5 flex flex-wrap gap-2" aria-label="ThinkPink Ground Control">
        {views.map(({ id, label, description, icon: Icon }) => (
          <button key={id} type="button" onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined} data-testid={`button-ground-control-${id}`} className={`group inline-flex min-w-[130px] items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition ${view === id ? 'border-[#c589a5] bg-[#f8e9ef] text-[#633752] shadow-[0_5px_16px_rgba(143,47,97,.08)]' : 'border-[#e8d7e0] bg-[#fffaf9]/80 text-[#785f73] hover:border-[#d7b5c5] hover:bg-[#fff4f7]'}`}>
            <Icon className={`h-4 w-4 ${view === id ? 'text-[#8f2f61]' : 'text-[#a17e94]'}`} />
            <span><span className="block text-xs font-medium">{label}</span><span className="mt-0.5 block text-[9px] text-[#8b7182]">{description}</span></span>
          </button>
        ))}
      </nav>

      {loading ? (
        <div role="status" data-testid="status-local-workspace-loading" className="flex min-h-[420px] items-center justify-center rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/80 text-sm text-[#785f73]">
          <span className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" /> Opening local threads and wiki…</span>
        </div>
      ) : storageError && threads.length === 0 && wikiPages.length === 0 ? (
        <div role="alert" data-testid="status-local-workspace-error" className="rounded-2xl border border-[#e6bfc7] bg-[#fff2f3] p-6 text-sm text-[#863f52]">
          <p className="font-medium">Local workspace unavailable</p>
          <p className="mt-2 leading-6">{storageError}</p>
          <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} data-testid="button-retry-local-workspace" className="mt-4 rounded-lg border border-[#dcb9c9] bg-white px-3 py-2 text-xs font-medium text-[#633752] hover:bg-[#f8e9ef]">Try again</button>
        </div>
      ) : (
        <>
          {storageError && <div role="alert" data-testid="status-local-workspace-warning" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e6bfc7] bg-[#fff2f3] px-3 py-2.5 text-xs text-[#863f52]"><span>{storageError}</span><button type="button" onClick={() => setStorageError(null)} data-testid="button-dismiss-local-storage-warning" className="rounded-md border border-[#e6bfc7] bg-white px-2.5 py-1.5 text-[10px] font-medium text-[#863f52]">Dismiss</button></div>}
          <ChatWorkspace
            active={view === 'chat'}
            models={models}
            model={models.find((item) => item.name === selectedModel) ?? models[0]}
            onSelectModel={onSelectModel}
            previewMode={previewMode}
            threads={threads}
            activeThread={activeThread}
            wikiPages={wikiPages}
            settings={settings}
            storageError={storageError}
            hindsightEnabled={Boolean(hindsightStatus?.enabled)}
            hindsightProgress={hindsightProgress}
            onSearchHindsight={searchHindsight}
            onGenerateHindsightDraft={generateHindsightDraft}
            onSaveWikiDraft={async (draft) => {
              await saveWikiPage(null, draft);
              setView('wiki');
            }}
            onCreateThread={createThread}
            onSelectThread={setActiveThreadId}
            onSaveThread={saveThread}
            onArchiveThread={archiveThread}
            onDeleteThread={deleteThread}
          />
          <div hidden={view !== 'wiki'}>
            <WikiWorkspace
              pages={wikiPages}
              busy={savingWiki}
              error={null}
              onSave={saveWikiPage}
              onDelete={deleteWikiPage}
            />
          </div>
          <div hidden={view !== 'settings'}>
            <ContextSettings
              settings={settings}
              hasSavedSettings={hasSavedSettings}
              threads={threads}
              wikiPages={wikiPages}
              busy={savingSettings}
              error={null}
              hindsightAvailable={Boolean(window.thinkPink)}
              hindsightStatus={hindsightStatus}
              hindsightProgress={hindsightProgress}
              hindsightError={hindsightError}
              models={models}
              selectedModel={selectedModel}
              onSetupHindsight={setupHindsight}
              onSetHindsightEnabled={setHindsightEnabled}
              onIndexHindsightSource={indexHindsightSource}
              onForgetHindsightSource={forgetHindsightSource}
              onForgetAllHindsight={forgetAllHindsight}
              onSave={saveSettings}
              onImportBackup={importBackup}
            />
          </div>
        </>
      )}
    </section>
  );
}