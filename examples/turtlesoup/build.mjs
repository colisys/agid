// Build the turtlesoup pack: TS sources in src/ -> artifacts the gateway
// serves straight from disk (rules.js, brains/host.js). Committed, so a plain
// checkout needs no node at all; node is only a build-time tool.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const entries = [
  ["src/rules.ts", "rules.js", {}],
  ["src/brains/host.ts", "brains/host.js", {}],
];

await mkdir("brains", { recursive: true });

for (const [inFile, outFile, extra] of entries) {
  await build({
    entryPoints: [inFile],
    outfile: outFile,
    bundle: true,
    format: "iife",
    target: ["es2020"],
    minify: false,
    charset: "utf8",
    // quickjs-go finds entries via ctx.Globals().Get(entry); the sources end
    // with explicit globalThis assignments, which the IIFE wrapper preserves.
    banner: {
      js: `// GENERATED from ${inFile} — 源码在 src/，请勿直接编辑本文件。`,
    },
    logLevel: "warning",
    ...extra,
  });
}
console.log("build done:", entries.map(([, o]) => o).join(", "));
