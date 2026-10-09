type DocumentSummary = {
  documentId: string;
  source: string;
  namespace: string;
  chunks: number;
  pageCount?: number;
  preview: string;
};
type DocumentList = {
  namespace: string;
  documents: DocumentSummary[];
  totalDocuments: number;
  totalChunks: number;
  nextCursor: string | null;
};
type Chunk = {
  id: string;
  source: string;
  text: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  page?: number;
  embeddingModel: string;
  metadata: Record<string, unknown>;
};
type ChunkList = { chunks: Chunk[]; total: number; nextAfter: number | null };
type SearchHit = Chunk & { score: number; citation: string };
type SearchResult = {
  matches: SearchHit[];
  context: string;
  namespace: string;
  truncated: boolean;
};
type ImportResult = {
  chunks: number;
  pageCount?: number;
  emptyPages?: number[];
};
type QueueEntry = {
  file: File;
  state: "queued" | "running" | "done" | "error";
  message: string;
  valid: boolean;
};
type View = "library" | "import" | "search";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}
function notice(target: HTMLElement, message: string, tone = "info") {
  target.textContent = message;
  target.dataset.tone = tone;
  target.hidden = !message;
}
const namespaceInput = element<HTMLInputElement>("namespace");
const searchButton = element<HTMLButtonElement>("search-button");
const importButton = element<HTMLButtonElement>("import-button");
const fileInput = element<HTMLInputElement>("file-input");
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const documentDialog = element<HTMLDialogElement>("document-dialog");
const refreshButton = element<HTMLButtonElement>("refresh-button");
const globalNotice = element("global-notice");
let activeNamespace = "default";
let apiKey = "";
let busy: "import" | "search" | null = null;
let queue: QueueEntry[] = [];
let libraryVersion = 0;
let libraryPage = 0;
let cursors: (string | undefined)[] = [undefined];
let nextCursor: string | null = null;
let detailVersion = 0;
let selectedDocument: DocumentSummary | null = null;
let nextAfter: number | null = null;
let searchContext = "";
let contextTruncated = false;
let checkingHealth = false;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function showSettings() {
  if (!settingsDialog.open) settingsDialog.showModal();
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("无法连接后台，请确认本地服务已启动后重试。");
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    let message = "操作失败，请稍后重试。";
    const error =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "";
    if (response.status === 401) {
      message = "需要正确的访问密钥，请在连接设置中填写。";
      showSettings();
    } else if (response.status === 413)
      message = "文件或请求正文过大，请缩小文件后重试。";
    else if (response.status === 400)
      message = /[\u3400-\u9fff]/u.test(error)
        ? error
        : "请求内容不符合要求，请检查文件、知识库名称或输入内容。";
    else if (response.status === 502)
      message = "知识库服务暂不可用，请确认 Qdrant 和 Embedding 服务已启动。";
    throw new ApiError(response.status, message);
  }
  return data as T;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";
const params = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();
const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
const extension = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";
const fileName = (source: string) => source.split(/[\\/]/).at(-1) || source;

function setView(view: View) {
  const headings: Record<View, [string, string]> = {
    library: ["已存资料", "看看知识库里有什么，以及它们如何被保存。"],
    import: ["导入文件", "把你的资料保存为可检索的知识。"],
    search: ["检索资料", "用自然语言提问，找到知识库里的相关原文。"],
  };
  for (const key of ["library", "import", "search"] as const)
    element(`view-${key}`).hidden = key !== view;
  document
    .querySelectorAll<HTMLButtonElement>(".nav-item")
    .forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  element("page-title").textContent = headings[view][0];
  element("breadcrumb-current").textContent = headings[view][0];
  element("page-subtitle").textContent = headings[view][1];
  document.title = `${headings[view][0]} · CiteDock`;
}
document
  .querySelectorAll<HTMLButtonElement>("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      setView(button.dataset.view as View),
    ),
  );

function setBusy(value: typeof busy) {
  busy = value;
  namespaceInput.disabled = !!value;
  element<HTMLFormElement>("namespace-form").querySelector<HTMLButtonElement>(
    "button",
  )!.disabled = !!value;
  fileInput.disabled = !!value;
  element("dropzone").classList.toggle("busy", !!value);
  searchButton.disabled = !!value;
  element<HTMLTextAreaElement>("query").disabled = !!value;
  element<HTMLSelectElement>("top-k").disabled = !!value;
  searchButton.textContent = value === "search" ? "正在检索…" : "检索资料 ↗";
  renderQueue();
}
function renderQueue() {
  const list = element("import-list");
  list.replaceChildren();
  const labels = {
    queued: "待导入",
    running: "导入中",
    done: "已保存",
    error: "失败",
  };
  for (const entry of queue) {
    const row = node("li", "import-row");
    const icon = node(
      "span",
      `file-icon ${extension(entry.file.name) === "pdf" ? "pdf" : ""}`,
      extension(entry.file.name).slice(0, 4).toUpperCase() || "FILE",
    );
    const info = node("div", "import-file");
    info.append(
      node("strong", "", entry.file.name),
      node("p", "", entry.message || sizeLabel(entry.file.size)),
    );
    const status = node("span", "file-status", labels[entry.state]);
    status.dataset.state = entry.state;
    const remove = node("button", "remove-file", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除 ${entry.file.name}`);
    remove.disabled = !!busy;
    remove.addEventListener("click", () => {
      queue = queue.filter((item) => item !== entry);
      renderQueue();
    });
    row.append(icon, info, status, remove);
    list.append(row);
  }
  const pending = queue.filter(
    (entry) => entry.valid && entry.state !== "done",
  ).length;
  element("selection-label").textContent = queue.length
    ? `${queue.length} 个文件 · ${pending} 个待导入`
    : "尚未选择文件";
  importButton.disabled = !!busy || !pending;
  importButton.textContent =
    busy === "import"
      ? "正在导入…"
      : queue.some((entry) => entry.valid && entry.state === "error")
        ? "重试未成功的文件"
        : "开始导入";
}
function addFiles(files: File[]) {
  if (busy) return;
  for (const file of files) {
    const ext = extension(file.name);
    let error = "";
    if (!["pdf", "md", "markdown", "txt"].includes(ext))
      error = "仅支持 PDF、Markdown 和 TXT 文件。";
    else if (!file.size) error = "文件为空，请选择有正文的文件。";
    else if (file.size > (ext === "pdf" ? 32 : 8) * 1024 * 1024)
      error = `文件超过 ${ext === "pdf" ? 32 : 8} MiB 上限。`;
    const existing = queue.findIndex((entry) => entry.file.name === file.name);
    const entry: QueueEntry = {
      file,
      state: error ? "error" : "queued",
      message: error,
      valid: !error,
    };
    if (existing >= 0) queue[existing] = entry;
    else queue.push(entry);
  }
  notice(element("import-status"), "");
  renderQueue();
}
fileInput.addEventListener("change", () => {
  addFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});
const dropzone = element("dropzone");
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!busy) dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("dragging"),
);
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  addFiles(Array.from(event.dataTransfer?.files ?? []));
});
// Dropping outside the target should not navigate away from the management page.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

importButton.addEventListener("click", () => {
  void importFiles();
});
async function importFiles() {
  if (busy) return;
  const pending = queue.filter(
    (entry) => entry.valid && entry.state !== "done",
  );
  if (!pending.length) return;
  setBusy("import");
  const namespace = activeNamespace;
  let saved = 0;
  notice(
    element("import-status"),
    `正在导入到「${namespace}」。文件较大时需要等待，请保持页面打开。`,
  );
  try {
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index]!;
      entry.state = "running";
      entry.message = `正在处理第 ${index + 1} / ${pending.length} 个文件…`;
      renderQueue();
      try {
        let result: ImportResult;
        if (extension(entry.file.name) === "pdf") {
          result = await request<ImportResult>(
            `/v1/documents/pdf?${params({ namespace, source: entry.file.name })}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/pdf" },
              body: entry.file,
            },
          );
        } else {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              await entry.file.arrayBuffer(),
            );
          } catch {
            throw new Error("无法读取为 UTF-8 文本，请转换文件编码后再导入。");
          }
          if (!text.trim()) throw new Error("文件没有可导入的正文。");
          if (text.length > 2_000_000)
            throw new Error("正文超过 2,000,000 字符上限，请拆分后导入。");
          const body = JSON.stringify({
            namespace,
            source: entry.file.name,
            text,
          });
          if (new TextEncoder().encode(body).byteLength > 8 * 1024 * 1024)
            throw new Error("文本请求超过 8 MiB，请拆分后导入。");
          result = await request<ImportResult>("/v1/documents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
        }
        entry.state = "done";
        entry.message = `已保存 ${result.chunks} 个分块${result.pageCount ? ` · ${result.pageCount} 页${result.emptyPages?.length ? `（跳过 ${result.emptyPages.length} 个空白页）` : ""}` : ""}`;
        saved++;
      } catch (error) {
        entry.state = "error";
        entry.message = messageOf(error);
        if (error instanceof ApiError && error.status === 401) {
          for (const rest of pending.slice(index + 1)) {
            rest.state = "queued";
            rest.message = "等待填写访问密钥后导入。";
          }
          break;
        }
      }
      renderQueue();
    }
    const failures = pending.filter((entry) => entry.state !== "done").length;
    notice(
      element("import-status"),
      failures
        ? `${saved} 个文件导入成功，${failures} 个未完成。请查看文件旁的原因，修正后可重试。`
        : `${saved} 个文件已保存到「${namespace}」。可以在已存资料中查看，或开始检索。`,
      failures ? "error" : "success",
    );
  } finally {
    setBusy(null);
  }
  if (saved) {
    await loadLibrary(true);
    await loadNamespaces();
  }
}

async function loadNamespaces() {
  try {
    const result = await request<{
      namespaces: { namespace: string; chunks: number }[];
      truncated: boolean;
    }>("/v1/namespaces");
    const names = new Set([
      "default",
      activeNamespace,
      ...result.namespaces.map((item) => item.namespace),
    ]);
    element("namespace-options").replaceChildren(
      ...Array.from(names).map((name) => {
        const option = node("option");
        option.value = name;
        return option;
      }),
    );
    element("namespace-hint").textContent = result.truncated
      ? "显示前 1000 个知识库，也可直接输入名称"
      : "可选择已有知识库，或输入新名称";
  } catch (error) {
    notice(globalNotice, messageOf(error), "error");
  }
}
async function loadLibrary(reset = false) {
  if (reset) {
    libraryPage = 0;
    cursors = [undefined];
  }
  const version = ++libraryVersion;
  const namespace = activeNamespace;
  const status = element("library-status");
  const list = element("document-list");
  list.replaceChildren();
  status.textContent = "正在读取数据库…";
  status.hidden = false;
  element("document-pagination").hidden = true;
  refreshButton.disabled = true;
  const values: Record<string, string> = { namespace, limit: "20" };
  const cursor = cursors[libraryPage];
  if (cursor) values.cursor = cursor;
  try {
    const result = await request<DocumentList>(
      `/v1/documents?${params(values)}`,
    );
    if (version !== libraryVersion) return;
    element("document-count").textContent = String(result.totalDocuments);
    element("chunk-count").textContent = String(result.totalChunks);
    nextCursor = result.nextCursor;
    status.hidden = !!result.documents.length;
    status.replaceChildren(
      node("span", "empty-symbol", "▤"),
      node(
        "strong",
        "",
        result.totalDocuments ? "这一页没有资料" : "知识库还是空的",
      ),
      node(
        "span",
        "",
        result.totalDocuments
          ? "请刷新文件列表。"
          : "点击「导入文件」，添加你的第一份资料。",
      ),
    );
    for (const entry of result.documents) {
      const row = node("button", "document-row");
      row.type = "button";
      row.title = entry.source;
      row.setAttribute(
        "aria-label",
        `查看 ${entry.source} 的 ${entry.chunks} 个分块`,
      );
      const ext = extension(entry.source);
      const icon = node(
        "span",
        `file-icon ${entry.pageCount ? "pdf" : ""}`,
        entry.pageCount
          ? "PDF"
          : ["md", "markdown"].includes(ext)
            ? "MD"
            : "TXT",
      );
      const copy = node("div", "file-copy");
      copy.append(
        node("h3", "file-title", fileName(entry.source)),
        node("p", "file-preview", entry.preview),
      );
      const meta = node("div", "file-meta");
      meta.append(
        node("span", "", `${entry.chunks} 个分块`),
        node(
          "small",
          "",
          entry.pageCount ? `${entry.pageCount} 页 PDF` : "文本资料",
        ),
      );
      row.append(icon, copy, meta, node("span", "row-arrow", "›"));
      row.addEventListener("click", () => openDocument(entry));
      list.append(row);
    }
    element("document-pagination").hidden = libraryPage === 0 && !nextCursor;
    element("document-page-label").textContent =
      `第 ${libraryPage + 1} 页 · 共 ${result.totalDocuments} 个文件`;
    element<HTMLButtonElement>("documents-prev").disabled = libraryPage === 0;
    element<HTMLButtonElement>("documents-next").disabled = !nextCursor;
  } catch (error) {
    if (version !== libraryVersion) return;
    status.textContent = messageOf(error);
    element("document-count").textContent = "—";
    element("chunk-count").textContent = "—";
  } finally {
    if (version === libraryVersion) refreshButton.disabled = false;
  }
}
refreshButton.addEventListener("click", () => {
  notice(globalNotice, "");
  void loadLibrary(true);
  void loadNamespaces();
});
element("documents-prev").addEventListener("click", () => {
  if (libraryPage > 0) {
    libraryPage--;
    void loadLibrary();
  }
});
element("documents-next").addEventListener("click", () => {
  if (nextCursor) {
    cursors[++libraryPage] = nextCursor;
    void loadLibrary();
  }
});
element<HTMLFormElement>("namespace-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    if (busy) return;
    const value = namespaceInput.value.trim();
    if (!value || value.length > 128) {
      notice(globalNotice, "知识库名称需要 1–128 个字符。", "error");
      return;
    }
    if (value === activeNamespace) return;
    activeNamespace = value;
    namespaceInput.value = value;
    queue = [];
    renderQueue();
    documentDialog.close();
    resetSearch();
    notice(
      globalNotice,
      `已切换到「${value}」。导入、浏览和检索都会使用这个知识库。`,
    );
    notice(element("import-status"), "");
    void loadLibrary(true);
    void loadNamespaces();
  },
);

function chunkCard(
  chunk: Chunk,
  citation: string,
  score?: number,
): HTMLElement {
  const card = node("article", "chunk-card");
  const heading = node("div", "chunk-heading");
  const source = node("div", "chunk-source");
  source.title = chunk.source;
  source.append(
    node("span", "citation", citation),
    document.createTextNode(fileName(chunk.source)),
  );
  heading.append(source);
  if (score !== undefined)
    heading.append(node("span", "chunk-score", `相关度 ${score.toFixed(3)}`));
  const location = `${chunk.page ? `第 ${chunk.page} 页 · ` : ""}第 ${chunk.startLine}–${chunk.endLine} 行`;
  card.append(
    heading,
    node("div", "chunk-location", location),
    node("pre", "chunk-text", chunk.text),
  );
  return card;
}
function openDocument(entry: DocumentSummary) {
  selectedDocument = entry;
  detailVersion++;
  nextAfter = 0;
  element("detail-title").textContent = fileName(entry.source);
  element("detail-title").title = entry.source;
  element("detail-summary").textContent =
    `${entry.chunks} 个分块${entry.pageCount ? ` · ${entry.pageCount} 页 PDF` : ""} · 知识库 ${entry.namespace}`;
  element("detail-chunks").replaceChildren();
  if (!documentDialog.open) documentDialog.showModal();
  void loadChunks();
}
async function loadChunks() {
  if (!selectedDocument || nextAfter === null) return;
  const entry = selectedDocument;
  const version = detailVersion;
  const more = element<HTMLButtonElement>("chunks-more");
  more.disabled = true;
  notice(element("detail-status"), "正在读取已保存的分块…");
  try {
    const result = await request<ChunkList>(
      `/v1/documents/${entry.documentId}/chunks?${params({ namespace: entry.namespace, limit: "20", after: String(nextAfter) })}`,
    );
    if (version !== detailVersion || !documentDialog.open) return;
    for (const chunk of result.chunks) {
      const card = chunkCard(chunk, `#${chunk.chunkIndex + 1}`);
      const details = node("details", "chunk-metadata");
      details.append(
        node("summary", "", "存储信息"),
        node("div", "", `来源：${chunk.source}`),
        node("div", "", `分块 ID：${chunk.id}`),
        node("div", "", `Embedding：${chunk.embeddingModel}`),
        node("div", "", `Metadata：${JSON.stringify(chunk.metadata)}`),
      );
      card.append(details);
      element("detail-chunks").append(card);
    }
    nextAfter = result.nextAfter;
    element("detail-summary").textContent =
      `${result.total} 个分块${entry.pageCount ? ` · ${entry.pageCount} 页 PDF` : ""} · 知识库 ${entry.namespace}`;
    notice(
      element("detail-status"),
      result.total ? "" : "文件已不存在，或当前知识库中没有这份资料。",
    );
    more.hidden = nextAfter === null;
    more.textContent = "加载更多分块";
  } catch (error) {
    if (version !== detailVersion) return;
    notice(element("detail-status"), messageOf(error), "error");
    more.hidden = false;
    more.textContent = "重试加载";
  } finally {
    if (version === detailVersion) more.disabled = false;
  }
}
element("close-document").addEventListener("click", () =>
  documentDialog.close(),
);
documentDialog.addEventListener("close", () => {
  detailVersion++;
  selectedDocument = null;
});
element("chunks-more").addEventListener("click", () => {
  void loadChunks();
});

function resetSearch() {
  searchContext = "";
  contextTruncated = false;
  element("search-results").replaceChildren();
  element("copy-context").hidden = true;
  element("search-summary").textContent =
    "结果将展示相关原文、文件来源和位置。";
  const status = element("search-status");
  status.hidden = false;
  status.replaceChildren(
    node("span", "empty-symbol", "⌕"),
    node("strong", "", "从一个问题开始"),
    node("span", "", "导入资料后，在上方输入你想查找的内容。"),
  );
}
element<HTMLFormElement>("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void search();
});
async function search() {
  if (busy) return;
  const query = element<HTMLTextAreaElement>("query").value.trim();
  if (!query) {
    element<HTMLTextAreaElement>("query").focus();
    return;
  }
  const topK = Number(element<HTMLSelectElement>("top-k").value);
  const namespace = activeNamespace;
  setBusy("search");
  const status = element("search-status");
  status.hidden = false;
  status.textContent = "正在从知识库中查找相关原文…";
  element("search-results").replaceChildren();
  element("copy-context").hidden = true;
  searchContext = "";
  element("search-summary").textContent = `正在检索「${namespace}」…`;
  const start = performance.now();
  try {
    const result = await request<SearchResult>("/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, namespace, topK }),
    });
    status.hidden = result.matches.length > 0;
    status.replaceChildren(
      node("span", "empty-symbol", "⌕"),
      node("strong", "", "没有找到相关资料"),
      node(
        "span",
        "",
        "确认已导入文件、选择了正确知识库，或换一种说法再检索。",
      ),
    );
    for (const match of result.matches)
      element("search-results").append(
        chunkCard(match, match.citation, match.score),
      );
    searchContext = result.context;
    contextTruncated = result.truncated;
    element("copy-context").hidden = !result.matches.length;
    element("search-summary").textContent =
      `「${result.namespace}」中找到 ${result.matches.length} 个片段 · ${((performance.now() - start) / 1000).toFixed(1)} 秒`;
  } catch (error) {
    status.textContent = messageOf(error);
    element("search-summary").textContent = "检索未完成，请重试。";
  } finally {
    setBusy(null);
  }
}
element("copy-context").addEventListener("click", () => {
  void (async () => {
    try {
      await navigator.clipboard.writeText(searchContext);
      notice(
        globalNotice,
        contextTruncated
          ? "已复制引用文本。内容较长，复制的上下文已截短；页面中的原文片段仍完整保留。"
          : "已复制带来源和引用编号的检索文本。",
        "success",
      );
    } catch {
      notice(globalNotice, "浏览器未允许复制，请手动选择结果文本。", "error");
    }
  })();
});

async function checkHealth() {
  if (checkingHealth) return;
  checkingHealth = true;
  const button = element<HTMLButtonElement>("health-button");
  button.dataset.state = "checking";
  button.disabled = true;
  element("health-label").textContent = "正在检查服务";
  try {
    await request("/readyz");
    button.dataset.state = "ready";
    element("health-label").textContent = "服务已就绪";
    button.title = "Qdrant 和 Embedding 服务可用，点击重新检查";
  } catch (error) {
    button.dataset.state = "error";
    element("health-label").textContent = "服务未就绪 · 点击重试";
    button.title = messageOf(error);
  } finally {
    checkingHealth = false;
    button.disabled = false;
  }
}
element("health-button").addEventListener("click", () => {
  void checkHealth();
});
element("settings-button").addEventListener("click", showSettings);
element("mobile-settings-button").addEventListener("click", showSettings);
element("close-settings").addEventListener("click", () =>
  settingsDialog.close(),
);
element<HTMLFormElement>("settings-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    apiKey = element<HTMLInputElement>("api-key").value.trim();
    element<HTMLInputElement>("api-key").value = "";
    settingsDialog.close();
    notice(globalNotice, "");
    void loadLibrary(true);
    void loadNamespaces();
    void checkHealth();
  },
);
void loadLibrary();
void loadNamespaces();
void checkHealth();
