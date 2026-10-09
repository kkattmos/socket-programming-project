import { build, context } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

await rm(path.join(directory, "dist", "assets"), { recursive: true, force: true });
await mkdir(path.join(directory, "dist", "assets"), { recursive: true });
await copyFile(path.join(directory, "index.html"), path.join(directory, "dist", "index.html"));

const options = {
  entryPoints: [path.join(directory, "src", "main.jsx")],
  outfile: path.join(directory, "dist", "assets", "app.js"),
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx" },
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log("Watching the React client. Refresh http://127.0.0.1:3000 after changes.");
} else {
  await build(options);
  console.log("React client built in client/dist.");
}
