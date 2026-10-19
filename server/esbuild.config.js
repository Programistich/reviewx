// @ts-check
import { build } from "esbuild";
import { mkdirSync, rmSync } from "fs";

rmSync("./dist", { recursive: true, force: true });
mkdirSync("./dist", { recursive: true });

await build({
  entryPoints: ["./src/index.ts"],
  outfile: "./dist/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});

console.log("» server build completed");
