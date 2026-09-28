import { useMemo, useRef, useState } from 'react';
import { Download, FileJson, ShieldCheck, Upload } from 'lucide-react';
import type {
  ChatThread,
  LocalBackupData,
  LocalBackupImportResult,
  LocalBackupValidation,
  LocalSettings,
  WikiPage,
} from '@/lib/localKnowledge';
import { validateLocalBackupText } from '@/lib/localKnowledge';

type BackupRestorePanelProps = {
  threads: ChatThread[];
  wikiPages: WikiPage[];
  settings: LocalSettings;
  hasSavedSettings: boolean;
  onImport: (backup: LocalBackupData, replaceConflicts: boolean) => Promise<LocalBackupImportResult>;
};

type ExportScope = 'all' | 'selected';

const controlClassName = 'rounded-lg border border-[#dfcbd6] bg-[#fffaf9] px-3 py-2 text-xs font-medium text-[#633752] transition hover:bg-[#f8e9ef] disabled:cursor-not-allowed disabled:opacity-50';

function selectionToggle<T extends { id: string }>(selected: Set<string>, item: T) {
  const next = new Set(selected);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  return next;
}

export function BackupRestorePanel({
  threads,
  wikiPages,
  settings,
  hasSavedSettings,
  onImport,
}: BackupRestorePanelProps) {
  const [scope, setScope] = useState<ExportScope>('all');
  const [selectedThreadIds, setSelectedThreadIds] = useState(() => new Set(threads.map((thread) => thread.id)));
  const [selectedPageIds, setSelectedPageIds] = useState(() => new Set(wikiPages.map((page) => page.id)));
  const [includeSettings, setIncludeSettings] = useState(true);
  const [validation, setValidation] = useState<LocalBackupValidation | null>(null);
  const [replaceConflicts, setReplaceConflicts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedThreads = useMemo(
    () => threads.filter((thread) => scope === 'all' || selectedThreadIds.has(thread.id)),
    [scope, selectedThreadIds, threads],
  );
  const selectedPages = useMemo(
    () => wikiPages.filter((page) => scope === 'all' || selectedPageIds.has(page.id)),
    [scope, selectedPageIds, wikiPages],
  );

  const conflicts = useMemo(() => {
    if (!validation || validation.fatalError) return { threads: [] as ChatThread[], pages: [] as WikiPage[], settings: false };
    const localThreadIds = new Set(threads.map((thread) => thread.id));
    const localPageIds = new Set(wikiPages.map((page) => page.id));
    return {
      threads: validation.threads.filter((thread) => localThreadIds.has(thread.id)),
      pages: validation.wikiPages.filter((page) => localPageIds.has(page.id)),
      settings: validation.settings !== null && hasSavedSettings,
    };
  }, [hasSavedSettings, threads, validation, wikiPages]);

  const validRecordCount = (validation?.threads.length ?? 0)
    + (validation?.wikiPages.length ?? 0)
    + (validation?.settings ? 1 : 0);
  const conflictCount = conflicts.threads.length + conflicts.pages.length + Number(conflicts.settings);
  const canImport = Boolean(validation && !validation.fatalError && validRecordCount > 0 && !busy);

  function downloadBackup() {
    const backup = {
      format: 'thinkpink-local-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      threads: selectedThreads,
      wikiPages: selectedPages,
      ...(scope === 'all' || includeSettings ? { settings } : {}),
    };
    const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `thinkpink-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus({ tone: 'success', message: `Downloaded ${selectedThreads.length} thread${selectedThreads.length === 1 ? '' : 's'}, ${selectedPages.length} wiki page${selectedPages.length === 1 ? '' : 's'}${scope === 'all' || includeSettings ? ', and context settings' : ''}. The file stayed on this device.` });
  }

  async function readBackup(file: File) {
    setStatus(null);
    setReplaceConflicts(false);
    try {
      if (file.size > 50_000_000) {
        setValidation({
          fatalError: 'This backup is larger than the 50 MB limit.',
          invalidRecords: [],
          threads: [],
          wikiPages: [],
          settings: null,
        });
        return;
      }
      setValidation(validateLocalBackupText(await file.text()));
    } catch {
      setValidation({
        fatalError: 'ThinkPink could not read this file. Choose a readable JSON backup.',
        invalidRecords: [],
        threads: [],
        wikiPages: [],
        settings: null,
      });
    }
  }

  async function restoreBackup() {
    if (!validation || validation.fatalError || !canImport) return;
    if (replaceConflicts && !window.confirm('Replace existing threads, wiki pages, or context settings with matching backup records? This cannot be undone.')) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await onImport({
        threads: validation.threads,
        wikiPages: validation.wikiPages,
        settings: validation.settings,
      }, replaceConflicts);
      const skipped = result.conflictingThreads + result.conflictingWikiPages + Number(result.conflictingSettings);
      setStatus({
        tone: 'success',
        message: `Restored ${result.threadsImported} thread${result.threadsImported === 1 ? '' : 's'}, ${result.wikiPagesImported} wiki page${result.wikiPagesImported === 1 ? '' : 's'}${result.settingsImported ? ', and context settings' : ''}${skipped ? `. Kept ${skipped} existing item${skipped === 1 ? '' : 's'} with matching IDs` : ''}. No data was uploaded.`,
      });
    } catch (error) {
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'The backup could not be restored. Check local storage and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="panel-local-backup" className="mt-6 rounded-2xl border border-[#e8d7e0] bg-[#fffaf9]/90 p-5 shadow-[0_12px_32px_rgba(67,40,63,.05)] sm:p-7">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f2dbe5] text-[#8f2f61]"><FileJson className="h-4 w-4" /></div>
        <div>
          <h2 className="font-display text-2xl tracking-[-0.025em] text-[#43283f]">Back up or restore local data</h2>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-[#785f73]">Save a JSON copy of threads, wiki pages, and context settings on this device. Restoring reads the file locally; nothing is uploaded.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-[#eee0e6] bg-[#fdf8f9] p-4">
          <h3 className="text-sm font-semibold text-[#43283f]">Export a backup</h3>
          <p className="mt-1 text-xs leading-5 text-[#785f73]">{threads.length} local threads · {wikiPages.length} wiki pages · context settings</p>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Choose backup scope">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')} data-testid="button-export-all" className={`${controlClassName} ${scope === 'all' ? 'border-[#b64378] bg-[#f8e9ef] text-[#633752]' : ''}`}>Export everything</button>
            <button type="button" aria-pressed={scope === 'selected'} onClick={() => setScope('selected')} data-testid="button-export-selected" className={`${controlClassName} ${scope === 'selected' ? 'border-[#b64378] bg-[#f8e9ef] text-[#633752]' : ''}`}>Choose items</button>
          </div>

          {scope === 'selected' && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => { setSelectedThreadIds(new Set(threads.map((thread) => thread.id))); setSelectedPageIds(new Set(wikiPages.map((page) => page.id))); setIncludeSettings(true); }} className={controlClassName}>Select all</button>
                <button type="button" onClick={() => { setSelectedThreadIds(new Set()); setSelectedPageIds(new Set()); setIncludeSettings(false); }} className={controlClassName}>Clear selection</button>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-[#633752]">
                <input type="checkbox" checked={includeSettings} onChange={(event) => setIncludeSettings(event.target.checked)} className="h-4 w-4 accent-[#8f2f61]" data-testid="checkbox-export-settings" />
                Include context settings
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#987f91]">Threads</legend>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[#eadbe2] bg-white p-2">
                    {threads.length === 0 ? <p className="px-1 py-2 text-xs text-[#987f91]">No threads yet.</p> : threads.map((thread) => (
                      <label key={thread.id} className="flex items-start gap-2 rounded-md px-1 py-1.5 text-xs text-[#633752] hover:bg-[#fbf0f4]">
                        <input type="checkbox" checked={selectedThreadIds.has(thread.id)} onChange={() => setSelectedThreadIds((current) => selectionToggle(current, thread))} className="mt-0.5 h-4 w-4 shrink-0 accent-[#8f2f61]" data-testid={`checkbox-export-thread-${thread.id}`} />
                        <span className="min-w-0 truncate">{thread.title || 'Untitled thread'}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#987f91]">Wiki pages</legend>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[#eadbe2] bg-white p-2">
                    {wikiPages.length === 0 ? <p className="px-1 py-2 text-xs text-[#987f91]">No wiki pages yet.</p> : wikiPages.map((page) => (
                      <label key={page.id} className="flex items-start gap-2 rounded-md px-1 py-1.5 text-xs text-[#633752] hover:bg-[#fbf0f4]">
                        <input type="checkbox" checked={selectedPageIds.has(page.id)} onChange={() => setSelectedPageIds((current) => selectionToggle(current, page))} className="mt-0.5 h-4 w-4 shrink-0 accent-[#8f2f61]" data-testid={`checkbox-export-page-${page.id}`} />
                        <span className="min-w-0 truncate">{page.title || 'Untitled page'}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>
          )}

          <button type="button" onClick={downloadBackup} disabled={selectedThreads.length === 0 && selectedPages.length === 0 && !(scope === 'all' || includeSettings)} data-testid="button-download-local-backup" className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-50">
            <Download className="h-4 w-4" /> Download JSON backup
          </button>
        </section>

        <section className="rounded-xl border border-[#eee0e6] bg-[#fdf8f9] p-4">
          <h3 className="text-sm font-semibold text-[#43283f]">Restore from a backup</h3>
          <p className="mt-1 text-xs leading-5 text-[#785f73]">Choose a ThinkPink JSON backup. Invalid records are skipped and listed before restore.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            data-testid="input-local-backup-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void readBackup(file);
            }}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} data-testid="button-choose-local-backup" className={`${controlClassName} mt-4 inline-flex items-center gap-2`}>
            <Upload className="h-4 w-4" /> Choose backup file
          </button>

          {validation && (
            <div className="mt-4 space-y-3" data-testid="panel-backup-validation">
              {validation.fatalError ? (
                <div role="alert" className="rounded-lg border border-[#e8c4cc] bg-[#fff2f3] p-3 text-xs leading-5 text-[#8c304f]">{validation.fatalError}</div>
              ) : (
                <>
                  <div role="status" className="rounded-lg border border-[#d5e4db] bg-[#f1f8f3] p-3 text-xs leading-5 text-[#376b58]">
                    Found {validation.threads.length} valid thread{validation.threads.length === 1 ? '' : 's'}, {validation.wikiPages.length} valid wiki page{validation.wikiPages.length === 1 ? '' : 's'}{validation.settings ? ', and context settings' : ''}.
                  </div>
                  {conflictCount > 0 && (
                    <div className="rounded-lg border border-[#ead4ad] bg-[#fff8e9] p-3 text-xs leading-5 text-[#765522]" data-testid="text-backup-conflicts">
                      {conflictCount} matching item{conflictCount === 1 ? ' already exists' : 's already exist'} on this device. They will be kept unless you choose to replace them.
                      {[...conflicts.threads.map((item) => `Thread: ${item.title || 'Untitled thread'}`), ...conflicts.pages.map((item) => `Wiki page: ${item.title}`), ...(conflicts.settings ? ['Context settings'] : [])].slice(0, 5).map((label) => <span key={label} className="mt-1 block">• {label}</span>)}
                      {conflictCount > 5 && <span className="mt-1 block">and {conflictCount - 5} more</span>}
                    </div>
                  )}
                  {validation.invalidRecords.length > 0 && (
                    <div className="rounded-lg border border-[#e8c4cc] bg-[#fff2f3] p-3 text-xs leading-5 text-[#8c304f]" data-testid="list-backup-invalid-records">
                      <p className="font-semibold">{validation.invalidRecords.length} invalid record{validation.invalidRecords.length === 1 ? '' : 's'} will be skipped:</p>
                      <ul className="mt-1 max-h-28 list-inside list-disc overflow-y-auto">
                        {validation.invalidRecords.slice(0, 20).map((record) => <li key={record}>{record}</li>)}
                      </ul>
                      {validation.invalidRecords.length > 20 && <p className="mt-1">and {validation.invalidRecords.length - 20} more</p>}
                    </div>
                  )}
                  {conflictCount > 0 && (
                    <label className="flex items-start gap-2 text-xs leading-5 text-[#633752]">
                      <input type="checkbox" checked={replaceConflicts} onChange={(event) => setReplaceConflicts(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#8f2f61]" data-testid="checkbox-replace-backup-conflicts" />
                      <span>Replace existing records with matching IDs. ThinkPink will ask you to confirm before changing them.</span>
                    </label>
                  )}
                  {validRecordCount === 0 && <p className="text-xs text-[#8c304f]">There are no valid records to restore.</p>}
                </>
              )}
              <button type="button" onClick={() => void restoreBackup()} disabled={!canImport} data-testid="button-restore-local-backup" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#8f2f61] px-4 py-3 text-sm font-medium text-[#fff9fb] transition hover:bg-[#75304f] disabled:cursor-not-allowed disabled:opacity-50">
                <Upload className="h-4 w-4" /> {busy ? 'Restoring locally…' : replaceConflicts ? 'Replace conflicts and restore' : 'Restore without replacing'}
              </button>
            </div>
          )}
        </section>
      </div>

      {status && (
        <div role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite" data-testid="status-local-backup" className={`mt-4 flex items-start gap-2 rounded-xl border px-3.5 py-3 text-sm ${status.tone === 'error' ? 'border-[#e8c4cc] bg-[#fff2f3] text-[#8c304f]' : 'border-[#c9ded2] bg-[#f0f8f2] text-[#376b58]'}`}>
          {status.tone === 'success' && <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{status.message}</span>
        </div>
      )}
    </section>
  );
}