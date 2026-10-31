// Copies shared/lib.js into every mods/forge-* folder, and shared/forge.py into every
// one that talks to a forge, stamping forge.py's VERSION with a hash of its contents
// (mods install each version once per machine). `--check` only reports copies that
// differ, for the tests and CI.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NO_FORGE = new Set(["forge-toggle"]); // layout glue: never calls forge.py

export function expected() {
  const lib = readFileSync(join(root, "shared/lib.js"), "utf8");
  const py = readFileSync(join(root, "shared/forge.py"), "utf8");
  const version = createHash("sha256").update(py).digest("hex").slice(0, 12);
  const stamped = py.replace(/^VERSION = "[^"]*"/m, `VERSION = "${version}"`);
  const out = new Map();
  for (const mod of readdirSync(join(root, "mods")).filter((m) => m.startsWith("forge-")).sort()) {
    out.set(join("mods", mod, "lib.js"), lib);
    if (!NO_FORGE.has(mod)) out.set(join("mods", mod, "forge.py"), stamped);
  }
  return out;
}

export function stale() {
  return [...expected()].filter(([path, text]) => {
    const file = join(root, path);
    return !existsSync(file) || readFileSync(file, "utf8") !== text;
  }).map(([path]) => path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const bad = stale();
    if (bad.length) {
      console.error(`Out of date (run npm run sync):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
  } else {
    for (const [path, text] of expected()) writeFileSync(join(root, path), text);
  }
}
