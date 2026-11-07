/**
 * Documentation importer for the GitHub Pages site (SPEC §14.1).
 *
 * The site never forks the docs: README.md, SPEC.md and docs/ARCHITECTURE.md
 * stay the sources, and `scripts/site/build-docs.ts` regenerates
 * `site/src/content/docs/*.md` from them. Everything here is pure so it can be
 * unit tested; the only IO lives in the CLI.
 *
 * Rules that matter:
 * - Section identity is the SPEC number, not the heading text: `## 6. Agent
 *   Control Plane` -> `#s6`, `### 6.6 ...` -> `#s6-6`. Titles can change without
 *   breaking links; renumbering is a deliberate migration.
 * - `§N.M` references are rewritten in prose only. Fenced code, inline code and
 *   existing links are left byte-identical (SPEC contains `§` inside a repo tree
 *   and inside code samples).
 * - A reference that points at a section that does not exist fails the build.
 */
export class DocsError extends Error {}

/** Heading number -> anchor id: `s6`, `s6-6`. Section 0 becomes `s0`. */
export function headingAnchor(text: string): string | null {
  const m = /^\s*(?:#+\s*)?(\d+)((?:\.\d+)*)\.?\s/.exec(text);
  if (!m) return null;
  return `s${m[1]}${m[2]
    .split('.')
    .filter(Boolean)
    .map((n) => `-${n}`)
    .join('')}`;
}

const FENCE = /^\s*(```|~~~)/;

/** Splits a markdown document into prose and fenced-code chunks (fences kept verbatim). */
export function chunks(markdown: string): { prose: string[]; fence: string[] } {
  const prose: string[] = [];
  const fence: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      fence.push(line);
      continue;
    }
    (inFence ? fence : prose).push(line);
  }
  return { prose, fence };
}

/** Splits a line into inline-code and plain segments so code spans are never rewritten. */
function inlineSegments(line: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const parts = line.split(/(`[^`]*`)/);
  for (const part of parts) {
    if (part === '') continue;
    out.push({ text: part, code: part.startsWith('`') && part.endsWith('`') && part.length > 1 });
  }
  return out;
}

// One pattern for both shapes: `§6.6` and the range form `§15–16` (linked to
// its first section). A single pass keeps the replacement text from being
// re-scanned, which is what nested links would need.
const REF = /§(\d+(?:\.\d+)*)(?:–\d+)?/g;

const anchorForNumber = (num: string): string => `s${num.replace(/\./g, '-')}`;

/**
 * Rewrites prose `§N` / `§N.M` / `§N–M` into same-page anchor links. Fenced code
 * and inline code are untouched; an unknown section id throws.
 */
export function rewriteSectionRefs(markdown: string, known: Set<string>, failOnUnknown = true, linkBase = ''): string {
  const { prose, fence } = chunks(markdown);
  const rewritten = prose.map((line) => {
    if (FENCE.test(line)) return line;
    return inlineSegments(line)
      .map((seg) => {
        if (seg.code) return seg.text;
        return seg.text.replace(REF, (whole, num: string) => {
          const id = anchorForNumber(num);
          if (!known.has(id)) return failOnUnknown ? fail(whole, id) : whole;
          return `[${whole}](${linkBase}#${id})`;
        });
      })
      .join('');
  });
  // `chunks` preserves order only when reassembled; rebuild by walking the source.
  return reassemble(markdown, rewritten, fence);
}

const fail = (whole: string, id: string): never => {
  throw new DocsError(`dangling section reference ${whole}: no heading with id '${id}'`);
};

/**
 * `chunks` separates prose and fences; reassemble the document in its original
 * order, substituting the rewritten prose lines.
 */
function reassemble(original: string, rewrittenProse: string[], _fence: string[]): string {
  const out: string[] = [];
  let proseIndex = 0;
  let inFence = false;
  for (const line of original.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : (rewrittenProse[proseIndex++] as string));
  }
  return out.join('\n');
}

/** Inserts `<a id="sN"></a>` before every numbered heading so `#sN` / `#sN-M` resolve. */
export function injectHeadingAnchors(markdown: string): { markdown: string; ids: Set<string> } {
  const ids = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!inFence && heading) {
      const id = headingAnchor(heading[2]);
      if (id) {
        if (ids.has(id)) throw new DocsError(`duplicate section id '${id}' for heading '${heading[2]}'`);
        ids.add(id);
        out.push(`<a id="${id}"></a>`, line);
        continue;
      }
    }
    out.push(line);
  }
  return { markdown: out.join('\n'), ids };
}

/** Pulls the first H1 out of a document: it becomes the page title. */
export function takeTitle(markdown: string, fallback: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (at < 0) return { title: fallback, body: markdown };
  const title = lines[at].replace(/^#\s+/, '').trim();
  return { title, body: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').replace(/^\n+/, '') };
}

/** YAML-safe scalar: JSON double-quoted strings are valid YAML. */
export const yaml = (value: string): string => JSON.stringify(value);

export interface SourceDocs {
  readme: string;
  spec: string;
  architecture: string;
}

export interface SiteFiles {
  /** site-relative path -> file content */
  files: Record<string, string>;
  /** section ids published, for the link check and tests */
  anchors: Set<string>;
}

const REPO = 'https://github.com/yorch/flight-recorder';

/** Rewrites the README's repo-relative links to site routes or GitHub URLs. */
export function rewriteRepoLinks(markdown: string): string {
  return markdown
    .replace(/\]\(SPEC\.md\)/g, '](../spec/)')
    .replace(/\]\(AGENTS\.md\)/g, `](${REPO}/blob/main/AGENTS.md)`)
    .replace(/\]\(LICENSE\)/g, `](${REPO}/blob/main/LICENSE)`);
}

const notice = (source: string): string =>
  `<p class="generated-notice">Generated from <a href="${REPO}/blob/main/${source}">${source}</a> — edit it there, not here.</p>`;

/** Extracts the first fenced block after a heading matching `heading`, for landing-page reuse. */
export function extractFence(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const open = lines.findIndex((l, i) => i > start && FENCE.test(l));
  if (open < 0) return null;
  const close = lines.findIndex((l, i) => i > open && FENCE.test(l));
  if (close < 0) return null;
  return lines
    .slice(open + 1, close)
    .join('\n')
    .replace(/\s+$/, '');
}

/**
 * Builds every generated site file from the three sources. Paths are fixed by
 * this allowlist, so a new `docs/*.md` can never appear on the site by accident.
 */
export function buildSiteDocs(sources: SourceDocs): SiteFiles {
  const specWithAnchors = injectHeadingAnchors(sources.spec);
  const { title: specTitle, body: specBody } = takeTitle(specWithAnchors.markdown, 'Technical specification');
  const spec = rewriteSectionRefs(specBody, specWithAnchors.ids);

  const { title: readmeTitle, body: readmeBody } = takeTitle(rewriteRepoLinks(sources.readme), 'Flight Recorder');
  // Only the spec page carries the anchors; other pages link across to it.
  const readme = rewriteSectionRefs(readmeBody, specWithAnchors.ids, true, '../spec/');

  const { title: archTitle, body: archBody } = takeTitle(sources.architecture, 'Architecture notes');
  const architecture = rewriteSectionRefs(archBody, specWithAnchors.ids, true, '../spec/');

  const diagram = extractFence(sources.spec, /^##\s+1\.\s/);
  const quickstart = extractFence(sources.readme, /^##\s+Quick Start/);

  const page = (title: string, source: string, body: string, extra = ''): string =>
    ['---', `title: ${yaml(title)}`, 'template: doc', extra, '---', '', notice(source), '', body, ''].join('\n').replace(/\n{3,}/g, '\n\n');

  const files: Record<string, string> = {
    'src/content/docs/readme.md': page(readmeTitle, 'README.md', readme),
    'src/content/docs/spec.md': page(specTitle, 'SPEC.md', spec, 'tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 }'),
    'src/content/docs/architecture.md': page(archTitle, 'docs/ARCHITECTURE.md', architecture),
  };
  if (diagram === null) throw new DocsError('SPEC §1 has no fenced architecture diagram to publish');
  if (quickstart === null) throw new DocsError('README has no fenced Quick Start block to publish');
  files['src/generated/architecture.txt'] = `${diagram}\n`;
  files['src/generated/quickstart.txt'] = `${quickstart}\n`;

  return { files, anchors: specWithAnchors.ids };
}
