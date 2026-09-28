import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive,
  BookOpen,
  ChevronDown,
  CircleHelp,
  LoaderCircle,
  MessageCircle,
  Plus,
  Radio,
  Search,
  Send,
  Sparkles,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatEvent, HindsightWikiDraft, InstalledModel, ThinkPinkBridge } from '@/lib/thinkpinkBridge';
import {
  createLocalId,
  type ChatThread,
  type LocalSettings,
  type ThreadMessage,
  type WikiContextMode,
  type WikiPage,
  type WikiPageDraft,
} from '@/lib/localKnowledge';
import {
  buildChatContext,
  findRelevantWikiPages,
  resolveThreadWikiMode,
} from '@/lib/chatContext';

const modeLabels: Record<WikiContextMode, string> = {
  manual: 'Attach pages manually',
  approval: 'Suggest pages for approval',
  automatic: 'Automatically include relevant pages',
};

type ChatWorkspaceProps = {
  active: boolean;
  models: InstalledModel[];
  model: InstalledModel;
  onSelectModel: (name: string) => void;
  previewMode: boolean;
  threads: ChatThread[];
  activeThread: ChatThread | null;
  wikiPages: WikiPage[];
  settings: LocalSettings;
  storageError: string | null;
  hindsightEnabled: boolean;
  hindsightProgress: string | null;
  onSearchHindsight: (query: string) => Promise<Awaited<ReturnType<ThinkPinkBridge['recallHindsight']>>>;
  onGenerateHindsightDraft: (thread: ChatThread) => Promise<HindsightWikiDraft>;
  onSaveWikiDraft: (draft: WikiPageDraft) => Promise<void>;
  onCreateThread: () => Promise<void>;
  onSelectThread: (id: string) => void;
  onSaveThread: (thread: ChatThread) => Promise<void>;
  onArchiveThread: (id: string, archived: boolean) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
};

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved locally';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function ChatWorkspace({
  active,
  models,
  model,
  onSelectModel,
  previewMode,
  threads,
  activeThread,
  wikiPages,
  settings,
  storageError,
  hindsightEnabled,
  hindsightProgress,
  onSearchHindsight,
  onGenerateHindsightDraft,
  onSaveWikiDraft,
  onCreateThread,
  onSelectThread,
  onSaveThread,
  onArchiveThread,
  onDeleteThread,
}: ChatWorkspaceProps) {
  const [composer, setComposer] = useState('');
  const [chatState, setChatState] = useState<'idle' | 'sending' | 'error' | 'cancelled'>('idle');
  const [localError, setLocalError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [approvedSuggestionIds, setApprovedSuggestionIds] = useState<string[]>([]);
  const [hindsightPageIds, setHindsightPageIds] = useState<string[]>([]);
  const [hindsightSearchQuery, setHindsightSearchQuery] = useState('');
  const [hindsightSearchBusy, setHindsightSearchBusy] = useState(false);
  const [hindsightSearchError, setHindsightSearchError] = useState<string | null>(null);
  const [showDraftConsent, setShowDraftConsent] = useState(false);
  const [wikiDraft, setWikiDraft] = useState<HindsightWikiDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const chatRequestIdRef = useRef<string | null>(null);
  const messagesPanelRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef(activeThread);
  const saveThreadRef = useRef(onSaveThread);
  const streamingContentRef = useRef('');
  const currentRequestThreadIdRef = useRef<string | null>(null);

  threadRef.current = activeThread;
  saveThreadRef.current = onSaveThread;

  useEffect(() => {
    setSummaryDraft(activeThread?.summary ?? '');
    setIsRenaming(false);
    setRenameDraft(activeThread?.title ?? '');
    setConfirmDelete(false);
    setApprovedSuggestionIds([]);
    setHindsightPageIds([]);
    setHindsightSearchQuery('');
    setHindsightSearchError(null);
    setShowDraftConsent(false);
    setWikiDraft(null);
    setDraftError(null);
    setComposer('');
    setLocalError(null);
    setChatState('idle');
    setStreamingContent('');
    streamingContentRef.current = '';
  }, [activeThread?.id]);

  useEffect(() => {
    const panel = messagesPanelRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [activeThread?.id, activeThread?.messages.length, streamingContent]);

  useEffect(() => {
    const bridge = window.thinkPink;
    if (!bridge) return undefined;
    return bridge.onChatEvent((event: ChatEvent) => {
      if (event.requestId !== chatRequestIdRef.current) return;
      if (event.status === 'token') {
        streamingContentRef.current += event.content;
        setStreamingContent(streamingContentRef.current);
      } else if (event.status === 'success') {
        void saveAssistantResponse(false);
      } else if (event.status === 'cancelled') {
        void saveAssistantResponse(true);
      } else {
        setChatState('error');
        setLocalError(event.message);
        void preserveInterruptedResponse(true);
      }
    });
  }, []);

  const mode = activeThread
    ? resolveThreadWikiMode(activeThread, settings.defaultWikiContextMode)
    : settings.defaultWikiContextMode;
  const searchQuery = useMemo(() => {
    const recentUserMessages = activeThread?.messages
      .filter((message) => message.role === 'user')
      .slice(-4)
      .map((message) => message.content) ?? [];
    return [...recentUserMessages, composer].join('\n');
  }, [activeThread?.messages, composer]);
  const suggestedPages = useMemo(
    () => {
      const keywordMatches = findRelevantWikiPages(searchQuery, wikiPages);
      if (hindsightSearchQuery !== searchQuery) return keywordMatches;
      const pagesById = new Map(wikiPages.map((page) => [page.id, page]));
      const semanticMatches = hindsightPageIds
        .map((id) => pagesById.get(id))
        .filter((page): page is WikiPage => Boolean(page));
      const seen = new Set<string>();
      return [...semanticMatches, ...keywordMatches].filter((page) => {
        if (seen.has(page.id)) return false;
        seen.add(page.id);
        return true;
      });
    },
    [hindsightPageIds, hindsightSearchQuery, searchQuery, wikiPages],
  );
  const semanticPageIdSet = useMemo(
    () => new Set(hindsightSearchQuery === searchQuery ? hindsightPageIds : []),
    [hindsightPageIds, hindsightSearchQuery, searchQuery],
  );
  const manualPageChoices = useMemo(() => {
    const suggested = wikiPages.filter((page) => semanticPageIdSet.has(page.id));
    return [...suggested, ...wikiPages.filter((page) => !semanticPageIdSet.has(page.id))];
  }, [semanticPageIdSet, wikiPages]);
  const attachedPages = useMemo(() => {
    if (!activeThread) return [];
    if (mode === 'manual') {
      const attachedIds = new Set(activeThread.wikiPageIds);
      return wikiPages.filter((page) => attachedIds.has(page.id));
    }
    if (mode === 'automatic') return suggestedPages;
    const approvedIds = new Set(approvedSuggestionIds);
    return suggestedPages.filter((page) => approvedIds.has(page.id));
  }, [activeThread, approvedSuggestionIds, mode, suggestedPages, wikiPages]);
  const contextPreview = useMemo(() => {
    if (!activeThread) return null;
    const latestPrompt = composer.trim();
    const history = latestPrompt
      ? [...activeThread.messages, {
        id: 'context-preview-current-message',
        role: 'user' as const,
        content: latestPrompt,
        createdAt: new Date().toISOString(),
      }]
      : activeThread.messages;
    return buildChatContext(activeThread, history, attachedPages, settings.contextWindowTokens);
  }, [activeThread, attachedPages, composer, settings.contextWindowTokens]);
  const includedMessageIds = useMemo(
    () => new Set(contextPreview?.includedMessageIds ?? []),
    [contextPreview],
  );

  async function preserveInterruptedResponse(interrupted: boolean) {
    const current = threadRef.current;
    const content = streamingContentRef.current;
    if (current && current.id === currentRequestThreadIdRef.current && content.trim()) {
      const message: ThreadMessage = {
        id: createLocalId(),
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        ...(interrupted ? { interrupted: true } : {}),
      };
      const nextThread = { ...current, messages: [...current.messages, message], updatedAt: message.createdAt };
      threadRef.current = nextThread;
      try {
        await saveThreadRef.current(nextThread);
      } catch {
        setLocalError('The response arrived, but ThinkPink could not save it to this local thread.');
      }
    }
    setStreamingContent('');
    streamingContentRef.current = '';
    chatRequestIdRef.current = null;
  }

  async function saveAssistantResponse(interrupted: boolean) {
    await preserveInterruptedResponse(interrupted);
    setChatState(interrupted ? 'cancelled' : 'idle');
  }

  async function saveSummary() {
    if (!activeThread || summaryDraft === activeThread.summary) return;
    setBusy(true);
    setLocalError(null);
    try {
      await onSaveThread({ ...activeThread, summary: summaryDraft, updatedAt: new Date().toISOString() });
    } catch {
      setLocalError('ThinkPink could not save the thread summary locally.');
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThread || !renameDraft.trim()) return;
    setBusy(true);
    try {
      await onSaveThread({ ...activeThread, title: renameDraft.trim().slice(0, 100), updatedAt: new Date().toISOString() });
      setIsRenaming(false);
    } catch {
      setLocalError('ThinkPink could not rename this local thread.');
    } finally {
      setBusy(false);
    }
  }

  async function setThreadMode(value: string) {
    if (!activeThread) return;
    const nextMode = value === 'default' || value === 'manual' || value === 'approval' || value === 'automatic'
      ? value
      : 'default';
    try {
      await onSaveThread({ ...activeThread, wikiContextMode: nextMode, updatedAt: new Date().toISOString() });
      setApprovedSuggestionIds([]);
    } catch {
      setLocalError('ThinkPink could not save this thread’s context setting.');
    }
  }

  async function toggleManualPage(pageId: string) {
    if (!activeThread) return;
    const selected = new Set(activeThread.wikiPageIds);
    if (selected.has(pageId)) selected.delete(pageId);
    else selected.add(pageId);
    try {
      await onSaveThread({
        ...activeThread,
        wikiPageIds: [...selected],
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setLocalError('ThinkPink could not update this thread’s attached pages.');
    }
  }

  async function searchLocalMemory() {
    const query = searchQuery.trim();
    if (!query || !hindsightEnabled || hindsightSearchBusy) return;
    setHindsightSearchBusy(true);
    setHindsightSearchError(null);
    try {
      const response = await onSearchHindsight(query);
      const pageIds = [...new Set(
        response.results
          .filter((result) => result.kind === 'wiki')
          .map((result) => result.sourceId),
      )];
      setHindsightPageIds(pageIds);
      setHindsightSearchQuery(query);
    } catch (error) {
      setHindsightSearchError(error instanceof Error ? error.message : 'ThinkPink could not search local memory.');
    } finally {
      setHindsightSearchBusy(false);
    }
  }

  async function generateWikiDraft() {
    if (!activeThread) return;
    setShowDraftConsent(false);
    setDraftBusy(true);
    setDraftError(null);
    setWikiDraft(null);
    try {
      setWikiDraft(await onGenerateHindsightDraft(activeThread));
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'ThinkPink could not create a local wiki draft.');
    } finally {
      setDraftBusy(false);
    }
  }

  async function saveWikiDraft() {
    if (!wikiDraft || !wikiDraft.title.trim()) {
      setDraftError('Give this wiki draft a title before saving.');
      return;
    }
    setDraftSaving(true);
    setDraftError(null);
    try {
      await onSaveWikiDraft({
        title: wikiDraft.title.trim(),
        body: wikiDraft.body,
        category: wikiDraft.category.trim(),
        tags: [...new Set(wikiDraft.tags.map((tag) => tag.trim()).filter(Boolean))],
      });
      setWikiDraft(null);
      setShowDraftConsent(false);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'The wiki draft could not be saved locally.');
    } finally {
      setDraftSaving(false);
    }
  }

  async function sendMessage() {
    const content = composer.trim();
    const bridge = window.thinkPink;
    if (!content || !activeThread || chatState === 'sending' || busy) return;
    if (content.length > 50_000) {
      setLocalError('Messages are limited to 50,000 characters. Shorten it before sending.');
      return;
    }
    if (!bridge) {
      setLocalError('Chat is disabled in browser preview because there is no local desktop bridge.');
      return;
    }
    if (!contextPreview || contextPreview.error) {
      setLocalError(contextPreview?.error ?? 'ThinkPink could not prepare this local request.');
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ThreadMessage = {
      id: createLocalId(),
      role: 'user',
      content,
      createdAt: now,
    };
    const nextMessages = [...activeThread.messages, userMessage];
    const nextThread = {
      ...activeThread,
      title: activeThread.messages.length === 0 && activeThread.title === 'New thread'
        ? content.slice(0, 52)
        : activeThread.title,
      messages: nextMessages,
      updatedAt: now,
    };
    setBusy(true);
    setLocalError(null);
    try {
      await onSaveThread(nextThread);
      threadRef.current = nextThread;
      const prepared = buildChatContext(nextThread, nextMessages, attachedPages, settings.contextWindowTokens);
      if (prepared.error) {
        setLocalError(prepared.error);
        setBusy(false);
        return;
      }
      setComposer('');
      setApprovedSuggestionIds([]);
      streamingContentRef.current = '';
      setStreamingContent('');
      setChatState('sending');
      currentRequestThreadIdRef.current = nextThread.id;
      chatRequestIdRef.current = null;
      const result = await bridge.startChat(model.name, prepared.messages, settings.contextWindowTokens);
      chatRequestIdRef.current = result.requestId;
    } catch {
      setChatState('error');
      setLocalError('The local model did not accept this message. Your text was not sent anywhere else.');
    } finally {
      setBusy(false);
    }
  }

  async function stopResponse() {
    const bridge = window.thinkPink;
    if (!bridge || !chatRequestIdRef.current) return;
    try {
      await bridge.cancelRequest(chatRequestIdRef.current);
    } catch {
      setLocalError('ThinkPink could not cancel this local request.');
    }
  }

  const filteredThreads = useMemo(() => {
    const normalizedSearch = threadSearch.trim().toLowerCase();
    return threads.filter((thread) => thread.archived === showArchived)
      .filter((thread) => !normalizedSearch
        || thread.title.toLowerCase().includes(normalizedSearch)
        || thread.messages.some((message) => message.content.toLowerCase().includes(normalizedSearch)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [showArchived, threadSearch, threads]);

  return (
    <div hidden={!active} className="grid min-h-[570px] overflow-hidden rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 shadow-[0_12px_30px_rgba(67,40,63,.04)] md:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="border-b border-[#eee0e6] bg-[#fff5f8] p-4 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#8f2f61]">Local threads</p>
            <p className="mt-1 text-xs text-[#785f73]">{threads.filter((thread) => !thread.archived).length} active</p>
          </div>
          <button type="button" onClick={() => void onCreateThread().catch(() => undefined)} disabled={busy || chatState === 'sending' || Boolean(storageError)} aria-label="Start a new thread" data-testid="button-new-thread" className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#8f2f61] text-white transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <label className="mt-4 flex items-center gap-2 rounded-lg border border-[#e4d3dd] bg-white px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[#8b7182]" />
          <input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} aria-label="Search threads" placeholder="Find a thread" data-testid="input-search-threads" className="min-w-0 w-full border-0 bg-transparent py-2 text-xs text-[#43283f] outline-none placeholder:text-[#a38b9c]" />
        </label>
        <div className="mt-3 flex gap-1 rounded-lg bg-[#f1e8f0] p-1" role="group" aria-label="Thread status filter">
          <button type="button" onClick={() => setShowArchived(false)} aria-pressed={!showArchived} data-testid="button-filter-active-threads" className={`flex-1 rounded-md px-2 py-1.5 text-[10px] transition ${!showArchived ? 'bg-white text-[#633752] shadow-sm' : 'text-[#785f73]'}`}>Active</button>
          <button type="button" onClick={() => setShowArchived(true)} aria-pressed={showArchived} data-testid="button-filter-archived-threads" className={`flex-1 rounded-md px-2 py-1.5 text-[10px] transition ${showArchived ? 'bg-white text-[#633752] shadow-sm' : 'text-[#785f73]'}`}>Archived</button>
        </div>
        <div className="mt-3 max-h-[270px] space-y-1 overflow-y-auto md:max-h-[410px]" aria-label={showArchived ? 'Archived threads' : 'Active threads'}>
          {filteredThreads.map((thread) => (
            <button key={thread.id} type="button" onClick={() => onSelectThread(thread.id)} disabled={chatState === 'sending' || busy} aria-current={thread.id === activeThread?.id ? 'page' : undefined} data-testid={`button-open-thread-${thread.id}`} className={`w-full rounded-lg px-3 py-2.5 text-left transition ${thread.id === activeThread?.id ? 'bg-[#f2dbe5] text-[#43283f]' : 'text-[#633752] hover:bg-[#f8e9ef]'}`}>
              <span className="block truncate text-xs font-medium">{thread.title}</span>
              <span className="mt-1 block truncate text-[10px] text-[#8b7182]">{thread.messages.at(-1)?.content || 'No messages yet'}</span>
              <span className="mt-1 block text-[9px] text-[#a38b9c]">{formatUpdatedAt(thread.updatedAt)}</span>
            </button>
          ))}
          {filteredThreads.length === 0 && <p className="rounded-lg px-3 py-5 text-center text-[11px] leading-5 text-[#8b7182]">{threadSearch ? 'No matching threads.' : showArchived ? 'No archived threads.' : 'Start a thread when you are ready.'}</p>}
        </div>
        {storageError && <p role="alert" data-testid="status-thread-storage-error" className="mt-3 rounded-lg bg-[#fff0f1] p-2.5 text-[10px] leading-4 text-[#863f52]">{storageError}</p>}
        <p className="mt-4 flex items-start gap-2 border-t border-[#eadbe2] pt-3 text-[10px] leading-4 text-[#785f73]"><BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8f2f61]" />Full transcripts are saved on this device. Archived threads remain in local storage.</p>
      </aside>

      <section className="flex min-w-0 flex-col">
        {activeThread ? (
          <>
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eee0e6] px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                {isRenaming ? (
                  <form onSubmit={(event) => void saveRename(event)} className="flex max-w-lg gap-2">
                    <label htmlFor="input-thread-title" className="sr-only">Thread title</label>
                    <input id="input-thread-title" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={100} autoFocus data-testid="input-thread-title" className="min-w-0 flex-1 rounded-lg border border-[#dcb9c9] bg-white px-3 py-2 text-sm text-[#43283f]" />
                    <button type="submit" disabled={!renameDraft.trim() || busy} data-testid="button-save-thread-title" className="rounded-lg bg-[#8f2f61] px-3 py-2 text-xs text-white disabled:opacity-45">Save</button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f2dbe5] text-[#8f2f61]"><MessageCircle className="h-4 w-4" /></div>
                    <div className="min-w-0">
                      <h2 className="truncate font-mono-ui text-xs text-[#43283f]" data-testid="text-active-thread-title">{activeThread.title}</h2>
                      <p className="mt-0.5 text-[10px] text-[#785f73]">{model.name} · Private thread · local only</p>
                    </div>
                    <button type="button" onClick={() => { setRenameDraft(activeThread.title); setIsRenaming(true); }} disabled={busy || chatState === 'sending'} aria-label="Rename thread" data-testid="button-rename-thread" className="rounded-md p-2 text-[#785f73] hover:bg-[#f2dbe5] disabled:opacity-45"><Settings2 className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="model-picker" className="sr-only">Choose local model</label>
                <select id="model-picker" value={model.name} onChange={(event) => onSelectModel(event.target.value)} disabled={chatState === 'sending'} data-testid="select-chat-model" className="max-w-[170px] rounded-lg border border-[#e4d3dd] bg-[#fffaf9] px-2.5 py-2 font-mono-ui text-[10px] text-[#633752] disabled:opacity-50">
                  <option value="" disabled>Choose model</option>
                  {models.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
                <span className="hidden items-center gap-1 text-[10px] text-[#3f715f] sm:flex"><Radio className="h-3 w-3" /> Local</span>
              </div>
            </header>

            <div ref={messagesPanelRef} className="flex min-h-[260px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-5" data-testid="list-chat-messages">
              {activeThread.messages.length === 0 && !streamingContent && (
                <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                  <div className="orbit-mark h-14 w-14 text-[#b64378]" aria-hidden="true"><CircleHelp className="relative z-10 h-5 w-5" /></div>
                  <h3 className="mt-6 font-display text-3xl tracking-[-.025em] text-[#43283f]">Start with a small question.</h3>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-[#785f73]">This thread stays on this device. It will use only the thread history and wiki pages shown in the context review below.</p>
                </div>
              )}
              {activeThread.messages.map((message, index) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`} data-testid={`message-chat-${index}`}>
                  <div className="max-w-[90%]">
                    <div className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'rounded-br-md bg-[#633752] text-[#fff7fa]' : 'rounded-bl-md bg-[#f1e8f0] text-[#43283f]'}`}>
                      {message.content}
                      {message.interrupted && <span className="mt-2 block text-[10px] opacity-70">Stopped before completion</span>}
                    </div>
                    <span className={`mt-1 block px-1 text-[9px] ${message.role === 'user' ? 'text-right' : ''} text-[#987f91]`} data-testid={`status-message-context-${index}`}>
                      {includedMessageIds.has(message.id) ? 'Included in the next request' : 'Saved locally, not included'}
                    </span>
                  </div>
                </div>
              ))}
              {chatState === 'sending' && (
                <div className="flex justify-start" data-testid="message-chat-streaming">
                  <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-[#f1e8f0] px-4 py-3 text-sm leading-6 text-[#43283f]">
                    {streamingContent || <span className="inline-flex items-center gap-1.5 text-[#785f73]" aria-label="Waiting for a local response"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8f2f61]" /><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8f2f61] [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8f2f61] [animation-delay:240ms]" /></span>}
                  </div>
                </div>
              )}
            </div>

            <div className="mx-4 mb-3 rounded-xl border border-[#eadbe2] bg-[#fff5f8] sm:mx-5" data-testid="panel-chat-context-review">
              <details open className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[11px] font-medium text-[#633752]">
                  <span className="flex items-center gap-2"><BookOpen className="h-3.5 w-3.5" /> Context review</span>
                  <span className="flex items-center gap-2 text-[10px] font-normal text-[#785f73]">
                    {contextPreview ? `About ${contextPreview.estimatedInputTokens.toLocaleString()} of ${settings.contextWindowTokens.toLocaleString()} tokens` : 'No context yet'}
                    <ChevronDown className="h-3 w-3 transition group-open:rotate-180" />
                  </span>
                </summary>
                <div className="space-y-3 border-t border-[#eadbe2] px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="thread-wiki-mode" className="text-[10px] text-[#785f73]">Wiki mode</label>
                    <select id="thread-wiki-mode" value={activeThread.wikiContextMode} onChange={(event) => void setThreadMode(event.target.value)} disabled={busy || chatState === 'sending'} data-testid="select-thread-wiki-mode" className="max-w-full rounded-md border border-[#decbd7] bg-white px-2 py-1.5 text-[10px] text-[#633752]">
                      <option value="default">Use settings default ({modeLabels[settings.defaultWikiContextMode]})</option>
                      <option value="manual">{modeLabels.manual}</option>
                      <option value="approval">{modeLabels.approval}</option>
                      <option value="automatic">{modeLabels.automatic}</option>
                    </select>
                  </div>

                  {hindsightEnabled && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e8d7e0] bg-white px-2.5 py-2">
                      <p className="max-w-xl text-[10px] leading-4 text-[#785f73]">
                        Search only the threads and wiki pages you selected for local Hindsight memory.
                      </p>
                      <button
                        type="button"
                        onClick={() => void searchLocalMemory()}
                        disabled={hindsightSearchBusy || !searchQuery.trim() || chatState === 'sending'}
                        data-testid="button-search-hindsight-wiki"
                        className="inline-flex items-center gap-1.5 rounded-md border border-[#dcb9c9] px-2.5 py-1.5 text-[10px] font-medium text-[#633752] hover:bg-[#f8e9ef] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {hindsightSearchBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        {hindsightSearchBusy ? 'Searching local memory' : 'Find semantic pages'}
                      </button>
                      {hindsightSearchError && <p role="alert" data-testid="status-hindsight-search-error" className="w-full text-[10px] leading-4 text-[#863f52]">{hindsightSearchError}</p>}
                      {!hindsightSearchError && semanticPageIdSet.size > 0 && (
                        <p role="status" data-testid="status-hindsight-page-results" className="w-full text-[10px] text-[#3f715f]">
                          Hindsight found {semanticPageIdSet.size} wiki {semanticPageIdSet.size === 1 ? 'page' : 'pages'}. Review below; inclusion still follows this thread’s wiki mode.
                        </p>
                      )}
                    </div>
                  )}

                  {mode === 'manual' && (
                    <div>
                      <p className="mb-2 text-[10px] text-[#785f73]">Choose pages to attach. Nothing is included until selected.</p>
                      {wikiPages.length === 0 ? <p className="text-[10px] text-[#8b7182]">Create pages in Wiki to attach them here.</p> : (
                        <div className="grid gap-1 sm:grid-cols-2">
                          {manualPageChoices.map((page) => (
                            <label key={page.id} className="flex min-w-0 items-center gap-2 rounded-md bg-white px-2.5 py-2 text-[10px] text-[#633752]">
                              <input type="checkbox" checked={activeThread.wikiPageIds.includes(page.id)} onChange={() => void toggleManualPage(page.id)} disabled={busy || chatState === 'sending'} data-testid={`checkbox-attach-wiki-${page.id}`} className="accent-[#8f2f61]" />
                              <span className="min-w-0 flex-1 truncate">{page.title}</span>
                              {semanticPageIdSet.has(page.id) && <span className="shrink-0 rounded-full bg-[#f2dbe5] px-1.5 py-0.5 text-[8px] text-[#8f2f61]">Hindsight</span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {mode === 'approval' && (
                    <div>
                      <p className="mb-2 text-[10px] text-[#785f73]">Suggestions stay out of the request until you select them.</p>
                      {suggestedPages.length === 0 ? <p className="text-[10px] text-[#8b7182]">Write a question related to a wiki page to see suggestions.</p> : (
                        <div className="grid gap-1 sm:grid-cols-2">
                          {suggestedPages.map((page) => (
                            <label key={page.id} className="flex min-w-0 items-center gap-2 rounded-md bg-white px-2.5 py-2 text-[10px] text-[#633752]">
                              <input type="checkbox" checked={approvedSuggestionIds.includes(page.id)} onChange={() => setApprovedSuggestionIds((current) => current.includes(page.id) ? current.filter((id) => id !== page.id) : [...current, page.id])} disabled={chatState === 'sending'} data-testid={`checkbox-approve-wiki-${page.id}`} className="accent-[#8f2f61]" />
                              <span className="min-w-0 flex-1 truncate">{page.title}</span>
                              {semanticPageIdSet.has(page.id) && <span className="shrink-0 rounded-full bg-[#f2dbe5] px-1.5 py-0.5 text-[8px] text-[#8f2f61]">Hindsight</span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {mode === 'automatic' && (
                    <p className="text-[10px] leading-4 text-[#785f73]" data-testid="text-automatic-wiki-mode">
                      {attachedPages.length
                        ? `Relevant keyword and selected-memory pages that will be included: ${attachedPages.map((page) => page.title).join(', ')}.`
                        : 'No relevant wiki pages match this thread yet. Automatic inclusion can be turned off in Settings.'}
                    </p>
                  )}

                  <div className="grid gap-2 text-[10px] leading-4 text-[#785f73] sm:grid-cols-2">
                    <div className="rounded-md bg-white px-2.5 py-2" data-testid="text-context-thread-summary">
                      <strong className="text-[#633752]">Thread summary</strong>
                      <p>{activeThread.summary.trim() ? activeThread.summary : 'Not set. Add your own summary below if the thread needs carry-forward context.'}</p>
                    </div>
                    <div className="rounded-md bg-white px-2.5 py-2" data-testid="text-context-turn-count">
                      <strong className="text-[#633752]">Conversation history</strong>
                      <p>{contextPreview ? `${contextPreview.includedTurns} recent turns included${contextPreview.omittedTurns ? `, ${contextPreview.omittedTurns} older turns kept locally but not sent` : ''}.` : 'No messages yet.'}</p>
                    </div>
                  </div>
                  {attachedPages.map((page) => (
                    <details key={page.id} className="rounded-md bg-white px-2.5 py-2" data-testid={`details-context-page-${page.id}`}>
                      <summary className="cursor-pointer text-[10px] font-medium text-[#633752]">Preview included page: {page.title}</summary>
                      <p className="mt-2 whitespace-pre-wrap text-[10px] leading-4 text-[#785f73]">{page.body}</p>
                    </details>
                  ))}
                  {contextPreview?.error && <p role="alert" data-testid="status-context-budget-error" className="rounded-md bg-[#fff0f1] px-2.5 py-2 text-[10px] text-[#863f52]">{contextPreview.error}</p>}
                  <details className="rounded-md border border-[#eadbe2] bg-white px-2.5 py-2">
                    <summary className="cursor-pointer text-[10px] font-medium text-[#633752]">Edit the user-managed thread summary</summary>
                    <label htmlFor="textarea-thread-summary" className="sr-only">Thread summary for local context</label>
                    <textarea id="textarea-thread-summary" value={summaryDraft} onChange={(event) => setSummaryDraft(event.target.value)} maxLength={12000} rows={3} disabled={busy || chatState === 'sending'} placeholder="Write a short note to carry important context through a long thread." data-testid="textarea-thread-summary" className="mt-2 w-full resize-y rounded-md border border-[#e4d3dd] bg-[#fffaf9] p-2 text-xs leading-5 text-[#43283f]" />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[9px] text-[#8b7182]">This note is saved separately from the full transcript.</span>
                      <button type="button" onClick={() => void saveSummary()} disabled={busy || chatState === 'sending' || summaryDraft === activeThread.summary} data-testid="button-save-thread-summary" className="rounded-md border border-[#dcb9c9] px-2.5 py-1.5 text-[10px] text-[#633752] hover:bg-[#f8e9ef] disabled:opacity-45">Save summary</button>
                    </div>
                  </details>
                </div>
              </details>
            </div>

            {hindsightEnabled && activeThread.messages.length > 0 && (
              <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#eadbe2] bg-[#fff5f8] px-3 py-2.5 sm:mx-5">
                <p className="text-[10px] leading-4 text-[#785f73]">Turn this thread’s selected local memory into an editable wiki draft.</p>
                <button
                  type="button"
                  onClick={() => { setDraftError(null); setShowDraftConsent(true); }}
                  disabled={chatState === 'sending' || draftBusy || draftSaving}
                  data-testid="button-start-hindsight-wiki-draft"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#dcb9c9] bg-white px-3 py-2 text-[10px] font-medium text-[#633752] hover:bg-[#f8e9ef] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Draft wiki page
                </button>
                {draftError && <p role="alert" data-testid="status-hindsight-draft-error" className="w-full text-[10px] leading-4 text-[#863f52]">{draftError}</p>}
              </div>
            )}

            {(showDraftConsent || draftBusy || wikiDraft) && (
              <div role="dialog" aria-modal="true" aria-labelledby="hindsight-draft-title" data-testid="dialog-hindsight-wiki-draft" className="fixed inset-0 z-50 flex items-center justify-center bg-[#2c1c2b]/40 p-4">
                <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#e3d5e0] bg-[#fffaf9] p-5 shadow-2xl sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-[#8f2f61]">Local Hindsight</p>
                      <h3 id="hindsight-draft-title" className="mt-1 font-display text-2xl text-[#43283f]">
                        {wikiDraft ? 'Review wiki draft' : draftBusy ? 'Preparing a local draft' : 'Use this thread for a wiki draft?'}
                      </h3>
                    </div>
                    {!draftBusy && (
                      <button type="button" onClick={() => { setShowDraftConsent(false); setWikiDraft(null); setDraftError(null); }} aria-label="Close wiki draft" data-testid="button-close-hindsight-draft" className="rounded-lg p-2 text-[#785f73] hover:bg-[#f8e9ef]"><X className="h-4 w-4" /></button>
                    )}
                  </div>

                  {showDraftConsent && !draftBusy && !wikiDraft && (
                    <>
                      <p className="mt-3 text-xs leading-5 text-[#785f73]">
                        ThinkPink will add this thread to your selected local Hindsight memory and use its extracted facts to prepare a draft. The transcript stays unchanged. Nothing is added to your wiki until you edit and approve the draft.
                      </p>
                      <div className="mt-5 flex justify-end gap-2">
                        <button type="button" onClick={() => setShowDraftConsent(false)} data-testid="button-cancel-hindsight-draft" className="rounded-lg border border-[#decbd7] px-3 py-2 text-xs text-[#633752] hover:bg-[#f8e9ef]">Cancel</button>
                        <button type="button" onClick={() => void generateWikiDraft()} data-testid="button-confirm-hindsight-draft" className="rounded-lg bg-[#8f2f61] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#75304f]">Prepare draft</button>
                      </div>
                    </>
                  )}

                  {draftBusy && (
                    <div role="status" aria-live="polite" data-testid="status-hindsight-draft-progress" className="mt-5 flex items-center gap-2 rounded-xl border border-[#eadbe2] bg-[#fdf7f8] p-4 text-xs text-[#633752]">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      {hindsightProgress || 'Processing the selected thread with local Hindsight…'}
                    </div>
                  )}

                  {wikiDraft && (
                    <div className="mt-4 space-y-3">
                      <p className="text-xs leading-5 text-[#785f73]">Review and edit every field. This draft is not saved until you choose Add to Wiki.</p>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f5267]">
                        Title
                        <input value={wikiDraft.title} onChange={(event) => setWikiDraft((current) => current ? { ...current, title: event.target.value } : current)} maxLength={120} data-testid="input-hindsight-draft-title" className="mt-1.5 w-full rounded-lg border border-[#e3d2dc] bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#43283f]" />
                      </label>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f5267]">
                        Category
                        <input value={wikiDraft.category} onChange={(event) => setWikiDraft((current) => current ? { ...current, category: event.target.value } : current)} maxLength={80} data-testid="input-hindsight-draft-category" className="mt-1.5 w-full rounded-lg border border-[#e3d2dc] bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#43283f]" />
                      </label>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f5267]">
                        Tags
                        <input value={wikiDraft.tags.join(', ')} onChange={(event) => setWikiDraft((current) => current ? { ...current, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } : current)} maxLength={1_100} data-testid="input-hindsight-draft-tags" className="mt-1.5 w-full rounded-lg border border-[#e3d2dc] bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#43283f]" />
                      </label>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f5267]">
                        Body
                        <textarea value={wikiDraft.body} onChange={(event) => setWikiDraft((current) => current ? { ...current, body: event.target.value } : current)} maxLength={50_000} rows={12} data-testid="textarea-hindsight-draft-body" className="mt-1.5 w-full resize-y rounded-lg border border-[#e3d2dc] bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal leading-6 text-[#43283f]" />
                      </label>
                      {draftError && <p role="alert" data-testid="status-hindsight-draft-save-error" className="rounded-lg bg-[#fff2f3] px-3 py-2 text-xs text-[#863f52]">{draftError}</p>}
                      <div className="flex justify-end gap-2 border-t border-[#eadbe2] pt-4">
                        <button type="button" onClick={() => { setWikiDraft(null); setDraftError(null); }} disabled={draftSaving} data-testid="button-discard-hindsight-draft" className="rounded-lg border border-[#decbd7] px-3 py-2 text-xs text-[#633752] hover:bg-[#f8e9ef] disabled:opacity-45">Discard draft</button>
                        <button type="button" onClick={() => void saveWikiDraft()} disabled={draftSaving || !wikiDraft.title.trim()} data-testid="button-save-hindsight-draft" className="rounded-lg bg-[#8f2f61] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45">{draftSaving ? 'Adding to Wiki…' : 'Add to Wiki'}</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {localError && <div role="alert" data-testid="status-chat-error" className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-[#fff0f1] px-3 py-2.5 text-xs leading-5 text-[#863f52] sm:mx-5">{localError}</div>}
            {chatState === 'cancelled' && <p className="mx-5 mb-3 text-xs text-[#785f73]">The local request was stopped. Any response received before stopping remains in this thread.</p>}
            {confirmDelete && (
              <div role="group" aria-label="Confirm thread deletion" className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e6bfc7] bg-[#fff2f3] px-3 py-2.5 text-xs text-[#863f52] sm:mx-5">
                <span>Delete this thread and its saved messages from this device?</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmDelete(false)} data-testid="button-cancel-delete-thread" className="rounded-md border border-[#e6bfc7] px-2.5 py-1.5">Keep thread</button>
                  <button type="button" onClick={() => { void onDeleteThread(activeThread.id).then(() => setConfirmDelete(false)).catch(() => setLocalError('ThinkPink could not delete this local thread.')); }} data-testid="button-confirm-delete-thread" className="rounded-md bg-[#863f52] px-2.5 py-1.5 text-white">Delete</button>
                </div>
              </div>
            )}

            <div className="border-t border-[#eee0e6] px-4 py-3 sm:px-5">
              <form onSubmit={(event) => { event.preventDefault(); void sendMessage(); }} className="rounded-xl border border-[#decbd7] bg-[#fffaf9] p-2 shadow-[0_4px_15px_rgba(67,40,63,.04)]">
                <label htmlFor="textarea-chat-composer" className="sr-only">Message the local model</label>
                <textarea id="textarea-chat-composer" value={composer} onChange={(event) => { setComposer(event.target.value); if (mode === 'approval') setApprovedSuggestionIds([]); }} disabled={chatState === 'sending'} aria-label="Message the local model" placeholder="Write to your local model…" data-testid="textarea-chat-composer" className="min-h-[62px] w-full resize-y border-0 bg-transparent px-2 py-1 text-sm leading-6 text-[#43283f] outline-none placeholder:text-[#a38b9c] disabled:opacity-50" />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#eee0e6] px-2 pt-2">
                  <span className="flex items-center gap-1.5 text-[10px] text-[#785f73]"><span className="h-2 w-2 rounded-full bg-[#3f715f]" /> {attachedPages.length ? `${attachedPages.length} wiki ${attachedPages.length === 1 ? 'page' : 'pages'} included` : 'No wiki pages included'}</span>
                  {chatState === 'sending' ? (
                    <button type="button" onClick={() => void stopResponse()} data-testid="button-cancel-chat" className="inline-flex items-center gap-2 rounded-lg border border-[#dcb9c9] px-3 py-2 text-xs font-medium text-[#633752] hover:bg-[#f8e9ef]"><Square className="h-3 w-3 fill-current" /> Stop</button>
                  ) : (
                    <button type="submit" disabled={!composer.trim() || previewMode || busy || Boolean(contextPreview?.error) || Boolean(storageError)} data-testid="button-send-chat" className="inline-flex items-center gap-2 rounded-lg bg-[#8f2f61] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45"><Send className="h-3.5 w-3.5" /> Send locally</button>
                  )}
                </div>
              </form>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-[#8b7182]">
                <span>Only the context shown above is sent to local Ollama.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { const nextArchived = !activeThread.archived; void onArchiveThread(activeThread.id, nextArchived).then(() => setShowArchived(false)).catch(() => setLocalError('ThinkPink could not update this local thread.')); }} disabled={busy || chatState === 'sending'} data-testid="button-toggle-archive-thread" className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-[#f2dbe5] disabled:opacity-45"><Archive className="h-3 w-3" />{activeThread.archived ? 'Restore' : 'Archive'}</button>
                  <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy || chatState === 'sending'} data-testid="button-delete-thread" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[#863f52] hover:bg-[#fff0f1] disabled:opacity-45"><Trash2 className="h-3 w-3" />Delete</button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
            <div className="orbit-mark h-16 w-16 text-[#b64378]" aria-hidden="true"><MessageCircle className="relative z-10 h-5 w-5" /></div>
            <h2 className="mt-7 font-display text-3xl tracking-[-.025em] text-[#43283f]">{showArchived ? 'Choose an archived thread.' : 'Start a local thread.'}</h2>
            <p className="mt-3 max-w-sm text-sm leading-6 text-[#785f73]">Your complete chat history and wiki stay on this device. You decide what context goes to the local model.</p>
            <button type="button" onClick={() => void onCreateThread().catch(() => undefined)} disabled={Boolean(storageError)} data-testid="button-create-first-thread" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#8f2f61] px-4 py-2.5 text-xs font-medium text-white hover:bg-[#75304f] disabled:opacity-45"><Plus className="h-3.5 w-3.5" /> New thread</button>
          </div>
        )}
      </section>
    </div>
  );
}