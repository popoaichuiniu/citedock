# 知识库检索工具

本项目使用 TypeScript 实现 RAG，Qdrant 存储向量，Apple MLX 在本机运行 Qwen3 Embedding。
默认使用 Qwen3-Embedding-8B 的社区 4-bit MLX 转换版，生成 4096 维向量。Qdrant 使用 Cosine 相似度检索。

## 文档导入

支持 UTF-8 的 Markdown、TXT 文件和带文字层的 PDF。文档按段落或句子边界分块，默认每块最多 1200 个 Unicode 字符，重叠 150 个字符。
PDF 最大 32 MiB，按页提取正文和分块，检索结果保留原始页码。无文字层的扫描件提示“暂不支持扫描件 PDF”，不进行 OCR。
同一个 namespace 下，相同 source 再次导入会更新已有文档，并清理多余的旧分块。

## 大模型调用

MCP 提供 rag_search 检索工具，以及 rag_list_documents、rag_get_document、rag_add_document、rag_update_document、rag_delete_document 文档管理工具。检索结果包含正文、source、行号、相似度分数和引用编号。
大模型应该根据检索到的证据回答，并引用来源；如果没有相关证据，应说明知识库未找到答案。
新增、更新和删除需要明确 namespace 与 source。更新提交完整新正文，重新分块和生成向量；删除只清理指定文档的分块。用户要求修改资料时才使用写工具。
HTTP 接口提供 POST /v1/search；Function Calling 定义可通过 GET /v1/tools 获取，通过 POST /v1/tools/call 执行。
