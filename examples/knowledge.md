# 知识库检索工具

本项目使用 TypeScript 实现 RAG，Qdrant 存储向量，Apple MLX 在本机运行 Qwen3 Embedding。
默认使用 Qwen3-Embedding-8B 的社区 4-bit MLX 转换版，生成 4096 维向量。Qdrant 使用 Cosine 相似度检索。

## 文档导入

支持 UTF-8 的 Markdown 和 TXT 文件。文档按段落或句子边界分块，默认每块最多 1200 个 Unicode 字符，重叠 150 个字符。
同一个 namespace 下，相同 source 再次导入会更新已有文档，并清理多余的旧分块。

## 大模型调用

MCP 提供只读工具 rag_search。检索结果包含正文、source、行号、相似度分数和引用编号。
大模型应该根据检索到的证据回答，并引用来源；如果没有相关证据，应说明知识库未找到答案。
HTTP 接口提供 POST /v1/search；Function Calling 定义可通过 GET /v1/tools 获取。
