export type WikiContextMode = 'manual' | 'approval' | 'automatic';

export type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  interrupted?: boolean;
};

export type ChatThread = {
  id: string;
  title: string;
  summary: string;
  messages: ThreadMessage[];
  wikiContextMode: WikiContextMode | 'default';
  wikiPageIds: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WikiPage = {
  id: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type LocalSettings = {
  id: 'preferences';
  defaultWikiContextMode: WikiContextMode;
  contextWindowTokens: 2048 | 4096 | 8192;
};

export type WikiPageDraft = Pick<WikiPage, 'title' | 'body' | 'category' | 'tags'>;
export type LocalBackupData = {
  threads: ChatThread[];
  wikiPages: WikiPage[];
  settings: LocalSettings | null;
};
export type LocalBackupValidation = LocalBackupData & {
  fatalError: string | null;
  invalidRecords: string[];
};
export type LocalBackupImportResult = {
  threadsImported: number;
  wikiPagesImported: number;
  settingsImported: boolean;
  conflictingThreads: number;
  conflictingWikiPages: number;
  conflictingSettings: boolean;
};

const DATABASE_NAME = 'thinkpink-local-ground-control';
const DATABASE_VERSION = 1;
const MAX_BACKUP_TEXT_LENGTH = 50_000_000;
const MAX_BACKUP_RECORDS = 10_000;
export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  id: 'preferences',
  defaultWikiContextMode: 'manual',
  contextWindowTokens: 4096,
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Local storage is unavailable in this environment.'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('threads')) {
        const threads = database.createObjectStore('threads', { keyPath: 'id' });
        threads.createIndex('updatedAt', 'updatedAt');
        threads.createIndex('archived', 'archived');
      }
      if (!database.objectStoreNames.contains('wikiPages')) {
        const pages = database.createObjectStore('wikiPages', { keyPath: 'id' });
        pages.createIndex('updatedAt', 'updatedAt');
        pages.createIndex('category', 'category');
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('ThinkPink could not open its local workspace.'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Close other ThinkPink windows before updating local storage.'));
    };
  });
  return databasePromise;
}

function runRequest<T>(
  storeName: 'threads' | 'wikiPages' | 'settings',
  mode: IDBTransactionMode,
  makeRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (error: DOMException | Error | null | undefined) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error('ThinkPink could not access local data.'));
    };

    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, mode);
      const request = makeRequest(transaction.objectStore(storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => fail(request.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error ?? new Error('The local change was not saved.'));
    } catch (error) {
      fail(error instanceof Error ? error : new Error('ThinkPink could not access local data.'));
    }
  }));
}

function isWikiContextMode(value: unknown): value is WikiContextMode {
  return value === 'manual' || value === 'approval' || value === 'automatic';
}

function isLocalSettings(value: unknown): value is LocalSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return settings.id === 'preferences'
    && isWikiContextMode(settings.defaultWikiContextMode)
    && (settings.contextWindowTokens === 2048
      || settings.contextWindowTokens === 4096
      || settings.contextWindowTokens === 8192);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && !Number.isNaN(Date.parse(value));
}

function isThreadMessage(value: unknown): value is ThreadMessage {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id, 128)
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.content === 'string'
    && value.content.length <= 50_000
    && isTimestamp(value.createdAt)
    && (value.interrupted === undefined || typeof value.interrupted === 'boolean');
}

function isChatThread(value: unknown): value is ChatThread {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id, 128)
    && typeof value.title === 'string'
    && value.title.length <= 100
    && typeof value.summary === 'string'
    && value.summary.length <= 12_000
    && Array.isArray(value.messages)
    && value.messages.length <= MAX_BACKUP_RECORDS
    && value.messages.every(isThreadMessage)
    && (value.wikiContextMode === 'default' || isWikiContextMode(value.wikiContextMode))
    && Array.isArray(value.wikiPageIds)
    && value.wikiPageIds.every((id) => isNonEmptyString(id, 128))
    && typeof value.archived === 'boolean'
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt);
}

function isWikiPage(value: unknown): value is WikiPage {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id, 128)
    && isNonEmptyString(value.title, 120)
    && typeof value.body === 'string'
    && value.body.length <= 50_000
    && typeof value.category === 'string'
    && value.category.length <= 80
    && Array.isArray(value.tags)
    && value.tags.length <= 24
    && value.tags.every((tag) => isNonEmptyString(tag, 40))
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt);
}

export function validateLocalBackupText(text: string): LocalBackupValidation {
  const empty: LocalBackupData = { threads: [], wikiPages: [], settings: null };
  if (text.length > MAX_BACKUP_TEXT_LENGTH) {
    return { ...empty, fatalError: 'This backup is larger than the 50 MB limit.', invalidRecords: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...empty, fatalError: 'This file is not valid JSON.', invalidRecords: [] };
  }
  if (!isRecord(parsed)) {
    return { ...empty, fatalError: 'This is not a ThinkPink backup file.', invalidRecords: [] };
  }
  if (parsed.format !== 'thinkpink-local-backup' || parsed.version !== 1) {
    return { ...empty, fatalError: 'This backup format or version is not supported.', invalidRecords: [] };
  }
  if (!isTimestamp(parsed.exportedAt)) {
    return { ...empty, fatalError: 'The backup is missing a valid export date.', invalidRecords: [] };
  }
  if (!Array.isArray(parsed.threads) || !Array.isArray(parsed.wikiPages)) {
    return { ...empty, fatalError: 'The backup must contain thread and wiki page lists.', invalidRecords: [] };
  }
  if (parsed.threads.length > MAX_BACKUP_RECORDS || parsed.wikiPages.length > MAX_BACKUP_RECORDS) {
    return { ...empty, fatalError: 'This backup contains more than 10,000 records in a section.', invalidRecords: [] };
  }

  const invalidRecords: string[] = [];
  const acceptedThreadIds = new Set<string>();
  const threads = parsed.threads.flatMap((thread, index) => {
    if (!isChatThread(thread)) {
      invalidRecords.push(`Thread ${index + 1}: invalid fields or values.`);
      return [];
    }
    if (acceptedThreadIds.has(thread.id)) {
      invalidRecords.push(`Thread ${index + 1}: duplicate ID "${thread.id}" in the backup.`);
      return [];
    }
    acceptedThreadIds.add(thread.id);
    return [thread];
  });

  const acceptedPageIds = new Set<string>();
  const wikiPages = parsed.wikiPages.flatMap((page, index) => {
    if (!isWikiPage(page)) {
      invalidRecords.push(`Wiki page ${index + 1}: invalid fields or values.`);
      return [];
    }
    if (acceptedPageIds.has(page.id)) {
      invalidRecords.push(`Wiki page ${index + 1}: duplicate ID "${page.id}" in the backup.`);
      return [];
    }
    acceptedPageIds.add(page.id);
    return [page];
  });

  let settings: LocalSettings | null = null;
  if (Object.hasOwn(parsed, 'settings')) {
    if (isLocalSettings(parsed.settings)) {
      settings = parsed.settings;
    } else {
      invalidRecords.push('Context settings: invalid fields or values.');
    }
  }

  return { fatalError: null, threads, wikiPages, settings, invalidRecords };
}

export function createLocalId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Secure local ID generation is unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

export const localKnowledgeStore = {
  async listThreads(): Promise<ChatThread[]> {
    const threads = await runRequest<ChatThread[]>('threads', 'readonly', (store) => store.getAll());
    return threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },

  saveThread(thread: ChatThread): Promise<IDBValidKey> {
    return runRequest('threads', 'readwrite', (store) => store.put(thread));
  },

  deleteThread(id: string): Promise<undefined> {
    return runRequest('threads', 'readwrite', (store) => store.delete(id));
  },

  async listWikiPages(): Promise<WikiPage[]> {
    const pages = await runRequest<WikiPage[]>('wikiPages', 'readonly', (store) => store.getAll());
    return pages.sort((left, right) => left.title.localeCompare(right.title));
  },

  saveWikiPage(page: WikiPage): Promise<IDBValidKey> {
    return runRequest('wikiPages', 'readwrite', (store) => store.put(page));
  },

  async deleteWikiPage(id: string): Promise<void> {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const transaction = database.transaction(['wikiPages', 'threads'], 'readwrite');
      const fail = (error: DOMException | Error | null | undefined) => {
        if (settled) return;
        settled = true;
        reject(error ?? new Error('ThinkPink could not delete this local wiki page.'));
      };
      transaction.objectStore('wikiPages').delete(id);
      const threadRequest = transaction.objectStore('threads').getAll();
      threadRequest.onsuccess = () => {
        for (const thread of threadRequest.result as ChatThread[]) {
          if (!thread.wikiPageIds.includes(id)) continue;
          transaction.objectStore('threads').put({
            ...thread,
            wikiPageIds: thread.wikiPageIds.filter((pageId) => pageId !== id),
            updatedAt: new Date().toISOString(),
          });
        }
      };
      threadRequest.onerror = () => fail(threadRequest.error);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error ?? new Error('The local wiki page was not deleted.'));
    });
  },

  async loadSettings(): Promise<LocalSettings> {
    const saved = await runRequest<LocalSettings | undefined>(
      'settings',
      'readonly',
      (store) => store.get('preferences'),
    );
    if (saved === undefined) return DEFAULT_LOCAL_SETTINGS;
    if (!isLocalSettings(saved)) {
      throw new Error('ThinkPink found unreadable local settings and left them unchanged.');
    }
    return saved;
  },

  async hasSavedSettings(): Promise<boolean> {
    const saved = await runRequest<LocalSettings | undefined>(
      'settings',
      'readonly',
      (store) => store.get('preferences'),
    );
    return saved !== undefined;
  },

  saveSettings(settings: LocalSettings): Promise<IDBValidKey> {
    return runRequest('settings', 'readwrite', (store) => store.put(settings));
  },

  importBackup(backup: LocalBackupData, replaceConflicts: boolean): Promise<LocalBackupImportResult> {
    return openDatabase().then((database) => new Promise<LocalBackupImportResult>((resolve, reject) => {
      let settled = false;
      let result: LocalBackupImportResult | null = null;
      const fail = (error: DOMException | Error | null | undefined) => {
        if (settled) return;
        settled = true;
        reject(error ?? new Error('ThinkPink could not restore this local backup.'));
      };

      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(['threads', 'wikiPages', 'settings'], 'readwrite');
        const threadStore = transaction.objectStore('threads');
        const pageStore = transaction.objectStore('wikiPages');
        const settingsStore = transaction.objectStore('settings');
        let pendingReads = 3;
        let existingThreads: ChatThread[] = [];
        let existingPages: WikiPage[] = [];
        let hasSettings = false;

        const finishRead = () => {
          pendingReads -= 1;
          if (pendingReads !== 0) return;

          const threadIds = new Set(existingThreads.map((thread) => thread.id));
          const pageIds = new Set(existingPages.map((page) => page.id));
          result = {
            threadsImported: 0,
            wikiPagesImported: 0,
            settingsImported: false,
            conflictingThreads: 0,
            conflictingWikiPages: 0,
            conflictingSettings: false,
          };
          for (const thread of backup.threads) {
            if (threadIds.has(thread.id) && !replaceConflicts) {
              result.conflictingThreads += 1;
              continue;
            }
            threadStore.put(thread);
            result.threadsImported += 1;
          }
          for (const page of backup.wikiPages) {
            if (pageIds.has(page.id) && !replaceConflicts) {
              result.conflictingWikiPages += 1;
              continue;
            }
            pageStore.put(page);
            result.wikiPagesImported += 1;
          }
          if (backup.settings) {
            if (hasSettings && !replaceConflicts) {
              result.conflictingSettings = true;
            } else {
              settingsStore.put(backup.settings);
              result.settingsImported = true;
            }
          }
        };

        const threadRequest = threadStore.getAll();
        threadRequest.onsuccess = () => {
          existingThreads = threadRequest.result as ChatThread[];
          finishRead();
        };
        threadRequest.onerror = () => fail(threadRequest.error);

        const pageRequest = pageStore.getAll();
        pageRequest.onsuccess = () => {
          existingPages = pageRequest.result as WikiPage[];
          finishRead();
        };
        pageRequest.onerror = () => fail(pageRequest.error);

        const settingsRequest = settingsStore.get('preferences');
        settingsRequest.onsuccess = () => {
          hasSettings = settingsRequest.result !== undefined;
          finishRead();
        };
        settingsRequest.onerror = () => fail(settingsRequest.error);

        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          if (!result) {
            reject(new Error('ThinkPink could not restore this local backup.'));
            return;
          }
          resolve(result);
        };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error ?? new Error('The local backup was not restored.'));
      } catch (error) {
        fail(error instanceof Error ? error : new Error('ThinkPink could not restore this local backup.'));
      }
    }));
  },
};

export function createEmptyThread(): ChatThread {
  const now = new Date().toISOString();
  return {
    id: createLocalId(),
    title: 'New thread',
    summary: '',
    messages: [],
    wikiContextMode: 'default',
    wikiPageIds: [],
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}