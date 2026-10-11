<p align="center"><img src="web/citedock.svg" width="80" height="80" alt="CiteDock 标志"></p>

# CiteDock

**让 AI Agent 检索、引用和维护你的本地知识库。**

[English](README.md) · [完整使用指南](docs/guide.zh-CN.md) · [工具接口](docs/tools.md) · [基准记录](docs/benchmarks.md)

把 PDF、Markdown 和笔记导入 Qdrant，让大模型通过 MCP 查询原文、读取文档、增删改资料。配套网页后台可以上传文件、浏览数据库中的文档和分块、检索知识库。

技术栈：**TypeScript + Qdrant + Qwen3 Embedding**。Apple Silicon 默认使用 MLX 运行 Qwen3 8B 的 4-bit 版本，也支持 Ollama 和 OpenAI 兼容的 Embedding 服务。

![CiteDock 后台展示演示资料](docs/assets/dashboard.png)

## 能做什么

- **给 Agent 接上知识库**：六个 MCP 工具覆盖检索、列表、读取、新增、更新和删除。
- **回答可以追溯**：返回原文、来源、引用编号、行号和 PDF 原始页码。
- **资料看得见**：网页选择文件导入，浏览实际保存的文档和分块。
- **检索可以完全本地运行**：默认方案不依赖云端模型 API。
- **接入方式灵活**：MCP stdio、HTTP Function Calling、TypeScript SDK 和 CLI 共用同一套逻辑。

工具返回证据，由调用它的大模型组织答案。网页检索直接展示原文片段。

<details>
<summary>查看 PDF 页码和检索结果演示</summary>

![PDF 原始页码与正文分块](docs/assets/pdf-citations.png)

![检索结果展示原文、来源和引用](docs/assets/search.png)

</details>

## 快速启动：Apple Silicon

需要 **Node.js 22.13+、npm、Python 3.11+、macOS 26+**。首次启动 MLX 会下载约 **4.26 GB** 模型权重；本机测试环境为 Apple M5、24 GiB 内存。

克隆仓库并安装依赖：

```bash
git clone https://github.com/popoaichuiniu/citedock.git
cd citedock
npm ci
cp .env.example .env
npm run build
```

分别打开三个终端：

```bash
# 终端 1：启动 Qdrant，数据保存到 storage/qdrant
npm run qdrant

# 终端 2：启动 Embedding，等待 MLX embeddings ready
npm run mlx

# 终端 3：启动网页与 HTTP API
npm start
```

打开 **[http://127.0.0.1:3000](http://127.0.0.1:3000)**：

1. **导入文件**：选择或拖入 PDF、Markdown、TXT，点击开始导入。
2. **已存资料**：查看文档数量、分块数量，点击文档浏览正文、行号和 PDF 页码。
3. **检索资料**：输入自然语言问题，查看相似片段并复制带引用的上下文。

“当前知识库”默认是 `default`。导入和检索使用同一个知识库名称；网页用文件名作为 `source`，相同知识库、相同文件名重新导入会更新已有资料。

也可以试一下仓库自带示例：

```bash
npm run rag -- ingest examples/knowledge.md
npm run rag -- search "PDF 如何保留页码？"
```

其他平台可以用 `docker compose up -d` 启动 Qdrant，并按[配置说明](docs/configuration.md)切换到 Ollama 或 OpenAI 兼容的 Embedding 服务。

## 大模型怎么调用

构建项目，保持 Qdrant 和 Embedding 服务运行，在支持 MCP stdio 的客户端添加：

```json
{
  "mcpServers": {
    "citedock": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/citedock/dist/mcp.js"]
    }
  }
}
```

把路径替换为仓库的绝对路径；桌面客户端可能需要 Node 的绝对路径。MCP 会读取项目根目录的 `.env`，无需额外启动网页。

| 工具                  | 作用                      |
| --------------------- | ------------------------- |
| `rag_search`          | 检索相关原文与引用        |
| `rag_list_documents`  | 分页列出文档和准确 source |
| `rag_get_document`    | 分页读取正文分块          |
| `rag_add_document`    | 新增文本，已存在时失败    |
| `rag_update_document` | 用完整新正文替换已有文档  |
| `rag_delete_document` | 删除指定文档的全部分块    |

可以告诉 Agent：“查询知识库里的部署要求，给出原文引用。”或者“把这些会议记录保存为 default 知识库中的 meeting-notes.md”。

写工具必须显式指定 `namespace` 和 `source`；更新需要完整正文，省略 metadata 会清空旧 metadata。分页读取要跟随 `nextAfter`，一页分块不代表整份文档。详见[工具接口](docs/tools.md)。

HTTP 定义在 `GET /v1/tools`，执行在 `POST /v1/tools/call`。SDK 导出 `ragTools` 和 `executeTool`，可参考 [Function Calling 示例](examples/function-calling.ts)。当前 MCP 传输方式为 stdio。

## 模型与边界

默认使用固定 revision 的 `mlx-community/Qwen3-Embedding-8B-4bit-DWQ`，输出 4096 维向量。切换模型、提供方或维度时，必须使用新 Qdrant collection 并重新导入资料。

我们完成了中文 STSB 测试集和 BEIR SciFact 的 4-bit / 原始 BF16 对比，两组数据上的指标接近。测试范围、耗时和置信区间见[基准记录](docs/benchmarks.md)，不将它等同于完整 MTEB 排行榜。

项目处于早期 **0.1.0**。只支持带文字层的 PDF；扫描件提示不支持，不做 OCR。更新是整份文本替换；同一进程内按文档串行写入，多个进程的并发写入需要调用方协调。原始 PDF 不保存到数据库。

## 更多资料

- [完整中文使用指南](docs/guide.zh-CN.md)
- [配置与排错](docs/configuration.md)
- [工具、HTTP 与 SDK 接口](docs/tools.md)
- [源码结构与开发](docs/development.md)
- [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [更新记录](CHANGELOG.md)
- [MIT 许可证](LICENSE)

如果这个工具对你有帮助，欢迎点 Star，也欢迎提交问题、评测和改进。模型权重及第三方依赖遵循各自的许可证。
