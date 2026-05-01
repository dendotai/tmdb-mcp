import {
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Props = { tmdbToken: string; accountId: string };

export class TMDBAgent extends McpAgent<Env, {}, Props> {
  server = new McpServer({
    name: "tmdb-mcp",
    version: "0.1.0",
  });

  async init() {
    const token = () => this.props.tmdbToken;
    const accountId = () => this.props.accountId;

    const tmdbV4 = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(`https://api.themoviedb.org/4${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
      });
      const raw = await r.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!r.ok || data.success === false) {
        throw new Error(`TMDB ${r.status}: ${data.status_message ?? raw}`);
      }
      return data;
    };

    const tmdbV3 = async (path: string) => {
      const r = await fetch(`https://api.themoviedb.org/3${path}`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(`TMDB ${r.status}: ${JSON.stringify(data)}`);
      return data;
    };

    const asText = (data: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    });

    const itemSchema = z.object({
      media_type: z.enum(["movie", "tv"]),
      media_id: z.number(),
    });

    this.server.tool(
      "list_lists",
      "Get all lists for the authenticated TMDB account.",
      {},
      async () => asText(await tmdbV4(`/account/${accountId()}/lists`)),
    );

    this.server.tool(
      "get_list",
      "Get a list with its items.",
      { list_id: z.number(), page: z.number().default(1) },
      async ({ list_id, page }) =>
        asText(await tmdbV4(`/list/${list_id}?page=${page}`)),
    );

    this.server.tool(
      "create_list",
      "Create a new list.",
      {
        name: z.string(),
        description: z.string().optional().default(""),
        iso_639_1: z.string().default("en"),
        public: z.boolean().default(false),
      },
      async (args) =>
        asText(
          await tmdbV4("/list", { method: "POST", body: JSON.stringify(args) }),
        ),
    );

    this.server.tool(
      "update_list",
      "Update a list's name, description, or public flag.",
      {
        list_id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        public: z.boolean().optional(),
      },
      async ({ list_id, ...patch }) =>
        asText(
          await tmdbV4(`/list/${list_id}`, {
            method: "PUT",
            body: JSON.stringify(patch),
          }),
        ),
    );

    this.server.tool(
      "delete_list",
      "Delete a list.",
      { list_id: z.number() },
      async ({ list_id }) =>
        asText(await tmdbV4(`/list/${list_id}`, { method: "DELETE" })),
    );

    this.server.tool(
      "add_items",
      "Add items to a list.",
      { list_id: z.number(), items: z.array(itemSchema) },
      async ({ list_id, items }) =>
        asText(
          await tmdbV4(`/list/${list_id}/items`, {
            method: "POST",
            body: JSON.stringify({ items }),
          }),
        ),
    );

    this.server.tool(
      "remove_items",
      "Remove items from a list.",
      { list_id: z.number(), items: z.array(itemSchema) },
      async ({ list_id, items }) =>
        asText(
          await tmdbV4(`/list/${list_id}/items`, {
            method: "DELETE",
            body: JSON.stringify({ items }),
          }),
        ),
    );

    this.server.tool(
      "search_movie",
      "Search for movies by title. Returns id which can be used as media_id.",
      { query: z.string(), page: z.number().default(1) },
      async ({ query, page }) =>
        asText(
          await tmdbV3(
            `/search/movie?query=${encodeURIComponent(query)}&page=${page}`,
          ),
        ),
    );

    this.server.tool(
      "search_tv",
      "Search for TV shows by title. Returns id which can be used as media_id.",
      { query: z.string(), page: z.number().default(1) },
      async ({ query, page }) =>
        asText(
          await tmdbV3(
            `/search/tv?query=${encodeURIComponent(query)}&page=${page}`,
          ),
        ),
    );
  }
}

// Bridges TMDB's custom request_token/approve/access_token dance to OAuth 2.1.
// The OAuthProvider library injects env.OAUTH_PROVIDER with parseAuthRequest
// and completeAuthorization helpers.
const tmdbAuthHandler = {
  async fetch(
    req: Request,
    env: Env & { OAUTH_PROVIDER: OAuthHelpers },
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/authorize" && req.method === "GET") {
      // Capture what claude.ai is asking us to authorize
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);

      // Get a request_token from TMDB, asking it to redirect back to /callback
      // We're responsible for round-tripping the request_token ourselves;
      // TMDB doesn't append it after approval.
      const stateKey = crypto.randomUUID();
      const callback = `${url.origin}/callback?state=${stateKey}`;
      const r = await fetch("https://api.themoviedb.org/4/auth/request_token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TMDB_APP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redirect_to: callback }),
      });
      const data = (await r.json()) as {
        success: boolean;
        request_token: string;
        status_message?: string;
      };
      if (!data.success) {
        return new Response(
          `TMDB request_token failed: ${data.status_message}`,
          {
            status: 500,
          },
        );
      }

      // Stash claude.ai's auth request, keyed by request_token, for the callback to recover
      await env.OAUTH_KV.put(
        `tmdb_state:${stateKey}`,
        JSON.stringify({ oauthReqInfo, request_token: data.request_token }),
        { expirationTtl: 600 },
      );

      // Send the user to TMDB's approval page
      return Response.redirect(
        `https://www.themoviedb.org/auth/access?request_token=${data.request_token}`,
        302,
      );
    }

    if (url.pathname === "/callback" && req.method === "GET") {
      const stateKey = url.searchParams.get("state");
      if (!stateKey) {
        return new Response("Missing state", { status: 400 });
      }

      const stateRaw = await env.OAUTH_KV.get(`tmdb_state:${stateKey}`);
      if (!stateRaw) {
        return new Response("Authorization session expired or unknown", {
          status: 400,
        });
      }
      const { oauthReqInfo, request_token: requestToken } =
        JSON.parse(stateRaw);
      await env.OAUTH_KV.delete(`tmdb_state:${stateKey}`);

      // Exchange request_token for the user's v4 access_token
      const r = await fetch("https://api.themoviedb.org/4/auth/access_token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TMDB_APP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ request_token: requestToken }),
      });
      const data = (await r.json()) as {
        success: boolean;
        access_token: string;
        account_id: string;
        status_message?: string;
      };
      if (!data.success) {
        return new Response(
          `TMDB access_token failed: ${data.status_message}`,
          {
            status: 500,
          },
        );
      }

      // Tell the OAuth provider to issue our own bearer to claude.ai,
      // bound to these props (the actual TMDB token never leaves the Worker)
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: data.account_id,
        metadata: { label: `TMDB ${data.account_id}` },
        scope: oauthReqInfo.scope,
        props: {
          tmdbToken: data.access_token,
          accountId: data.account_id,
        } satisfies Props,
      });

      return Response.redirect(redirectTo, 302);
    }

    // Friendly landing page if someone hits the root
    if (url.pathname === "/") {
      return new Response(
        "TMDB MCP Server. Add this URL to your MCP client to connect.",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiHandler: TMDBAgent.serve("/mcp") as any,
  apiRoute: "/mcp",
  defaultHandler: tmdbAuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
