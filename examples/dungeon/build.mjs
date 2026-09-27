// Build the dungeon pack: TS sources in src/ -> artifacts the gateway serves
// straight from disk (rules.js, brains/*.js, ui/app/assets/*). Committed, so a
// plain checkout needs no node at all; node is only a build-time tool.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

// Vue/浏览器应用额外需要：NODE_ENV 走生产分支；组件用 TSX（jsxFactory=h），
// 不再需要运行时模板编译器，alias 指到 runtime-only 版 Vue。
const VUE_DEFINE = {
  "process.env.NODE_ENV": '"production"',
  __VUE_OPTIONS_API__: "true",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
};

const entries = [
  ["src/rules.ts", "rules.js", {}],
  ["src/brains/adventurer.ts", "brains/adventurer.js", {}],
  ["src/brains/sage.ts", "brains/sage.js", {}],
  ["src/brains/narrator.ts", "brains/narrator.js", {}],
  ["src/brains/oracle.ts", "brains/oracle.js", {}],
  ["src/brains/dm.ts", "brains/dm.js", {}],
  // Vue+Pinia 版 UI：src/app/main.ts -> ui/app/assets/app.js + app.css（import 的 css 由 esbuild 同名输出）
  // 组件是 TSX（src/app/**.tsx）：automatic runtime（vue/jsx-runtime 的 jsx/jsxs 就是 h），
  // tsc 走 jsx:react-jsx + jsxImportSource:vue 做类型检查。"vue" 默认解析就是 runtime-only 版
  // （无需 alias），不再需要运行时模板编译器。
  // 这条入口按 production 交付：压缩产物（页面零 dev server、零 vite 痕迹）。
  [
    "src/app/main.ts",
    "ui/app/assets/app.js",
    {
      define: VUE_DEFINE,
      charset: "utf8",
      jsx: "automatic",
      jsxImportSource: "vue",
      minify: true,
    },
  ],
];

await mkdir("brains", { recursive: true });
await mkdir("ui/app/assets", { recursive: true });

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
