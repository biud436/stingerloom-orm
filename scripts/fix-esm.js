#!/usr/bin/env node
/**
 * Post-build fixup for the ESM output (dist/esm).
 *
 * tsc emits the ESM build with the relative specifiers exactly as written in
 * the source (extensionless, e.g. `from "./DatabaseClient"`). Bundlers resolve
 * those, but plain Node's ESM loader does not — `import "@stingerloom/orm"`
 * from a `"type": "module"` app fails with ERR_MODULE_NOT_FOUND. Node also
 * needs `dist/esm` marked as `"type": "module"`, because the package root is
 * CommonJS.
 *
 * This script:
 *   1. rewrites relative import/export/dynamic-import specifiers to explicit
 *      file paths (`./x` → `./x.js`, `./dir` → `./dir/index.js`)
 *   2. writes `dist/esm/package.json` with `{"type": "module"}`
 */
const fs = require("fs");
const path = require("path");

/**
 * Rewrites one relative specifier to an explicit file path, resolving
 * directory imports to their index.js. Non-relative and already-extensioned
 * specifiers are returned unchanged.
 */
function rewriteSpecifier(spec, fileDir) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  if (/\.(js|mjs|cjs|json|node)$/.test(spec)) return spec;
  // Template interpolation means this is generated-code text inside a
  // template literal (e.g. introspection's EntityCodeBuilder), not a real
  // import specifier of this module.
  if (spec.includes("${")) return spec;
  const abs = path.resolve(fileDir, spec);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return `${spec.replace(/\/+$/, "")}/index.js`;
  }
  return `${spec}.js`;
}

/**
 * Rewrites every relative specifier in an ESM source string.
 * Covers `import ... from "x"`, `export ... from "x"`, side-effect
 * `import "x"` and dynamic `import("x")`.
 */
function rewriteSource(source, fileDir) {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|^[ \t]*import\s+)(["'])((?:\.\.?\/)[^"']+)\2/gm,
    (_m, prefix, quote, spec) =>
      `${prefix}${quote}${rewriteSpecifier(spec, fileDir)}${quote}`,
  );
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function main() {
  const esmDir = path.join(__dirname, "..", "dist", "esm");
  if (!fs.existsSync(esmDir)) {
    console.error(`fix-esm: ${esmDir} does not exist — run the ESM build first.`);
    process.exit(1);
  }

  let changed = 0;
  for (const file of walk(esmDir)) {
    const source = fs.readFileSync(file, "utf8");
    const fixed = rewriteSource(source, path.dirname(file));
    if (fixed !== source) {
      fs.writeFileSync(file, fixed);
      changed++;
    }
  }

  fs.writeFileSync(
    path.join(esmDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
  );

  console.log(`fix-esm: rewrote specifiers in ${changed} files, marked dist/esm as ESM.`);
}

module.exports = { rewriteSpecifier, rewriteSource };

if (require.main === module) {
  main();
}
