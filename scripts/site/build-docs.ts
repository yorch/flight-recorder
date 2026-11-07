#!/usr/bin/env bun
/**
 * Regenerates the site's documents from the repo's markdown (SPEC §14.1).
 * Writes only the allowlisted paths from scripts/site/docs.ts, and removes any
 * document it did not just generate, so a renamed page cannot linger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSiteDocs, DocsError } from './docs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SITE = path.join(ROOT, 'site');
const DOCS_DIR = path.join(SITE, 'src/content/docs');

const read = (rel: string): string => {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new DocsError(`missing source document: ${rel}`);
  return fs.readFileSync(file, 'utf8');
};

const main = (): void => {
  const { files, anchors } = buildSiteDocs({
    readme: read('README.md'),
    spec: read('SPEC.md'),
    architecture: read('docs/ARCHITECTURE.md'),
  });

  for (const rel of Object.keys(files)) {
    const abs = path.resolve(SITE, rel);
    if (!abs.startsWith(`${SITE}${path.sep}`)) throw new DocsError(`refusing to write outside the site: ${rel}`);
  }

  // Every generated document is rewritten; anything else under docs/ that this
  // script did not produce is stale (authored pages live in index.mdx).
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  for (const entry of fs.readdirSync(DOCS_DIR)) {
    const keep = entry === 'index.mdx' || `src/content/docs/${entry}` in files;
    if (!keep && entry.endsWith('.md')) fs.rmSync(path.join(DOCS_DIR, entry));
  }

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(SITE, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`site-docs: wrote ${path.relative(ROOT, abs)} (${content.length} bytes)`);
  }
  console.log(`site-docs: ${Object.keys(files).length} files, ${anchors.size} section anchors`);
};

try {
  main();
} catch (error) {
  if (error instanceof DocsError) {
    console.error(`site-docs: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
