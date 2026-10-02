import { McpServer } from "@modelcontextprotocol/server";
import { registerCommunityTools } from "./application/tools.js";
import { registerEvaluateTool } from "./application/evaluate.js";
import type { JevRuntime } from "./application/ports.js";
import pkg from "../package.json" with { type: "json" };

export function createServer(runtime: JevRuntime): McpServer {
  const server = new McpServer(
    { name: "jev", version: pkg.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  registerCommunityTools(server, runtime);
  registerEvaluateTool(server, runtime);
  return server;
}
