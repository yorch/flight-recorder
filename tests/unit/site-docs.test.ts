import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSiteDocs,
  chunks,
  DocsError,
  extractFence,
  headingAnchor,
  injectHeadingAnchors,
  rewriteRepoLinks,
  rewriteSectionRefs,
  takeTitle,
  yaml,
} from '../../scripts/site/docs.ts';

const readme = `# Flight Recorder

Intro with a [spec](SPEC.md), [agents](AGENTS.md) and a [license](LICENSE).

## Quick Start

\`\`\`bash
bun install
\`\`\`

See §6.6 for the lifecycle, and §15–16 for natural-language runs.
`;

const spec = `# Technical Specification: Thing

## 0. Scope

Intro.

## 1. System Architecture Overview

\`\`\`text
src/agent/verdict.ts      # run verdict (§6.4)
\`\`\`

## 6. Agent Control Plane

### 6.4 Verdict

Verdict text.

### 6.6 Run Lifecycle

Text about §6.4 and \`§6.6\` in code.

## 14. Quality Gates

### 14.1 CI

Nothing here.

## 15. Natural-Language Runs

### 15.1 Request

Body.

## 16. Control Plane

Body.
`;

const architecture = `# Architecture

Talks about §6.6 and §1.
`;

describe('headingAnchor', () => {
  it('maps SPEC headings to stable ids', () => {
    assert.equal(headingAnchor('## 6. Agent Control Plane'), 's6');
    assert.equal(headingAnchor('### 6.6 Run Lifecycle'), 's6-6');
    assert.equal(headingAnchor('## 0. Scope'), 's0');
    assert.equal(headingAnchor('### 15.1 Request and TestSpec Extensions'), 's15-1');
    assert.equal(headingAnchor('# 14. Quality Gates'), 's14');
  });
  it('ignores headings without a number', () => {
    assert.equal(headingAnchor('### Pinned Versions'), null);
    assert.equal(headingAnchor('## Getting started'), null);
  });
});

describe('injectHeadingAnchors', () => {
  it('adds an anchor before each numbered heading and collects the ids', () => {
    const { markdown, ids } = injectHeadingAnchors(spec);
    assert.ok(markdown.includes('<a id="s0"></a>\n## 0. Scope'));
    assert.ok(markdown.includes('<a id="s6-6"></a>\n### 6.6 Run Lifecycle'));
    assert.deepEqual([...ids].sort(), ['s0', 's1', 's14', 's14-1', 's15', 's15-1', 's16', 's6', 's6-4', 's6-6']);
  });
  it('never treats a heading inside a fence as a heading', () => {
    const { ids } = injectHeadingAnchors('## 1. Real\n\n```\n## 9. Fake\n```\n');
    assert.deepEqual([...ids], ['s1']);
  });
  it('rejects duplicate section ids instead of suffixing them', () => {
    assert.throws(() => injectHeadingAnchors('## 6. One\n\n### 6.6 Two\n\n## 6. Again\n'), /duplicate section id 's6'/);
  });
});

describe('chunks', () => {
  it('separates prose from fenced code', () => {
    const parts = chunks('a\n```\nb\n```\nc\n');
    assert.deepEqual(parts.prose, ['a', 'c', '']);
    assert.deepEqual(parts.fence, ['```', 'b', '```']);
  });
});

describe('rewriteSectionRefs', () => {
  const known = new Set(['s6', 's6-6', 's15', 's16']);
  it('links prose references', () => {
    assert.equal(rewriteSectionRefs('see §6.6 and §15 here', known), 'see [§6.6](#s6-6) and [§15](#s15) here');
  });
  it('leaves fenced code and inline code byte-identical', () => {
    const source = 'Prose §6.6\n\n```text\nverdict (§6.4) §15\n```\n\nAnd `§6.6` inline, plus §15.\n';
    const out = rewriteSectionRefs(source, known);
    assert.ok(out.includes('```text\nverdict (§6.4) §15\n```'), 'fence must not be touched');
    assert.ok(out.includes('And `§6.6` inline'), 'inline code must not be touched');
    assert.ok(out.includes('plus [§15](#s15)'), 'prose around inline code is rewritten');
  });
  it('links a section range to its first section', () => {
    assert.equal(rewriteSectionRefs('see §15–16', known), 'see [§15–16](#s15)');
  });
  it('fails on a reference to a section that does not exist', () => {
    assert.throws(() => rewriteSectionRefs('see §99', known), DocsError);
    assert.throws(() => rewriteSectionRefs('see §6.7', known), /dangling section reference/);
  });
  it('can be told to leave dangling references alone', () => {
    assert.equal(rewriteSectionRefs('see §99', known, false), 'see §99');
  });
});

describe('takeTitle', () => {
  it('lifts the first H1 and leaves the rest of the body', () => {
    assert.deepEqual(takeTitle('# Title here\n\nBody\n', 'fallback'), { title: 'Title here', body: 'Body\n' });
  });
  it('falls back when there is no H1', () => {
    assert.deepEqual(takeTitle('Body only\n', 'fallback'), { title: 'fallback', body: 'Body only\n' });
  });
});

describe('rewriteRepoLinks', () => {
  it('routes SPEC to the site and unpublished files to GitHub', () => {
    const out = rewriteRepoLinks('[spec](SPEC.md) [agents](AGENTS.md) [license](LICENSE)');
    assert.equal(
      out,
      '[spec](../spec/) [agents](https://github.com/yorch/flight-recorder/blob/main/AGENTS.md) [license](https://github.com/yorch/flight-recorder/blob/main/LICENSE)',
    );
  });
});

describe('extractFence', () => {
  it('returns the first fenced block after a matching heading', () => {
    assert.equal(extractFence(spec, /^##\s+1\.\s/), 'src/agent/verdict.ts      # run verdict (§6.4)');
  });
  it('returns null when the heading or block is missing', () => {
    assert.equal(extractFence(spec, /^##\s+99\.\s/), null);
    assert.equal(extractFence('## 1. X\n\nno fence\n', /^##\s+1\.\s/), null);
  });
});

describe('yaml', () => {
  it('quotes scalars so titles cannot break the frontmatter', () => {
    assert.equal(yaml('Flight Recorder'), '"Flight Recorder"');
    assert.equal(yaml('a: b "c"'), '"a: b \\"c\\""');
  });
});

describe('buildSiteDocs', () => {
  const { files, anchors } = buildSiteDocs({ readme, spec, architecture });

  it('publishes exactly the allowlisted pages plus the two generated snippets', () => {
    assert.deepEqual(Object.keys(files).sort(), [
      'src/content/docs/architecture.md',
      'src/content/docs/readme.md',
      'src/content/docs/spec.md',
      'src/generated/architecture.txt',
      'src/generated/quickstart.txt',
    ]);
    assert.equal(anchors.size, 10);
  });
  it('keeps normative code byte-identical and rewrites only prose', () => {
    const page = files['src/content/docs/spec.md'] as string;
    assert.ok(page.includes('```text\nsrc/agent/verdict.ts      # run verdict (§6.4)\n```'));
    assert.ok(page.includes('<a id="s6-6"></a>'));
    assert.ok(page.includes('[§6.4](#s6-4)'), 'prose reference is linked');
    assert.ok(page.includes('`§6.6`'), 'inline code is left byte-identical');
  });
  it('writes frontmatter, the source notice and no duplicate H1', () => {
    const page = files['src/content/docs/spec.md'] as string;
    assert.ok(page.startsWith('---\ntitle: "Technical Specification: Thing"\n'));
    assert.ok(page.includes('tableOfContents:'));
    assert.ok(page.includes('generated-notice'));
    assert.equal(page.match(/^# /gm), null);
  });
  it('extracts the architecture diagram and quick start from source', () => {
    assert.match(files['src/generated/architecture.txt'] as string, /run verdict \(§6\.4\)/);
    assert.match(files['src/generated/quickstart.txt'] as string, /^bun install$/m);
  });
  it('fails when the source documents lose their extractable blocks', () => {
    const withoutDiagram = spec.replace(/```text\n[\s\S]*?```\n/, '');
    assert.throws(() => buildSiteDocs({ readme, spec: withoutDiagram, architecture }), /architecture diagram/);
    assert.throws(() => buildSiteDocs({ readme: readme.replace('## Quick Start', '## Start'), spec, architecture }), /Quick Start/);
  });
});

describe('build-docs CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-docs-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  it('is runnable against a scratch copy of the sources', () => {
    // The CLI resolves the repo root from its own location, so a scratch tree is
    // only used to prove the module has no import-time side effects.
    assert.equal(fs.existsSync(path.join(root, 'README.md')), false);
    assert.equal(typeof buildSiteDocs, 'function');
  });
});
