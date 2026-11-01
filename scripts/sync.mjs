// Copies shared/lib.js and shared/ui.js into every mods/forge-* folder, and shared/forge.py into every
// one that talks to a forge, stamping forge.py's VERSION with package.json's version and
// a hash of its contents (mods install each version once per machine). The optional shared
// modules (agents.js, cleanup.js) go only to the mods that import them. `--check` only reports
// copies that differ, and optional ones a mod doesn't import, for the tests and CI; a plain
// run writes the copies and deletes those strays. `base` (tests only) is another tree like this one.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NO_FORGE = new Set(["forge-toggle"]); // layout glue: never calls forge.py
const OPTIONAL = ["agents.js", "cleanup.js"]; // copied only where something imports them

// The optional shared modules a text imports (`from "./agents.js"`), not counting `//` comment lines.
const importsOf = (text) => [...text.replace(/^\s*\/\/.*$/gm, "").matchAll(/\bfrom\s+["']\.\/([\w.-]+\.js)["']/g)].map((m) => m[1]).filter((f) => OPTIONAL.includes(f));

// The optional modules a mod needs: the ones its own files import (not copies of shared
// files, so a stray copy can't make itself needed), and what those import in turn.
function optionalFor(mod, texts, base) {
  const dir = join(base, "mods", mod);
  const own = readdirSync(dir).filter((f) => f.endsWith(".js") && !OPTIONAL.includes(f) && f !== "lib.js" && f !== "ui.js");
  const need = new Set([...own.flatMap((f) => importsOf(readFileSync(join(dir, f), "utf8"))),
    ...importsOf(texts.lib), ...importsOf(texts.ui)]);
  for (const f of need) for (const g of importsOf(texts[f])) need.add(g); // a Set iterates what's added
  return [...need].sort();
}

export function expected(base = root) {
  const lib = readFileSync(join(base, "shared/lib.js"), "utf8");
  const ui = readFileSync(join(base, "shared/ui.js"), "utf8");
  const py = readFileSync(join(base, "shared/forge.py"), "utf8");
  // <release>+<hash>: the release orders versions, the hash tells builds apart.
  const { version: rel } = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const hash = createHash("sha256").update(py).digest("hex").slice(0, 12);
  const stamped = py.replace(/^VERSION = "[^"]*"/m, `VERSION = "${rel}+${hash}"`);
  const texts = { lib, ui, ...Object.fromEntries(OPTIONAL.map((f) => [f, readFileSync(join(base, "shared", f), "utf8")])) };
  const out = new Map();
  // Shipped skills say which release they came from, so installs never downgrade them.
  for (const mod of readdirSync(join(base, "mods")).filter((m) => m.startsWith("forge-"))) {
    const skills = join(base, "mods", mod, "skills");
    if (!existsSync(skills)) continue;
    for (const name of readdirSync(skills)) {
      const path = join("mods", mod, "skills", name, "SKILL.md");
      if (!existsSync(join(base, path))) continue;
      out.set(path, readFileSync(join(base, path), "utf8").replace(/herdr-forge \d+\.\d+\.\d+/, `herdr-forge ${rel}`));
    }
  }
  for (const mod of readdirSync(join(base, "mods")).filter((m) => m.startsWith("forge-")).sort()) {
    out.set(join("mods", mod, "lib.js"), lib);
    out.set(join("mods", mod, "ui.js"), ui);
    if (!NO_FORGE.has(mod)) out.set(join("mods", mod, "forge.py"), stamped);
    for (const f of optionalFor(mod, texts, base)) out.set(join("mods", mod, f), texts[f]);
  }
  return out;
}

// Copies of an optional module in a mod that doesn't import it.
function strays(want, base) {
  return readdirSync(join(base, "mods")).filter((m) => m.startsWith("forge-")).sort()
    .flatMap((mod) => OPTIONAL.map((f) => join("mods", mod, f)))
    .filter((path) => !want.has(path) && existsSync(join(base, path)));
}

export function stale(base = root) {
  const want = expected(base);
  const bad = [...want].filter(([path, text]) => {
    const file = join(base, path);
    return !existsSync(file) || readFileSync(file, "utf8") !== text;
  }).map(([path]) => path);
  return [...bad, ...strays(want, base).map((path) => `${path} (not imported there: sync deletes it)`)];
}

export function sync(base = root) {
  const want = expected(base);
  for (const [path, text] of want) writeFileSync(join(base, path), text);
  for (const path of strays(want, base)) rmSync(join(base, path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const bad = stale();
    if (bad.length) {
      console.error(`Out of date (run npm run sync):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
  } else {
    sync();
  }
}
