#!/usr/bin/env node
/**
 * Validates every internal link in docs/ against the built VitePress output.
 *
 * VitePress is configured with `ignoreDeadLinks: true`, and CI does not build
 * the docs on pull requests, so a broken relative link or a stale `#anchor`
 * ships silently and 404s (or fails to scroll) for readers. This script closes
 * that gap: it resolves every `[text](target)` against the real files and, for
 * anchors, against the heading ids VitePress actually emitted.
 *
 * Two failure modes it is specifically built to catch:
 *   - stale anchors left behind when a heading was renamed;
 *   - Korean anchors whose Unicode normalization differs from the emitted id
 *     (the reason `markdown.anchor.slugify` re-composes to NFC in config.mts).
 *
 * Usage: pnpm docs:check   (builds the site first, then runs this)
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const DIST = path.join(DOCS, ".vitepress", "dist");

const LINK_RE = /\[([^\]]+)\]\((\.{0,2}\/?[^)\s]+)\)/g;
const HEADING_ID_RE = /<h[1-6][^>]*\bid="([^"]+)"/g;
const FENCE_RE = /```[\s\S]*?```/g;

/** Heading ids per built HTML page, resolved lazily. */
const idCache = new Map();

function headingIds(htmlPath) {
  if (idCache.has(htmlPath)) return idCache.get(htmlPath);
  let ids = null;
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf-8");
    ids = new Set();
    for (const m of html.matchAll(HEADING_ID_RE)) ids.add(m[1]);
  }
  idCache.set(htmlPath, ids);
  return ids;
}

/** docs/ko/foo.md -> dist/ko/foo.html */
function builtPageFor(mdPath) {
  const rel = path.relative(DOCS, mdPath).replace(/\.md$/, ".html");
  return path.join(DIST, rel);
}

function markdownFiles() {
  const out = [];
  for (const dir of [DOCS, path.join(DOCS, "ko")]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".md")) out.push(path.join(dir, name));
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(
      "check-doc-links: docs/.vitepress/dist not found — run `pnpm docs:build` first.",
    );
    process.exit(1);
  }

  const problems = [];
  const files = markdownFiles();

  for (const md of files) {
    // Links inside fenced code blocks are samples, not navigation.
    const source = fs.readFileSync(md, "utf-8").replace(FENCE_RE, "");
    const ownIds = headingIds(builtPageFor(md));

    for (const [, text, target] of source.matchAll(LINK_RE)) {
      if (/^(https?:|mailto:|tel:)/.test(target)) continue;

      const hashAt = target.indexOf("#");
      const filePart = hashAt === -1 ? target : target.slice(0, hashAt);
      const anchor = hashAt === -1 ? "" : target.slice(hashAt + 1);

      // In-page anchor.
      if (!filePart) {
        if (ownIds && !ownIds.has(anchor)) {
          problems.push({ md, target, text, why: "no such heading on this page" });
        }
        continue;
      }

      // Root-absolute links resolve against docs/, everything else against the file.
      const baseDir = filePart.startsWith("/") ? DOCS : path.dirname(md);
      let resolved = path.normalize(
        path.join(baseDir, filePart.replace(/^\//, "")),
      );
      // VitePress also resolves extensionless links (./relations -> relations.md).
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.md`)) {
        resolved = `${resolved}.md`;
      }
      if (!fs.existsSync(resolved)) {
        problems.push({ md, target, text, why: "file does not exist" });
        continue;
      }

      if (!anchor) continue;
      const ids = headingIds(builtPageFor(resolved));
      if (ids && !ids.has(anchor)) {
        problems.push({ md, target, text, why: "no such heading on target page" });
      }
    }
  }

  for (const p of problems) {
    console.error(
      `${path.relative(ROOT, p.md)}: ${p.target}  — ${p.why}  [${p.text}]`,
    );
  }

  const summary = `check-doc-links: scanned ${files.length} files, ${problems.length} broken link(s)`;
  if (problems.length) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  console.log(summary);
}

main();
