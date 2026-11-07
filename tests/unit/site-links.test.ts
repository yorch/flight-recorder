import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { checkLinks, hrefs, ids, resolveRef } from '../../scripts/site/links.ts';

describe('ids / hrefs', () => {
  it('collects ids and hrefs', () => {
    const html = '<a id="s6-6"></a><a href="/spec/#s6-6">x</a><link href="/_astro/a.css"><img src="/poster.png">';
    assert.deepEqual([...ids(html)], ['s6-6']);
    assert.deepEqual(hrefs(html), ['/spec/#s6-6', '/_astro/a.css', '/poster.png']);
  });
  it('ignores href/src text inside code samples', () => {
    const html = '<pre><code>&lt;video src="final.mp4"&gt;</code></pre><a href="/real/">real</a><code>src="nope.mp4"</code>';
    assert.deepEqual(hrefs(html), ['/real/']);
  });
});

describe('resolveRef', () => {
  it('maps routes to emitted files', () => {
    assert.equal(resolveRef('/spec/', 'index.html'), 'spec/index.html');
    assert.equal(resolveRef('/spec', 'index.html'), 'spec/index.html');
    assert.equal(resolveRef('/flight-recorder/spec/', 'index.html'), 'spec/index.html');
    assert.equal(resolveRef('/readme/', 'spec/index.html'), 'readme/index.html');
  });
  it('keeps asset paths as files', () => {
    assert.equal(resolveRef('/flight-recorder/poster.png', 'index.html'), 'poster.png');
    assert.equal(resolveRef('/flight-recorder/_astro/a.css', 'index.html'), '_astro/a.css');
    assert.equal(resolveRef('/flight-recorder/sitemap-index.xml', 'index.html'), 'sitemap-index.xml');
  });
  it('resolves relative links against the page', () => {
    assert.equal(resolveRef('../spec/', 'readme/index.html'), 'spec/index.html');
    assert.equal(resolveRef('spec/', 'index.html'), 'spec/index.html');
    assert.equal(resolveRef('./', 'spec/index.html'), 'spec/index.html');
    assert.equal(resolveRef('../spec/#s6-6', 'readme/index.html'), 'spec/index.html');
  });
});

describe('checkLinks', () => {
  const files = ['index.html', 'spec/index.html', 'readme/index.html', 'poster.png', '_astro/a.css'];
  const pages = [
    {
      path: 'index.html',
      html: '<a href="spec/">s</a><a href="readme/">r</a><a href="https://x.test/y">e</a><img src="/flight-recorder/poster.png">',
    },
    { path: 'spec/index.html', html: '<a id="s6-6"></a><a href="#s6-6">in</a><a href="../readme/">up</a>' },
    { path: 'readme/index.html', html: '<a href="../spec/#s6-6">deep</a><a href="mailto:a@b.test">m</a>' },
  ];

  it('accepts a clean site (external, mailto and assets ignored)', () => {
    assert.deepEqual(checkLinks(pages, files), []);
  });
  it('reports a missing page', () => {
    const problems = checkLinks([...pages, { path: 'bad/index.html', html: '<a href="../nope/">x</a>' }], [...files, 'bad/index.html']);
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /missing file \(resolved to nope\/index\.html\)/);
  });
  it('reports a missing fragment on the target page', () => {
    const problems = checkLinks(
      [{ path: 'readme/index.html', html: '<a href="../spec/#s9-9">deep</a><a href="#nope">own</a>' }, pages[1]],
      files,
    );
    assert.deepEqual(
      problems.map((p) => p.reason),
      ['missing fragment #s9-9 in spec/index.html', 'missing fragment on this page'],
    );
  });
  it('rejects absolute links that fall outside the project base', () => {
    const problems = checkLinks([{ path: 'index.html', html: '<img src="/flight-recorderposter.png">' }], files);
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /outside the project base/);
  });
  it('ignores protocol-relative URLs', () => {
    assert.deepEqual(checkLinks([{ path: 'index.html', html: '<a href="//cdn.test/x">c</a>' }], files), []);
  });
});
