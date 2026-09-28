export interface InstalledModel {
  name: string;
  model: string;
  sizeBytes: number;
  digest: string;
  modifiedAt: string;
  details: {
    family: string | null;
    parameterSize: string | null;
    quantizationLevel: string | null;
  };
}

export interface ModelCatalogItem {
  name: string;
  description: string;
  estimatedSize: string;
  family: string;
  license: string;
  licenseUrl: string;
  modelPage: string;
}

export type OllamaConnection =
  | { status: "unreachable"; reason: "not-running" | "timeout" | "invalid-response" }
  | { status: "unsupported"; version: string | null; minimumVersion: string; reason: string }
  | { status: "ready"; version: string; models: InstalledModel[] };

export type PullEvent =
  | { requestId: string; status: "progress"; phase: string; completed?: number; total?: number }
  | { requestId: string; status: "success" }
  | { requestId: string; status: "cancelled" }
  | { requestId: string; status: "error"; message: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatEvent =
  | { requestId: string; status: "token"; content: string }
  | { requestId: string; status: "success" }
  | { requestId: string; status: "cancelled" }
  | { requestId: string; status: "error"; message: string };

export type OfficialPage = "download" | "library" | "update" | "model";

export type CodingLanguage = "java" | "python";

export type CodeCheckStatus =
  | "passed"
  | "compile-error"
  | "runtime-missing"
  | "timed-out"
  | "cancelled"
  | "busy"
  | "output-limit"
  | "error";

export interface CodeCheckResult {
  status: CodeCheckStatus;
  message: string;
  output: string;
}

export type HindsightSourceKind = 'thread' | 'wiki';

export interface HindsightSourceInput {
  kind: HindsightSourceKind;
  id: string;
  title: string;
  content: string;
}

export interface HindsightIndexedSource {
  kind: HindsightSourceKind;
  id: string;
  title: string;
  contentHash: string;
}

export interface HindsightStatus {
  runtimeInstalled: boolean;
  enabled: boolean;
  modelName: string | null;
  indexedSources: HindsightIndexedSource[];
  pendingCleanupCount: number;
  busy: boolean;
}

export interface HindsightRecallResult {
  text: string;
  context: string;
  score: number | null;
  kind: HindsightSourceKind;
  sourceId: string;
  title: string;
}

export interface HindsightRecallResponse {
  results: HindsightRecallResult[];
  status: HindsightStatus;
}

export interface HindsightWikiDraft {
  title: string;
  body: string;
  category: string;
  tags: string[];
}

export interface HindsightProgressEvent {
  stage: string;
}

export interface ThinkPinkBridge {
  checkConnection(): Promise<OllamaConnection>;
  reloadModels(): Promise<OllamaConnection>;
  startModelPull(modelName: string): Promise<{ requestId: string }>;
  startChat(modelName: string, messages: ChatMessage[], contextWindowTokens?: 2048 | 4096 | 8192): Promise<{ requestId: string }>;
  cancelRequest(requestId: string): Promise<void>;
  onPullEvent(listener: (event: PullEvent) => void): () => void;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  openOfficialPage(page: OfficialPage, modelName?: string): Promise<void>;
  checkCode(language: CodingLanguage, source: string): Promise<CodeCheckResult>;
  cancelCodeCheck(): Promise<void>;
  getHindsightStatus(): Promise<HindsightStatus>;
  setupHindsight(modelName: string): Promise<HindsightStatus>;
  setHindsightEnabled(enabled: boolean, modelName?: string): Promise<HindsightStatus>;
  indexHindsightSource(source: HindsightSourceInput): Promise<HindsightStatus>;
  forgetHindsightSource(kind: HindsightSourceKind, id: string): Promise<HindsightStatus>;
  forgetAllHindsight(): Promise<HindsightStatus>;
  syncIndexedHindsightSource(source: HindsightSourceInput): Promise<{ synced: boolean; status: HindsightStatus }>;
  recallHindsight(query: string, limit?: number): Promise<HindsightRecallResponse>;
  generateHindsightDraft(source: HindsightSourceInput, modelName?: string): Promise<HindsightWikiDraft>;
  cancelHindsightOperation(): Promise<void>;
  onHindsightProgress(listener: (event: HindsightProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    thinkPink?: ThinkPinkBridge;
  }
}

export {};