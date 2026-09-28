import { useCallback, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  CircleHelp,
  CloudOff,
  Code2,
  Download,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Square,
  WifiOff,
  X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import LearnToCode from '@/components/learn-to-code/LearnToCode';
import { ThinkPinkWorkspace } from '@/components/local-knowledge/ThinkPinkWorkspace';
import NotFound from '@/pages/not-found';
import {
  type InstalledModel,
  type ModelCatalogItem,
  type OllamaConnection,
  type PullEvent,
} from '@/lib/thinkpinkBridge';
import { MODEL_CATALOG } from '@/lib/modelCatalog';
import { Link, Route, Router as WouterRouter, Switch } from 'wouter';

const queryClient = new QueryClient();

type ConnectionState = 'checking' | OllamaConnection;
type CatalogItem = ModelCatalogItem;
const catalog = MODEL_CATALOG;

function getBridge() {
  return typeof window !== 'undefined' ? window.thinkPink : undefined;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size not reported';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <ErrorBoundary>
          <Switch>
            <Route path="/learn-to-code" component={LearnToCode} />
            <Route path="/" component={Home} />
            <Route component={NotFound} />
          </Switch>
        </ErrorBoundary>
      </WouterRouter>
    </QueryClientProvider>
  );
}

function Home() {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [previewMode, setPreviewMode] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<CatalogItem | null>(null);
  const [pull, setPull] = useState<{
    requestId: string;
    modelName: string;
    phase: string;
    completed?: number;
    total?: number;
    status: 'progress' | 'success' | 'cancelled' | 'error';
    message?: string;
  } | null>(null);
  const pullRequestId = useRef<string | null>(null);
  const currentPullNameRef = useRef('');

  const checkConnection = useCallback(async (reload = false) => {
    const bridge = getBridge();
    setNotice(null);
    if (!bridge) {
      setPreviewMode(true);
      setConnection({ status: 'unreachable', reason: 'not-running' });
      setNotice('The desktop bridge is unavailable in this browser preview. Local actions stay disabled.');
      return;
    }
    setPreviewMode(false);
    setConnection('checking');
    try {
      const next = reload ? await bridge.reloadModels() : await bridge.checkConnection();
      setConnection(next);
      if (next.status === 'ready' && next.models.length > 0) {
        setSelectedModel((current) =>
          current && next.models.some((model) => model.name === current) ? current : next.models[0].name,
        );
      }
    } catch {
      setConnection({ status: 'unreachable', reason: 'invalid-response' });
      setNotice('ThinkPink could not read a response from the local Ollama service.');
    }
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return undefined;
    const stopListening = bridge.onPullEvent((event: PullEvent) => {
      if (event.requestId !== pullRequestId.current) return;
      if (event.status === 'progress') {
        setPull((current) =>
          current
            ? { ...current, status: 'progress', phase: event.phase, completed: event.completed, total: event.total }
            : current,
        );
      } else if (event.status === 'success') {
        setPull((current) => (current ? { ...current, status: 'success', phase: 'Ready' } : current));
        void bridge.reloadModels().then((next) => {
          setConnection(next);
          if (next.status === 'ready') {
            const pulledModel = next.models.find((model) => model.name === currentPullNameRef.current);
            setSelectedModel(pulledModel?.name ?? next.models[0]?.name ?? null);
          }
        }).catch(() => {
          setNotice('The download finished, but ThinkPink could not refresh the local model list.');
        });
      } else if (event.status === 'cancelled') {
        setPull((current) => (current ? { ...current, status: 'cancelled', phase: 'Cancelled' } : current));
      } else {
        setPull((current) => (current ? { ...current, status: 'error', phase: 'Download stopped', message: event.message } : current));
      }
    });
    return stopListening;
  }, []);

  const models = connection !== 'checking' && connection.status === 'ready' ? connection.models : [];

  return (
    <div className="starfield min-h-[100dvh] text-foreground">
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[1560px] overflow-hidden lg:p-4">
        <Sidebar connection={connection} selectedModel={selectedModel} previewMode={previewMode} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto lg:rounded-[1.4rem] lg:border lg:border-[#e8d7e0] lg:bg-[#fffaf9]/55 lg:shadow-[0_18px_60px_rgba(67,40,63,.08)]">
          <Header connection={connection} previewMode={previewMode} onRefresh={() => void checkConnection(true)} />
          <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-5 pb-12 pt-7 sm:px-8 lg:px-12">
            {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
            {connection === 'checking' ? <CheckingState /> : connection.status === 'unreachable' ? (
              <RecoveryState previewMode={previewMode} reason={connection.reason} onRetry={() => void checkConnection()} onOpenDownload={() => void openOfficial('download', setNotice)} />
            ) : connection.status === 'unsupported' ? (
              <UnsupportedState connection={connection} onOpenUpdate={() => void openOfficial('update', setNotice)} />
            ) : models.length === 0 ? (
              <ModelSetup
                catalog={catalog}
                selectedModel={selectedModel}
                onSelect={setSelectedModel}
                onDownload={setDownloadTarget}
                previewMode={previewMode}
                pull={pull}
                onDismissPull={() => setPull(null)}
                onOpenLibrary={() => void openOfficial('library', setNotice)}
              />
            ) : (
              <ReadyWorkspace
                models={models}
                selectedModel={selectedModel ?? models[0].name}
                onSelect={setSelectedModel}
                onDownload={setDownloadTarget}
                previewMode={previewMode}
                pull={pull}
                onDismissPull={() => setPull(null)}
                onOpenLibrary={() => void openOfficial('library', setNotice)}
              />
            )}
          </div>
        </main>
      </div>
      {downloadTarget && (
        <DownloadDialog
          item={downloadTarget}
          onClose={() => setDownloadTarget(null)}
          onOpenModel={() =>
            void openOfficial('model', setNotice, downloadTarget.name)
          }
          onConfirm={async () => {
            const bridge = getBridge();
            if (!bridge) {
              setNotice('Downloading is available only in the ThinkPink desktop app.');
              setDownloadTarget(null);
              return;
            }
            try {
              const result = await bridge.startModelPull(downloadTarget.name);
              pullRequestId.current = result.requestId;
              currentPullNameRef.current = downloadTarget.name;
              setPull({
                requestId: result.requestId,
                modelName: downloadTarget.name,
                phase: 'Preparing download',
                status: 'progress',
              });
              setDownloadTarget(null);
            } catch {
              setNotice(`ThinkPink could not start the download for ${downloadTarget.name}.`);
              setDownloadTarget(null);
            }
          }}
        />
      )}
    </div>
  );
}

async function openOfficial(
  page: 'download' | 'library' | 'update' | 'model',
  setNotice: (message: string) => void,
  modelName?: string,
) {
  const bridge = getBridge();
  if (!bridge) {
    setNotice('Official links open from the ThinkPink desktop app, not from this browser preview.');
    return;
  }
  try {
    await bridge.openOfficialPage(page, modelName);
  } catch {
    setNotice('ThinkPink could not open the official Ollama page.');
  }
}

function Sidebar({ connection, selectedModel, previewMode }: { connection: ConnectionState; selectedModel: string | null; previewMode: boolean }) {
  const ready = connection !== 'checking' && connection.status === 'ready';
  const modelLabel = selectedModel ? selectedModel : 'No model selected';
  return (
    <aside className="hidden w-[270px] shrink-0 flex-col bg-[#43283f] px-5 py-6 text-[#faedf3] lg:flex">
      <div className="flex items-center gap-3">
        <div className="orbit-mark h-10 w-10 text-[#efabc7]" aria-hidden="true">
          <span className="relative z-10 h-2.5 w-2.5 rounded-full bg-[#efabc7] shadow-[0_0_0_5px_rgba(239,171,199,.12)]" />
        </div>
        <div>
          <p className="font-display text-[1.5rem] leading-none tracking-[-.03em]">ThinkPink</p>
          <p className="mt-1 font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#cfaebe]">Local companion</p>
        </div>
      </div>
      <div className="mt-12">
        <p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#cfaebe]">Your orbit</p>
        <div className="mt-3 rounded-xl border border-[#75556d] bg-[#5a3a52] px-3.5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={`h-2 w-2 rounded-full ${ready ? 'bg-[#9cd2b4]' : 'bg-[#d898af]'}`} />
            {connection === 'checking' ? 'Checking Ollama' : ready ? 'Ollama is ready' : 'Ollama needs attention'}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[#e0cbd6]">
            {ready ? 'Your models stay on this computer.' : 'ThinkPink will never use a hosted fallback.'}
          </p>
        </div>
      </div>
      <div className="mt-8">
        <Link href="/learn-to-code" data-testid="link-learn-to-code" className="flex items-center gap-3 rounded-xl border border-[#75556d] bg-[#5a3a52] px-3.5 py-3.5 text-left transition hover:border-[#aa7894] hover:bg-[#68445d]">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#efabc7]/15 text-[#efabc7]"><Code2 className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#faedf3]">Learn to Code</p>
            <p className="mt-0.5 text-[11px] text-[#cfaebe]">Java and Python, offline</p>
          </div>
        </Link>
      </div>
      <div className="mt-8">
        <p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#cfaebe]">Selected model</p>
        <div className="mt-3 flex items-start gap-3 rounded-xl border border-[#75556d] px-3.5 py-3.5">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[#efabc7]" strokeWidth={1.7} />
          <div className="min-w-0">
            <p className="truncate font-mono-ui text-xs text-[#f8d9e6]">{modelLabel}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#cfaebe]">{ready ? 'Used for local chat' : 'Select after connection'}</p>
          </div>
        </div>
      </div>
      <div className="mt-auto border-t border-[#68475e] pt-5">
        {previewMode && <p className="mb-3 text-[11px] leading-relaxed text-[#e0cbd6]">Browser preview mode. The desktop bridge is not connected.</p>}
        <div className="flex items-center gap-2 text-[11px] text-[#cfaebe]">
          <LockKeyhole className="h-3.5 w-3.5" />
          <span>Local-only by design</span>
        </div>
      </div>
    </aside>
  );
}

function Header({ connection, previewMode, onRefresh }: { connection: ConnectionState; previewMode: boolean; onRefresh: () => void }) {
  const state = connection === 'checking' ? 'Checking local service' : connection.status === 'ready' ? 'Local connection active' : connection.status === 'unsupported' ? 'Update needed' : 'Local service unreachable';
  return (
    <header className="flex items-center justify-between border-b border-[#eadbe2] px-5 py-4 sm:px-8 lg:px-12">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-[#633752] lg:hidden"><span className="orbit-mark h-7 w-7 text-[#b64378]" aria-hidden="true"><span className="relative z-10 h-1.5 w-1.5 rounded-full bg-[#b64378]" /></span><span className="font-display text-lg">ThinkPink</span></div>
        <div className="hidden items-center gap-2.5 lg:flex">
          <span className={`h-2 w-2 rounded-full ${connection === 'checking' ? 'bg-[#c18aa5]' : connection.status === 'ready' ? 'bg-[#3f715f]' : 'bg-[#b64378]'}`} />
          <span className="text-xs font-medium text-[#785f73]">{state}</span>
          {previewMode && <span className="rounded-full bg-[#eee8f1] px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#785f73]">Preview</span>}
        </div>
        <div className="flex items-center gap-2 lg:hidden">
          <span className={`h-2 w-2 rounded-full ${connection === 'checking' ? 'bg-[#c18aa5]' : connection.status === 'ready' ? 'bg-[#3f715f]' : 'bg-[#b64378]'}`} />
          <span className="text-xs font-medium text-[#785f73]">{state}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Link href="/learn-to-code" data-testid="link-learn-to-code-mobile" className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[#633752] transition-colors hover:bg-[#f2dbe5]">
          <Code2 className="h-3.5 w-3.5" />
          Learn
        </Link>
        <button type="button" onClick={onRefresh} data-testid="button-refresh-connection" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-[#633752] transition-colors hover:bg-[#f2dbe5]">
          <RefreshCw className="h-3.5 w-3.5" />
          Recheck
        </button>
      </div>
    </header>
  );
}

function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="status" data-testid="status-notice" className="mb-5 flex items-start gap-3 rounded-xl border border-[#e2c5d2] bg-[#fff5f8] px-4 py-3 text-sm text-[#633752]">
      <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-[#8f2f61]" />
      <p className="flex-1 leading-relaxed">{text}</p>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notice" data-testid="button-dismiss-notice" className="rounded-md p-0.5 text-[#785f73] hover:bg-[#f2dbe5]"><X className="h-4 w-4" /></button>
    </div>
  );
}

function CheckingState() {
  return (
    <section className="rise-in flex flex-1 items-center justify-center py-16">
      <div className="w-full max-w-2xl rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/80 p-8 sm:p-12">
        <div className="h-2.5 w-28 animate-pulse rounded-full bg-[#f2dbe5]" />
        <div className="mt-5 h-12 max-w-lg animate-pulse rounded-lg bg-[#eee8f1]" />
        <div className="mt-4 h-4 max-w-md animate-pulse rounded bg-[#eee8f1]" />
        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          <div className="h-24 animate-pulse rounded-xl bg-[#f5eaf0]" />
          <div className="h-24 animate-pulse rounded-xl bg-[#f5eaf0]" />
          <div className="h-24 animate-pulse rounded-xl bg-[#f5eaf0]" />
        </div>
        <p className="mt-7 flex items-center gap-2 text-xs text-[#785f73]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Checking only your local Ollama service…</p>
      </div>
    </section>
  );
}

function RecoveryState({ previewMode, reason, onRetry, onOpenDownload }: { previewMode: boolean; reason: 'not-running' | 'timeout' | 'invalid-response'; onRetry: () => void; onOpenDownload: () => void }) {
  const reasonCopy = reason === 'not-running' ? 'Ollama is not responding' : reason === 'timeout' ? 'Ollama took too long to respond' : 'Ollama sent an unreadable response';
  return (
    <section className="rise-in max-w-3xl py-8 sm:py-14">
      <p className="font-mono-ui text-[10px] uppercase tracking-[.23em] text-[#8f2f61]">First connection</p>
      <h1 className="mt-4 max-w-2xl font-display text-5xl leading-[.98] tracking-[-.04em] text-[#43283f] sm:text-7xl">Let’s find your local Ollama.</h1>
      <p className="mt-6 max-w-xl text-base leading-7 text-[#785f73]">ThinkPink connects to Ollama on this computer. It does not create an account, send prompts to the cloud, or install anything without your say-so.</p>
      <div className="recovery-glass mt-10 rounded-2xl p-5 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="recovery-glass-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#8f2f61]"><WifiOff className="h-5 w-5" /></div>
          <div>
            <p className="font-medium text-[#43283f]">{reasonCopy}</p>
            <p className="mt-1.5 text-sm leading-6 text-[#785f73]">{previewMode ? 'The browser preview cannot reach the desktop bridge. Open the packaged ThinkPink app to check Ollama for real.' : 'Open Ollama, then come back here and check again. ThinkPink will stay local-only while it is unavailable.'}</p>
          </div>
        </div>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={onRetry} data-testid="button-retry-connection" className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8f2f61] px-4 py-3 text-sm font-medium text-white shadow-[0_5px_14px_rgba(143,47,97,.18)] transition hover:bg-[#75304f]"><RefreshCw className="h-4 w-4" /> Check local connection</button>
          <button type="button" onClick={onOpenDownload} data-testid="button-open-ollama-download" className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#dcb9c9] bg-[#fffaf9] px-4 py-3 text-sm font-medium text-[#633752] transition hover:bg-[#f8e9ef]"><ExternalLink className="h-4 w-4" /> Get Ollama from its official site</button>
        </div>
      </div>
      <div className="mt-6 flex items-start gap-3 text-xs leading-5 text-[#785f73]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#3f715f]" /><span>Nothing is downloaded by these buttons. The official page opens only after you ask, and installation remains in your hands.</span></div>
    </section>
  );
}

function UnsupportedState({ connection, onOpenUpdate }: { connection: Extract<OllamaConnection, { status: 'unsupported' }>; onOpenUpdate: () => void }) {
  return (
    <section className="rise-in max-w-3xl py-8 sm:py-14">
      <p className="font-mono-ui text-[10px] uppercase tracking-[.23em] text-[#8f2f61]">Connection check</p>
      <h1 className="mt-4 max-w-2xl font-display text-5xl leading-[.98] tracking-[-.04em] text-[#43283f] sm:text-7xl">Ollama needs an update.</h1>
      <p className="mt-6 max-w-xl text-base leading-7 text-[#785f73]">{connection.reason}</p>
      <div className="mt-10 rounded-2xl border border-[#ead1dc] bg-[#fffaf9]/90 p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4 border-b border-[#eee0e6] pb-5">
          <span className="text-sm text-[#785f73]">Detected version</span>
          <span className="font-mono-ui text-sm text-[#43283f]">{connection.version ?? 'Version unavailable'}</span>
        </div>
        <div className="flex items-center justify-between gap-4 pt-5">
          <span className="text-sm text-[#785f73]">Minimum supported</span>
          <span className="font-mono-ui text-sm text-[#43283f]">{connection.minimumVersion}</span>
        </div>
        <button type="button" onClick={onOpenUpdate} data-testid="button-open-ollama-update" className="mt-7 inline-flex items-center gap-2 rounded-lg bg-[#8f2f61] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#75304f]"><ExternalLink className="h-4 w-4" /> Open official update page</button>
      </div>
    </section>
  );
}

function ModelSetup({ catalog: items, selectedModel, onSelect, onDownload, previewMode, pull, onDismissPull, onOpenLibrary }: { catalog: CatalogItem[]; selectedModel: string | null; onSelect: (model: string) => void; onDownload: (item: CatalogItem) => void; previewMode: boolean; pull: HomePull | null; onDismissPull: () => void; onOpenLibrary: () => void }) {
  return (
    <section className="rise-in py-4 sm:py-8">
      <div className="max-w-3xl">
        <p className="font-mono-ui text-[10px] uppercase tracking-[.23em] text-[#8f2f61]">One more local step</p>
        <h1 className="mt-4 font-display text-5xl leading-[.98] tracking-[-.04em] text-[#43283f] sm:text-7xl">Ollama is here. Now choose a mind.</h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-[#785f73]">Ollama is the local engine; models are separate downloads. Pick one to review its name and terms before ThinkPink asks Ollama to fetch it.</p>
      </div>
      {pull && <PullProgress pull={pull} onCancel={onDismissPull} />}
      <div className="mt-10 grid gap-4 xl:grid-cols-[1fr_300px]">
        <div className="space-y-3">
          {items.map((item, index) => <CatalogCard key={item.name} item={item} index={index} selected={selectedModel === item.name} onSelect={() => onSelect(item.name)} onDownload={() => onDownload(item)} disabled={previewMode || pull?.status === 'progress'} />)}
        </div>
        <div className="h-fit rounded-2xl border border-[#e8d7e0] bg-[#eee8f1]/75 p-5">
          <div className="flex items-center gap-2 text-[#633752]"><CloudOff className="h-4 w-4" /><p className="text-sm font-medium">Local means local</p></div>
          <p className="mt-3 text-sm leading-6 text-[#785f73]">Models and messages stay with Ollama on this device. ThinkPink has no hosted inference fallback.</p>
          <div className="mt-5 border-t border-[#dcd3e0] pt-4 text-xs leading-5 text-[#785f73]">
            <p className="font-medium text-[#633752]">Before a download</p>
            <p className="mt-1">You will see the exact model name, the estimated size, and a link to review the model library.</p>
          </div>
          <button type="button" onClick={onOpenLibrary} data-testid="button-open-model-library" className="mt-5 inline-flex items-center gap-2 text-xs font-medium text-[#8f2f61] hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Review Ollama model library</button>
          {previewMode && <p className="mt-5 rounded-lg bg-[#fffaf9] p-3 text-xs leading-5 text-[#785f73]">Downloads are disabled in browser preview because there is no desktop bridge to approve a real pull.</p>}
        </div>
      </div>
    </section>
  );
}

function CatalogCard({ item, index, selected, onSelect, onDownload, disabled }: { item: CatalogItem; index: number; selected: boolean; onSelect: () => void; onDownload: () => void; disabled: boolean }) {
  return (
    <article className={`rounded-2xl border bg-[#fffaf9]/90 p-5 transition ${selected ? 'border-[#b64378] shadow-[0_8px_24px_rgba(143,47,97,.11)]' : 'border-[#e8d7e0] hover:border-[#d7b5c5]'}`} data-testid={`card-model-${item.name}`}>
      <div className="flex items-start gap-4">
        <button type="button" onClick={onSelect} aria-label={`Select ${item.name}`} data-testid={`button-select-model-${item.name}`} className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-[#8f2f61] bg-[#8f2f61] text-white' : 'border-[#c7a4b5] text-transparent hover:border-[#8f2f61]'}`}><Check className="h-3.5 w-3.5" /></button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono-ui text-sm font-medium text-[#43283f]">{item.name}</h2>
            {index === 0 && <span className="rounded-full bg-[#f2dbe5] px-2 py-0.5 text-[10px] font-medium text-[#8f2f61]">A gentle start</span>}
          </div>
          <p className="mt-2 text-sm leading-6 text-[#785f73]">{item.description}</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-[#785f73]">
            <span className="font-mono-ui">{item.estimatedSize}</span>
            <span>{item.family} family</span>
            <span>{item.license}</span>
          </div>
        </div>
        <button type="button" onClick={onDownload} disabled={disabled} data-testid={`button-download-model-${item.name}`} className="hidden shrink-0 items-center gap-2 rounded-lg bg-[#8f2f61] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45 sm:inline-flex"><Download className="h-3.5 w-3.5" /> Download</button>
      </div>
      <button type="button" onClick={onDownload} disabled={disabled} data-testid={`button-download-model-mobile-${item.name}`} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#8f2f61] px-3 py-2.5 text-xs font-medium text-white sm:hidden disabled:cursor-not-allowed disabled:opacity-45"><Download className="h-3.5 w-3.5" /> Download this model</button>
    </article>
  );
}

function ReadyWorkspace({ models, selectedModel, onSelect, onDownload, previewMode, pull, onDismissPull, onOpenLibrary }: { models: InstalledModel[]; selectedModel: string; onSelect: (model: string) => void; onDownload: (item: CatalogItem) => void; previewMode: boolean; pull: HomePull | null; onDismissPull: () => void; onOpenLibrary: () => void }) {
  return (
    <section className="rise-in py-4 sm:py-8">
      <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.23em] text-[#8f2f61]">Local workspace</p>
          <h1 className="mt-4 font-display text-5xl leading-[.98] tracking-[-.04em] text-[#43283f] sm:text-7xl">A quiet place to think.</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[#785f73]">Choose a model, then start a conversation that stays between you and this computer.</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-[#cce0d5] bg-[#f0f7f2] px-3.5 py-3 text-xs text-[#3f715f]"><ShieldCheck className="h-4 w-4" /><span>Only local Ollama is connected</span></div>
      </div>
      {pull && <PullProgress pull={pull} onCancel={onDismissPull} />}
      <div className="mt-10 grid gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
        <ThinkPinkWorkspace models={models} selectedModel={selectedModel} onSelectModel={onSelect} previewMode={previewMode} />
        <aside className="space-y-4">
          <ModelShelf models={models} selectedModel={selectedModel} onSelect={onSelect} />
          <div className="rounded-2xl border border-[#e8d7e0] bg-[#eee8f1]/75 p-5">
            <p className="font-mono-ui text-[10px] uppercase tracking-[.19em] text-[#785f73]">Need another model?</p>
            <p className="mt-2 text-sm leading-6 text-[#633752]">Review the official library, then bring a new model onto this device with your approval.</p>
            <button type="button" onClick={onOpenLibrary} data-testid="button-open-library-ready" className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-[#8f2f61] hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Browse official library</button>
            {catalog.filter((item) => !models.some((model) => model.name === item.name)).slice(0, 1).map((item) => (
              <button type="button" key={item.name} disabled={previewMode || pull?.status === 'progress'} onClick={() => onDownload(item)} data-testid={`button-add-model-${item.name}`} className="mt-4 flex w-full items-center justify-between rounded-lg border border-[#dcb9c9] bg-[#fffaf9] px-3 py-2.5 text-left text-xs text-[#633752] hover:bg-[#f8e9ef] disabled:cursor-not-allowed disabled:opacity-45"><span className="font-mono-ui">{item.name}</span><Download className="h-3.5 w-3.5" /></button>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

type HomePull = { requestId: string; modelName: string; phase: string; completed?: number; total?: number; status: 'progress' | 'success' | 'cancelled' | 'error'; message?: string };

function PullProgress({ pull, onCancel }: { pull: HomePull; onCancel: () => void }) {
  const percent = pull.total && pull.completed ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : null;
  const active = pull.status === 'progress';
  const title = pull.status === 'success' ? `${pull.modelName} is ready` : pull.status === 'cancelled' ? 'Download cancelled' : pull.status === 'error' ? 'Download interrupted' : `Downloading ${pull.modelName}`;
  return (
    <div role="status" aria-live="polite" data-testid="status-pull-progress" className={`mt-8 rounded-2xl border p-5 ${pull.status === 'error' ? 'border-[#e4bdc5] bg-[#fff2f3]' : 'border-[#d9c5df] bg-[#f5eff7]'}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e8d7e0] text-[#8f2f61]">{active ? <LoaderCircle className="h-5 w-5 animate-spin" /> : pull.status === 'success' ? <Check className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}</div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#43283f]">{title}</p>
          <p className="mt-1 text-xs leading-5 text-[#785f73]">{pull.message ?? (active ? `${pull.phase}${percent !== null ? ` · ${percent}%` : ''}` : pull.status === 'success' ? 'Ollama confirmed this model locally.' : 'Nothing was reported as ready until Ollama confirms it.')}</p>
          {active && <div className="mt-4"><div className="h-2 overflow-hidden rounded-full bg-[#e5d9e8]"><div className="h-full rounded-full bg-[#b64378] transition-[width] duration-300" style={{ width: `${percent ?? 18}%` }} /></div><div className="mt-2 flex justify-between font-mono-ui text-[10px] text-[#785f73]"><span>{pull.phase}</span><span>{percent !== null ? `${percent}%` : 'Working'}</span></div></div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active && <button type="button" onClick={async () => { const bridge = getBridge(); if (bridge) { try { await bridge.cancelRequest(pull.requestId); } catch { /* event will report failure */ } } else onCancel(); }} data-testid="button-cancel-download" className="inline-flex items-center gap-2 rounded-lg border border-[#dcb9c9] bg-[#fffaf9] px-3 py-2 text-xs font-medium text-[#633752] hover:bg-[#f8e9ef]"><Square className="h-3 w-3 fill-current" /> Cancel</button>}
          {!active && <button type="button" onClick={onCancel} aria-label="Dismiss download status" data-testid="button-dismiss-download-status" className="rounded-md p-1.5 text-[#785f73] hover:bg-[#eadbe9]"><X className="h-4 w-4" /></button>}
        </div>
      </div>
    </div>
  );
}

function ModelShelf({ models, selectedModel, onSelect }: { models: InstalledModel[]; selectedModel: string; onSelect: (name: string) => void }) {
  return (
    <div className="rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5">
      <div className="flex items-center justify-between"><p className="font-mono-ui text-[10px] uppercase tracking-[.19em] text-[#785f73]">Installed here</p><span className="font-mono-ui text-[10px] text-[#785f73]">{models.length} {models.length === 1 ? 'model' : 'models'}</span></div>
      <div className="mt-4 space-y-2">
        {models.map((model) => <button type="button" key={model.name} onClick={() => onSelect(model.name)} data-testid={`button-select-installed-${model.name}`} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${selectedModel === model.name ? 'border-[#c589a5] bg-[#f8e9ef]' : 'border-transparent hover:border-[#e8d7e0] hover:bg-[#fff4f7]'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-lg ${selectedModel === model.name ? 'bg-[#8f2f61] text-white' : 'bg-[#eee8f1] text-[#785f73]'}`}><HardDrive className="h-3.5 w-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate font-mono-ui text-xs text-[#43283f]">{model.name}</span><span className="mt-1 block text-[10px] text-[#785f73]">{model.details.parameterSize ?? 'Local model'} · {formatBytes(model.sizeBytes)}</span></span>{selectedModel === model.name && <Check className="h-4 w-4 text-[#8f2f61]" />}</button>)}
      </div>
    </div>
  );
}

function DownloadDialog({ item, onClose, onConfirm, onOpenModel }: { item: CatalogItem; onClose: () => void; onConfirm: () => void; onOpenModel: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#43283f]/35 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="download-dialog-title" className="w-full max-w-lg rounded-2xl border border-[#ead2de] bg-[#fffaf9] p-6 shadow-[0_24px_80px_rgba(67,40,63,.24)] sm:p-8">
        <div className="flex items-start justify-between gap-5"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#8f2f61]">Approval needed</p><h2 id="download-dialog-title" className="mt-3 font-display text-3xl tracking-[-.025em] text-[#43283f]">Download this model?</h2></div><button type="button" onClick={onClose} aria-label="Close download confirmation" data-testid="button-close-download-dialog" className="rounded-lg p-2 text-[#785f73] hover:bg-[#f2dbe5]"><X className="h-5 w-5" /></button></div>
        <p className="mt-4 text-sm leading-6 text-[#785f73]">ThinkPink will ask your local Ollama service to download the exact model below. This may use the internet. It will not be ready until Ollama confirms the pull.</p>
        <div className="divide-y divide-[#eee0e6] rounded-xl border border-[#eadbe2] bg-[#fff4f7] px-4">
          <div className="flex items-center justify-between gap-4 py-4"><span className="text-xs text-[#785f73]">Model</span><span className="font-mono-ui text-sm text-[#43283f]">{item.name}</span></div>
          <div className="flex items-center justify-between gap-4 py-4"><span className="text-xs text-[#785f73]">Estimated download</span><span className="font-mono-ui text-sm text-[#43283f]">{item.estimatedSize}</span></div>
          <div className="flex items-center justify-between gap-4 py-4"><span className="text-xs text-[#785f73]">License</span><span className="text-right text-xs text-[#43283f]">{item.license}</span></div>
          <div className="flex items-center justify-between gap-4 py-4"><span className="text-xs text-[#785f73]">Destination</span><span className="text-right text-xs text-[#43283f]">Ollama on this device</span></div>
        </div>
        <button type="button" onClick={onOpenModel} data-testid="button-open-model-terms" className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-[#8f2f61] hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Review this model’s source and license</button>
        <div className="mt-5 flex items-start gap-2.5 text-xs leading-5 text-[#785f73]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#3f715f]" /><span>You can cancel while it downloads. ThinkPink will show progress and will not silently retry or use another source.</span></div>
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} data-testid="button-cancel-model-download" className="rounded-lg border border-[#dcb9c9] px-4 py-3 text-sm font-medium text-[#633752] hover:bg-[#f8e9ef]">Not now</button><button type="button" onClick={onConfirm} data-testid="button-confirm-model-download" className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8f2f61] px-4 py-3 text-sm font-medium text-white hover:bg-[#75304f]"><Download className="h-4 w-4" /> Download selected model</button></div>
      </div>
    </div>
  );
}

export default App;