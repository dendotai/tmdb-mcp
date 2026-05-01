# tmdb-mcp

An [MCP](https://modelcontextprotocol.io) server for managing your [TMDB](https://www.themoviedb.org/) lists from Claude, Cursor, or any MCP client. Runs on Cloudflare Workers; bridges OAuth 2.1 to TMDB's v4 auth flow so your TMDB token never leaves the worker.

## Tools

| Tool | Description |
| --- | --- |
| `list_lists` | List all lists for the authenticated TMDB account |
| `get_list` | Fetch a list with its items (paginated) |
| `create_list` | Create a new list |
| `update_list` | Rename, change description, or toggle public |
| `delete_list` | Delete a list |
| `add_items` | Add movies/TV shows to a list |
| `remove_items` | Remove items from a list |
| `search_movie` | Search movies by title (returns ids usable as `media_id`) |
| `search_tv` | Search TV shows by title |

## Architecture

```text
[MCP client]  ──OAuth 2.1──  [Worker]  ──TMDB v4 auth──  [themoviedb.org]
                                │
                                ├── KV  (oauth state, opaque tokens)
                                └── Durable Object  (per-session MCP agent)
```

- The worker presents a standard OAuth 2.1 authorization server to MCP clients.
- On `/authorize`, it requests a TMDB v4 `request_token`, redirects the user to TMDB's approval page, and exchanges the approved token for a v4 `access_token` on `/callback`.
- The TMDB token is stored only in the per-session props object; clients receive an opaque bearer minted by [@cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider).
- All TMDB API calls happen server-side.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- A [TMDB account](https://www.themoviedb.org/signup) with a v4 **API Read Access Token** from [Settings → API](https://www.themoviedb.org/settings/api)
- [Bun](https://bun.sh)

## Setup

```sh
git clone https://github.com/dendotai/tmdb-mcp.git
cd tmdb-mcp
bun install
```

Create your own KV namespace and replace the `id` in `wrangler.jsonc`:

```sh
bunx wrangler kv namespace create OAUTH_KV
```

Set the TMDB application token as a Worker secret:

```sh
bunx wrangler secret put TMDB_APP_TOKEN
# paste your v4 API Read Access Token
```

Deploy:

```sh
bun run deploy
```

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in the token, then:

```sh
bun run dev
```

## Connect

Replace `https://your-worker.your-subdomain.workers.dev` below with your deployed URL.

### Claude Code

```sh
claude mcp add --transport http tmdb https://your-worker.your-subdomain.workers.dev/mcp
```

You'll be prompted to complete the OAuth flow in your browser on first use.

### Cursor

Settings → MCP → Add new MCP server, paste the URL ending in `/mcp`.

### claude.ai (web)

Settings → Connectors → Add custom connector → paste the `/mcp` URL.

### MCP Inspector

```sh
bun run inspector
```

Then point it at `https://your-worker.your-subdomain.workers.dev/mcp` (Streamable HTTP transport).

## Troubleshooting

- **Stream the live worker log:** `bun run tail`
- **`TMDB request_token failed`** — your `TMDB_APP_TOKEN` secret is missing or invalid. Reset it with `bunx wrangler secret put TMDB_APP_TOKEN`.
- **`Authorization session expired or unknown`** — the OAuth round-trip took longer than 10 minutes, or the user opened the approval link in a different browser session. Restart the connector.
- **claude.ai web won't finish the connector dance** — see the regression note above; verify the server with Claude Code or MCP Inspector.

## License

MIT — see [LICENSE](LICENSE).
