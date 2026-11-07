#!/usr/bin/env bun
/**
 * Runs the internal link/fragment check over a built site directory.
 * Usage: bun scripts/site/check-links.ts [dist]
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkLinks, type Page } from './links.ts';

const dir = process.argv[2] ?? 'dist';

/** Every emitted file, so asset links (css, images, sitemap) resolve too. */
const walk = (root: string, rel = ''): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out;
};

if (!fs.existsSync(dir)) {
  console.error(`check-links: ${dir} does not exist — run the site build first`);
  process.exit(1);
}

const files = walk(dir);
const pages: Page[] = files.filter((f) => f.endsWith('.html')).map((f) => ({ path: f, html: fs.readFileSync(path.join(dir, f), 'utf8') }));
const problems = checkLinks(pages, files);

if (problems.length > 0) {
  console.error(`check-links: ${problems.length} broken internal link(s) in ${pages.length} pages`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p.page}: ${p.href} — ${p.reason}`);
  process.exit(1);
}
console.log(`check-links: ${pages.length} pages, ${files.length} files, no broken internal links`);
