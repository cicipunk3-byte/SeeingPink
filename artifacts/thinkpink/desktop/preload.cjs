const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, listener) => {
  if (typeof listener !== "function") {
    throw new TypeError("An event listener function is required.");
  }
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld(
  "thinkPink",
  Object.freeze({
    checkConnection: () => ipcRenderer.invoke("thinkpink:check-connection"),
    reloadModels: () => ipcRenderer.invoke("thinkpink:reload-models"),
    startModelPull: (modelName) =>
      ipcRenderer.invoke("thinkpink:start-model-pull", modelName),
    startChat: (modelName, messages, contextWindowTokens) =>
      ipcRenderer.invoke("thinkpink:start-chat", { modelName, messages, contextWindowTokens }),
    cancelRequest: (requestId) =>
      ipcRenderer.invoke("thinkpink:cancel-request", requestId),
    onPullEvent: (listener) =>
      subscribe("thinkpink:pull-event", listener),
    onChatEvent: (listener) =>
      subscribe("thinkpink:chat-event", listener),
    openOfficialPage: (page, modelName) =>
      ipcRenderer.invoke("thinkpink:open-official-page", { page, modelName }),
    checkCode: (language, source) =>
      ipcRenderer.invoke("thinkpink:check-code", { language, source }),
    cancelCodeCheck: () =>
      ipcRenderer.invoke("thinkpink:cancel-code-check"),
    getHindsightStatus: () =>
      ipcRenderer.invoke("thinkpink:hindsight-status"),
    setupHindsight: (modelName) =>
      ipcRenderer.invoke("thinkpink:hindsight-setup", { modelName }),
    setHindsightEnabled: (enabled, modelName) =>
      ipcRenderer.invoke("thinkpink:hindsight-enable", { enabled, modelName }),
    indexHindsightSource: (source) =>
      ipcRenderer.invoke("thinkpink:hindsight-index-source", source),
    forgetHindsightSource: (kind, id) =>
      ipcRenderer.invoke("thinkpink:hindsight-forget-source", { kind, id }),
    forgetAllHindsight: () =>
      ipcRenderer.invoke("thinkpink:hindsight-forget-all"),
    syncIndexedHindsightSource: (source) =>
      ipcRenderer.invoke("thinkpink:hindsight-sync-source", source),
    recallHindsight: (query, limit) =>
      ipcRenderer.invoke("thinkpink:hindsight-recall", { query, limit }),
    generateHindsightDraft: (source, modelName) =>
      ipcRenderer.invoke("thinkpink:hindsight-generate-draft", { source, modelName }),
    cancelHindsightOperation: () =>
      ipcRenderer.invoke("thinkpink:hindsight-cancel"),
    onHindsightProgress: (listener) =>
      subscribe("thinkpink:hindsight-progress", listener),
  }),
);