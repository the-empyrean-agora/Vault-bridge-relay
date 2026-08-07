# Security

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting on this repository (**Security** tab → **Report a vulnerability**). Don't open public issues for security reports.

Supported version: latest `main`.

## Trust Model — Read Before Deploying

An honest statement of what this system does and doesn't protect:

- **A vault token is a bearer credential.** Anyone holding it has full read/write access to that vault's namespace. Treat it like a password; revoke it (via `tokens-cli`) if it may have been exposed.
- **Tokens are currently accepted as a `?token=` query parameter** as well as an `Authorization: Bearer` header. Query strings can end up in proxy and server logs — prefer the header where you control the client. Migrating the plugin and documentation fully off query-string auth is planned.
- **The deployment operator has bucket-level access to all users' vault content.** This is inherent to owning the Cloudflare account. In R2 mode there is no end-to-end encryption — vault content is stored in R2 with Cloudflare's at-rest encryption only. Do not put a vault on an instance whose operator you wouldn't trust with its contents.
- **One token per vault.** A token maps directly to a storage namespace; reusing a token across two vaults merges them. This is a data-integrity hazard rather than a confidentiality one, but it is the most common operational mistake.
- **The OAuth 2.1 layer** (used by Claude connectors) issues the vault token itself as the access token after a PKCE code exchange; revoking the token in KV immediately revokes connector access. Authorization codes are single-use with a 5-minute TTL.
- **Tenant isolation in R2 mode** rests on per-token prefixes, with R2 treating keys as opaque strings. Internal keys (`_vault-bridge-*`) are filtered from listings and refused as move targets.
