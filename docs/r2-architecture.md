# Vault Bridge R2 — Architecture Document

See the full spec in the Obsidian vault at `vault-bridge/r2-architecture.md`.

This document is the build spec for the R2-backed vault bridge — an always-available MCP server 
that stores vault content in Cloudflare R2. The Obsidian plugin syncs local vault to R2. 
The Worker reads/writes R2 directly. Machine on or off, Claude always has access.

## Quick Reference

- **R2 bucket:** `vault-bridge`
- **Storage layout:** `{userPrefix}/{filepath}` (e.g. `stacey/notes/todo.md`)
- **Search index:** `{userPrefix}/_search-index.json` — built by plugin, read by Worker
- **Manifest:** `{userPrefix}/_vault-bridge-manifest.json` — sync state
- **MCP tools:** same 4 as relay (list_directory, read_file, write_file, search_files)
- **Sync API:** REST endpoints at `/sync/*` for plugin communication

## Build Order
1. R2 bucket + KV namespace for tokens
2. Worker: MCP endpoint reading/writing R2
3. Worker: sync REST API  
4. Worker: search using index
5. Test with manually uploaded files
6. Deploy
7. Then: Obsidian plugin (Phase 2)

Read the full vault doc for complete spec including sync protocol, 
index structure, conflict resolution, and plugin design.
