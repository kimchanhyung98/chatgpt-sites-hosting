import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await rm("dist", { recursive: true, force: true });
await mkdir("dist/.openai", { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["src/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "browser"],
  sourcemap: false,
  legalComments: "eof",
});
await cp(".openai/hosting.json", "dist/.openai/hosting.json");
