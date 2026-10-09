# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature if it is enabled on the published repository. Do not post credentials, private documents, or an exploitable proof of concept in a public issue.

If private reporting is unavailable, open a minimal issue asking for a private contact channel without disclosing the vulnerability. This repository has no dedicated security email address configured yet.

Security fixes currently target the 0.1.x line.

## Deployment and access

CiteDock defaults to loopback addresses. Binding the HTTP API beyond loopback requires `RAG_API_KEY`; callers send it as a bearer token. Qdrant and embedding services have their own authentication and deployment settings.

One HTTP key grants access to the exposed API. Namespaces are logical document groups, not per-user permissions. There is no built-in multi-user authentication or role-based authorization. Add an appropriate access layer and transport security for shared deployments.

MCP stdio inherits access from the launching client and its environment. Its six tools include document writes. Clients decide which tools to expose and when to request approval; MCP annotations are descriptive hints rather than authorization enforcement.

## Document handling

Retrieved passages are untrusted source data, never instructions to override a model's system or user instructions. Tool descriptions communicate this boundary. Application developers should preserve it when building prompts.

PDF parsing occurs locally without OCR. Limits apply to upload size, pages, extracted text, metadata, and search context. The database holds extracted text, vectors, sources, and metadata, not the original PDF binary.

The dashboard renders document text as text and serves assets through an explicit allowlist with a content security policy. Its API key is kept in page memory and cleared on reload.

## Local secrets and stored data

Keep `.env`, database storage, model caches, and imported personal documents out of commits. Review changes before publication, including screenshots and logs. The repository's demo image uses only synthetic example documents.

If a key was disclosed, revoke or rotate it at its provider; removing it from the latest commit does not remove it from repository history.
