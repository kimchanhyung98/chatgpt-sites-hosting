import { createMcpHandler, isJSONRPCRequest, readRequestBody } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { createTypeSafeEvaluator } from "./infrastructure/typesafe.js";
import { createRegexRunner } from "./infrastructure/re2-regex.js";

export interface Env {
  TYPESAFE_API_KEY?: string;
  JEV_MCP_MODEL?: string;
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function validJsonTree(value: unknown): boolean {
  const queue = [{ value, depth: 0 }];
  while (queue.length) {
    const entry = queue.pop()!;
    if (entry.depth > 64) return false;
    if (typeof entry.value !== "object" || entry.value === null) continue;
    for (const [key, child] of Object.entries(entry.value)) {
      if (key === "__proto__") return false;
      queue.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return Response.json(
        { name: "jev", status: "ok", configured: Boolean(env.TYPESAFE_API_KEY?.trim()) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname !== "/mcp") return errorResponse(404, "Not found");
    // Sites' dispatcher sets this identity after authenticating the visitor.
    if (!request.headers.get("oai-authenticated-user-id")?.trim()) {
      return errorResponse(401, "Authentication required");
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return errorResponse(403, "Origin not allowed");
    if (!env.TYPESAFE_API_KEY?.trim()) return errorResponse(503, "TypeSafe API key is not configured");
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    }
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return errorResponse(415, "Content-Type must be application/json");
    }

    let bodyText: string;
    let parsedBody: unknown;
    try {
      const body = await readRequestBody(request, MAX_REQUEST_BYTES);
      if (body.tooLarge) return errorResponse(413, "Request body is too large");
      bodyText = body.text;
      parsedBody = JSON.parse(bodyText);
      if (!validJsonTree(parsedBody)) return errorResponse(400, "Unsupported JSON key or nesting depth");
    } catch {
      return errorResponse(400, "Invalid JSON request");
    }

    // Sites may omit routing headers; keep any supplied values for SDK cross-checks.
    const requestHeaders = new Headers(request.headers);
    if (isJSONRPCRequest(parsedBody) && ["server/discover", "tools/list", "tools/call"].includes(parsedBody.method)) {
      if (!requestHeaders.has("Mcp-Method")) requestHeaders.set("Mcp-Method", parsedBody.method);
      const name = parsedBody.params?.name;
      if (parsedBody.method === "tools/call" && typeof name === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(name)) {
        if (!requestHeaders.has("Mcp-Name")) requestHeaders.set("Mcp-Name", name);
      }
    }

    const handler = createMcpHandler(() => createServer({
      model: env.JEV_MCP_MODEL?.trim() || "jev-latest",
      ask: createTypeSafeEvaluator({ apiKey: env.TYPESAFE_API_KEY! }),
      runRegex: createRegexRunner(),
    }), {
      maxRequestBodySize: MAX_REQUEST_BYTES,
      maxSubscriptions: 0,
      keepAliveMs: 0,
    });
    const response = await handler.fetch(new Request(request, { headers: requestHeaders, body: bodyText }), { parsedBody });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
};
