import { useEffect, useState } from 'react';
import { Brain, Check, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import type { ChatThread, WikiPage } from '@/lib/localKnowledge';
import type {
  HindsightSourceInput,
  HindsightSourceKind,
  HindsightStatus,
  InstalledModel,
} from '@/lib/thinkpinkBridge';
import {
  buildHindsightThreadSource,
  buildHindsightWikiSource,
} from '@/lib/hindsightSources';

type HindsightSettingsProps = {
  available: boolean;
  status: HindsightStatus | null;
  threads: ChatThread[];
  wikiPages: WikiPage[];
  models: InstalledModel[];
  selectedModel: string;
  progress: string | null;
  error: string | null;
  onSetup: (modelName: string) => Promise<void>;
  onSetEnabled: (enabled: boolean, modelName: string) => Promise<void>;
  onIndex: (source: HindsightSourceInput) => Promise<void>;
  onForget: (kind: HindsightSourceKind, id: string) => Promise<void>;
  onForgetAll: () => Promise<void>;
};

function indexedKey(kind: HindsightSourceKind, id: string) {
  return `${kind}:${id}`;
}

function SourceRow({
  kind,
  id,
  title,
  description,
  indexed,
  disabled,
  onToggle,
}: {
  kind: HindsightSourceKind;
  id: string;
  title: string;
  description: string;
  indexed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      data-testid={`hindsight-source-${kind}-${id}`}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-[#eadbe2] bg-[#fffaf9] px-3 py-3"
    >
      <input
        type="checkbox"
        checked={indexed}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`${indexed ? 'Remove' : 'Add'} ${kind === 'thread' ? 'thread' : 'wiki page'} ${title} ${indexed ? 'from' : 'to'} Hindsight memory`}
        data-testid={`checkbox-hindsight-source-${kind}-${id}`}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#8f2f61]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[#43283f]">{title}</span>
        <span className="mt-1 block text-[10px] leading-4 text-[#8b7182]">{description}</span>
      </span>
      {indexed && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#3f715f]" />}
    </label>
  );
}

export function HindsightSettings({
  available,
  status,
  threads,
  wikiPages,
  models,
  selectedModel,
  progress,
  error,
  onSetup,
  onSetEnabled,
  onIndex,
  onForget,
  onForgetAll,
}: HindsightSettingsProps) {
  const [modelChoice, setModelChoice] = useState(status?.modelName ?? selectedModel);
  const [busy, setBusy] = useState(false);
  const [showSetupConsent, setShowSetupConsent] = useState(false);
  const [showForgetConsent, setShowForgetConsent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const indexed = new Set((status?.indexedSources ?? []).map((source) => indexedKey(source.kind, source.id)));

  useEffect(() => {
    setModelChoice(status?.modelName ?? selectedModel);
  }, [selectedModel, status?.modelName]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (operationError) {
      setActionError(operationError instanceof Error ? operationError.message : 'The local Hindsight operation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleSource(source: HindsightSourceInput, isIndexed: boolean) {
    await perform(() => isIndexed ? onForget(source.kind, source.id) : onIndex(source));
  }

  const setupRequired = !status?.runtimeInstalled;
  const currentModel = modelChoice || selectedModel;

  return (
    <section data-testid="panel-hindsight-settings" className="mt-6 max-w-4xl rounded-2xl border border-[#e3d5e0] bg-[#fffaf9]/90 p-5 shadow-[0_12px_32px_rgba(67,40,63,.05)] sm:p-7">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f2dbe5] text-[#8f2f61]">
          <Brain className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono-ui text-[10px] uppercase tracking-[0.2em] text-[#8f2f61]">Optional local memory</p>
          <h2 className="mt-1 font-display text-2xl tracking-[-0.025em] text-[#43283f]">Hindsight for this device</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#785f73]">
            Search selected threads and wiki pages semantically, then prepare editable wiki drafts. Your transcripts and wiki remain the originals.
          </p>
        </div>
      </div>

      {!available ? (
        <div role="status" data-testid="status-hindsight-unavailable" className="mt-5 rounded-xl border border-[#eadbe2] bg-[#fdf7f8] p-3 text-xs leading-5 text-[#785f73]">
          Hindsight setup and local memory are available in the ThinkPink desktop app. The browser preview does not install or run local services.
        </div>
      ) : (
        <>
          {error && <div role="alert" data-testid="status-hindsight-error" className="mt-4 rounded-lg border border-[#e8c4cc] bg-[#fff2f3] px-3 py-2.5 text-xs leading-5 text-[#863f52]">{error}</div>}
          {actionError && <div role="alert" data-testid="status-hindsight-action-error" className="mt-3 rounded-lg border border-[#e8c4cc] bg-[#fff2f3] px-3 py-2.5 text-xs leading-5 text-[#863f52]">{actionError}</div>}
          {progress && <div role="status" aria-live="polite" data-testid="status-hindsight-progress" className="mt-3 flex items-center gap-2 rounded-lg border border-[#eadbe2] bg-[#fdf7f8] px-3 py-2.5 text-xs text-[#633752]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{progress}</div>}

          {setupRequired ? (
            <div className="mt-5 rounded-xl border border-[#eadbe2] bg-[#fdf7f8] p-4">
              <p className="text-xs font-semibold text-[#43283f]">Hindsight is not installed.</p>
              <p className="mt-1.5 text-xs leading-5 text-[#785f73]">
                Setup uses an existing Python 3.11+ installation and downloads Hindsight Embed plus its local support models. ThinkPink will not install Python system-wide. Downloaded components and memory data stay in this app’s data folder.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label htmlFor="select-hindsight-model" className="sr-only">Local Ollama model for Hindsight</label>
                <select
                  id="select-hindsight-model"
                  value={currentModel}
                  onChange={(event) => setModelChoice(event.target.value)}
                  disabled={busy || models.length === 0}
                  data-testid="select-hindsight-model"
                  className="min-w-0 flex-1 rounded-lg border border-[#e4d3dd] bg-white px-3 py-2 text-xs text-[#633752] disabled:opacity-50"
                >
                  <option value="" disabled>Choose installed Ollama model</option>
                  {models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => setShowSetupConsent(true)}
                  disabled={busy || !currentModel}
                  data-testid="button-setup-hindsight"
                  className="rounded-lg bg-[#8f2f61] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Review setup
                </button>
              </div>
              {models.length === 0 && <p className="mt-2 text-[10px] leading-4 text-[#8b7182]">Connect Ollama and install a local model before setting up Hindsight.</p>}
            </div>
          ) : (
            <>
              <div className="mt-5 flex flex-col gap-3 rounded-xl border border-[#eadbe2] bg-[#fdf7f8] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#43283f]">{status?.enabled ? 'Local memory is active' : 'Local memory is paused'}</p>
                  <p className="mt-1 text-[10px] leading-4 text-[#785f73]">
                    {status?.modelName ? `Using local Ollama model ${status.modelName}.` : 'Choose an installed local Ollama model.'}
                    {' '}Only sources you select below are indexed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void perform(() => onSetEnabled(!status?.enabled, currentModel))}
                  disabled={busy || (!status?.enabled && !currentModel)}
                  data-testid="button-toggle-hindsight"
                  className={`rounded-lg px-3.5 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${status?.enabled ? 'border border-[#dcb9c9] bg-white text-[#633752] hover:bg-[#f8e9ef]' : 'bg-[#8f2f61] text-white hover:bg-[#75304f]'}`}
                >
                  {status?.enabled ? 'Pause memory' : 'Resume memory'}
                </button>
              </div>

              <div className="mt-4">
                <label htmlFor="select-hindsight-model" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6f5267]">Local Ollama model</label>
                <div className="flex flex-wrap gap-2">
                  <select
                    id="select-hindsight-model"
                    value={currentModel}
                    onChange={(event) => setModelChoice(event.target.value)}
                    disabled={busy || models.length === 0}
                    data-testid="select-hindsight-model"
                    className="min-w-0 flex-1 rounded-lg border border-[#e4d3dd] bg-white px-3 py-2 text-xs text-[#633752] disabled:opacity-50"
                  >
                    <option value="" disabled>Choose installed Ollama model</option>
                    {models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                  {currentModel !== status?.modelName && (
                    <button type="button" onClick={() => void perform(() => onSetEnabled(true, currentModel))} disabled={busy || !currentModel} data-testid="button-change-hindsight-model" className="rounded-lg border border-[#dcb9c9] bg-white px-3 py-2 text-xs font-medium text-[#633752] hover:bg-[#f8e9ef] disabled:opacity-45">Switch model and resume</button>
                  )}
                </div>
              </div>

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <fieldset className="min-w-0 space-y-2">
                  <legend className="mb-2 text-xs font-semibold text-[#43283f]">Choose threads</legend>
                  {threads.length === 0 ? <p className="rounded-lg bg-[#fdf7f8] px-3 py-3 text-[10px] text-[#8b7182]">No local threads yet.</p> : threads.map((thread) => {
                    const source = buildHindsightThreadSource(thread);
                    const sourceIsIndexed = indexed.has(indexedKey('thread', thread.id));
                    const turnCount = thread.messages.length;
                    return (
                      <SourceRow
                        key={thread.id}
                        kind="thread"
                        id={thread.id}
                        title={thread.title || 'Untitled thread'}
                        description={`${turnCount} ${turnCount === 1 ? 'message' : 'messages'} · updated ${thread.updatedAt ? new Date(thread.updatedAt).toLocaleDateString() : 'recently'}`}
                        indexed={sourceIsIndexed}
                        disabled={busy || !status || (!status.enabled && !sourceIsIndexed) || (!sourceIsIndexed && !source.content.trim())}
                        onToggle={() => void toggleSource(source, sourceIsIndexed)}
                      />
                    );
                  })}
                </fieldset>

                <fieldset className="min-w-0 space-y-2">
                  <legend className="mb-2 text-xs font-semibold text-[#43283f]">Choose wiki pages</legend>
                  {wikiPages.length === 0 ? <p className="rounded-lg bg-[#fdf7f8] px-3 py-3 text-[10px] text-[#8b7182]">No local wiki pages yet.</p> : wikiPages.map((page) => {
                    const source = buildHindsightWikiSource(page);
                    const sourceIsIndexed = indexed.has(indexedKey('wiki', page.id));
                    return (
                      <SourceRow
                        key={page.id}
                        kind="wiki"
                        id={page.id}
                        title={page.title || 'Untitled wiki page'}
                        description={`${page.category || 'Unsorted'} · updated ${page.updatedAt ? new Date(page.updatedAt).toLocaleDateString() : 'recently'}`}
                        indexed={sourceIsIndexed}
                        disabled={busy || !status || (!status.enabled && !sourceIsIndexed)}
                        onToggle={() => void toggleSource(source, sourceIsIndexed)}
                      />
                    );
                  })}
                </fieldset>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#eadbe2] pt-4">
                <p className="text-[10px] leading-4 text-[#785f73]" data-testid="text-hindsight-source-count">
                  {status?.indexedSources.length ?? 0} selected source{status?.indexedSources.length === 1 ? '' : 's'}
                  {status?.pendingCleanupCount ? ` · ${status.pendingCleanupCount} cleanup item${status.pendingCleanupCount === 1 ? '' : 's'} pending` : ''}
                </p>
                <button type="button" onClick={() => setShowForgetConsent(true)} disabled={busy || !status?.indexedSources.length && !status?.pendingCleanupCount} data-testid="button-forget-all-hindsight" className="inline-flex items-center gap-1.5 rounded-lg border border-[#e6bfc7] bg-white px-3 py-2 text-[10px] font-medium text-[#863f52] hover:bg-[#fff2f3] disabled:cursor-not-allowed disabled:opacity-45">
                  <Trash2 className="h-3.5 w-3.5" /> Forget all Hindsight memory
                </button>
              </div>
            </>
          )}

          {showSetupConsent && (
            <div role="alertdialog" aria-modal="true" aria-labelledby="hindsight-setup-title" data-testid="dialog-hindsight-setup-consent" className="fixed inset-0 z-50 flex items-center justify-center bg-[#2c1c2b]/40 p-4">
              <div className="w-full max-w-lg rounded-2xl border border-[#e3d5e0] bg-[#fffaf9] p-5 shadow-2xl sm:p-6">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#3f715f]" />
                  <div>
                    <h3 id="hindsight-setup-title" className="font-display text-2xl text-[#43283f]">Set up local Hindsight?</h3>
                    <p className="mt-2 text-xs leading-5 text-[#785f73]">
                      ThinkPink will download and install Hindsight Embed into its app data folder, then start its local pg0 service. The first use may also download local embedding and reranking models. Existing Python 3.11+ is required; ThinkPink will not install Python system-wide. Only the local Ollama model and sources you choose will be used. No transcript or wiki content is sent to a hosted service.
                    </p>
                    <p className="mt-2 text-[10px] leading-4 text-[#8b7182]">Hindsight starts with no indexed sources. You will select each thread or wiki page below.</p>
                    <div className="mt-5 flex justify-end gap-2">
                      <button type="button" onClick={() => setShowSetupConsent(false)} data-testid="button-cancel-hindsight-setup" className="rounded-lg border border-[#decbd7] px-3 py-2 text-xs text-[#633752] hover:bg-[#f8e9ef]">Cancel</button>
                      <button type="button" onClick={() => { setShowSetupConsent(false); void perform(() => onSetup(currentModel)); }} data-testid="button-confirm-hindsight-setup" className="rounded-lg bg-[#8f2f61] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#75304f]">Download and set up</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showForgetConsent && (
            <div role="alertdialog" aria-modal="true" aria-labelledby="hindsight-forget-title" data-testid="dialog-hindsight-forget-consent" className="fixed inset-0 z-50 flex items-center justify-center bg-[#2c1c2b]/40 p-4">
              <div className="w-full max-w-md rounded-2xl border border-[#e3d5e0] bg-[#fffaf9] p-5 shadow-2xl">
                <h3 id="hindsight-forget-title" className="font-display text-2xl text-[#43283f]">Forget all Hindsight memory?</h3>
                <p className="mt-2 text-xs leading-5 text-[#785f73]">This deletes Hindsight’s derived records and clears its source selection. Your local transcripts and wiki pages stay unchanged.</p>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setShowForgetConsent(false)} data-testid="button-cancel-forget-hindsight" className="rounded-lg border border-[#decbd7] px-3 py-2 text-xs text-[#633752] hover:bg-[#f8e9ef]">Cancel</button>
                  <button type="button" onClick={() => { setShowForgetConsent(false); void perform(onForgetAll); }} data-testid="button-confirm-forget-hindsight" className="rounded-lg bg-[#863f52] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#703548]">Forget memory</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}