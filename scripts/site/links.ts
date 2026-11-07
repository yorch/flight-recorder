/**
 * Internal link and fragment checker for the built site (SPEC §14.1).
 *
 * Astro's build does not verify that `#s6-6` anchors exist, and the docs
 * importer is the only thing that creates them. This walks the emitted HTML so
 * a broken spec reference or a renamed page fails CI instead of publishing a
 * dead link. External URLs are deliberately not checked (no network in the gate).
 */

export interface Page {
  /** site-relative path of the emitted file, e.g. `spec/index.html` */
  path: string;
  html: string;
}

export interface Problem {
  page: string;
  href: string;
  reason: string;
}

/** Collects `id="..."` values so fragment links can be resolved. */
export function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/**
 * Collects `href` and `src` targets: a broken `<img src>` or `<script src>` is
 * as dead as a broken anchor, and the poster is exactly that kind of link.
 */
export function hrefs(html: string): string[] {
  // Code samples are full of `src="final.mp4"` style text (SPEC §15.6); only
  // real markup counts, so drop code blocks and inline code first.
  const markup = html.replace(/<pre[\s\S]*?<\/pre>/gi, '').replace(/<code[\s\S]*?<\/code>/gi, '');
  return [...markup.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
}

/** Any scheme (http:, https:, mailto:, tel:, data:) is out of scope for the internal check. */
const isExternal = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href);

const hasExtension = (segment: string): boolean => /\.[a-z0-9]+$/i.test(segment);

/**
 * Site-relative file for a link or asset: `/spec/` -> `spec/index.html`,
 * `../poster.png` from `readme/index.html` -> `poster.png`.
 */
export function resolveRef(href: string, from: string): string {
  const bare = href.split('#')[0].split('?')[0];
  const path = bare.replace(/^\/flight-recorder\/?/, '/');
  const rel = path.startsWith('/')
    ? path.slice(1)
    : new URL(path === '' ? '.' : path, `https://example.invalid/${from.replace(/[^/]+$/, '')}`).pathname.slice(1);
  if (rel === '' || rel.endsWith('/')) return `${rel}index.html`;
  if (hasExtension(rel.split('/').pop() as string)) return rel;
  return `${rel}/index.html`;
}

/**
 * Returns every internal link whose target file or fragment does not exist.
 * `files` is every emitted path in the build (assets included).
 */
export function checkLinks(pages: Page[], files: Iterable<string>, base = '/flight-recorder/'): Problem[] {
  const emitted = new Set(files);
  const pageIds = new Map(pages.map((p) => [p.path, ids(p.html)]));
  const problems: Problem[] = [];

  for (const page of pages) {
    for (const href of hrefs(page.html)) {
      if (isExternal(href) || href.startsWith('//')) continue;

      // A project site lives under `base`; an absolute link that leaves it (or
      // forgets the trailing slash, e.g. `/flight-recorderposter.png`) is dead.
      if (href.startsWith('/') && !href.startsWith(base)) {
        problems.push({ page: page.path, href, reason: `absolute link outside the project base ${base}` });
        continue;
      }

      if (href.startsWith('#')) {
        const frag = href.slice(1);
        const own = pageIds.get(page.path);
        if (frag !== '' && own !== undefined && !own.has(frag)) {
          problems.push({ page: page.path, href, reason: 'missing fragment on this page' });
        }
        continue;
      }

      const target = resolveRef(href, page.path);
      if (!emitted.has(target)) {
        problems.push({ page: page.path, href, reason: `missing file (resolved to ${target})` });
        continue;
      }
      const frag = href.split('#')[1] ?? '';
      if (frag !== '' && target.endsWith('.html')) {
        const targetIds = pageIds.get(target);
        if (targetIds === undefined || !targetIds.has(frag)) {
          problems.push({ page: page.path, href, reason: `missing fragment #${frag} in ${target}` });
        }
      }
    }
  }
  return problems;
}
