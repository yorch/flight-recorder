import type { Evaluation, Plan } from '../agent/plan.ts';
import type { TestSpec } from '../config.ts';
import type { RunStatus, Status } from '../events.ts';
import type { Chapter } from '../postprocess/chapters.ts';

/** The only escaping function: applied to EVERY string interpolated into report.html. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export interface ReportInput {
  run_id: string;
  status: RunStatus;
  summary: string;
  model: string;
  chrome_version: string;
  started_at: string;
  ended_at: string;
  tokens: { input: number; output: number };
  egress: { allowed: number; denied: { host: string; count: number }[] } | null;
  spec: TestSpec;
  plan: Plan | null;
  planStatus: Record<string, string>;
  stepNotes: Record<string, string>;
  stepDones: { plan_step: string; status: Status }[];
  assertions: { step_id: string; label: string; criterion: string | null; passed: boolean }[];
  evaluation: Evaluation | null;
  chapters: Chapter[];
  /** screenshot paths relative to the run dir, grouped by owning plan step (null key = final/other). */
  screenshots: { plan_step: string | null; path: string }[];
}

interface CriterionReport {
  id: string;
  description: string;
  verified: boolean;
  evaluator_status: string;
  evidence: string;
  screenshots: string[];
  assertions: { step_id: string; label: string; passed: boolean }[];
}

/** §15.6 report.json content, built deterministically from run data + evaluator output. */
export function buildReportJson(i: ReportInput) {
  const chapterStart = new Map<string, number>();
  for (const ch of i.chapters) if (ch.plan_step && !chapterStart.has(ch.plan_step)) chapterStart.set(ch.plan_step, ch.start);

  const plan = i.plan
    ? {
        title: i.plan.title,
        steps: i.plan.steps.map((s) => ({
          id: s.id,
          intent: s.intent,
          expected: s.expected,
          outcome: i.planStatus[s.id] ?? 'open',
          notes: i.stepNotes[s.id] ?? null,
          chapter_start: chapterStart.get(s.id) ?? null,
          screenshots: i.screenshots.filter((sh) => sh.plan_step === s.id).map((sh) => sh.path),
        })),
        criteria: i.plan.criteria.map<CriterionReport>((c) => {
          const ev = i.evaluation?.criteria.find((e) => e.id === c.id);
          const assertions = i.assertions.filter((a) => a.criterion === c.id);
          const passed = assertions.filter((a) => a.passed);
          return {
            id: c.id,
            description: c.description,
            verified: passed.length > 0 && ev?.status === 'MET',
            evaluator_status: ev?.status ?? 'UNCLEAR',
            evidence: ev?.evidence ?? '',
            screenshots: ev?.screenshots ?? [],
            assertions: assertions.map((a) => ({ step_id: a.step_id, label: a.label, passed: a.passed })),
          };
        }),
      }
    : null;

  return {
    run_id: i.run_id,
    title: i.spec.title ?? i.spec.name,
    status: i.status,
    summary: i.summary,
    model: i.model,
    start_url: i.spec.start_url,
    instructions: i.spec.goal,
    timing: { started_at: i.started_at, ended_at: i.ended_at },
    tokens: i.tokens,
    chrome_version: i.chrome_version,
    egress: i.egress,
    plan,
    issues: i.evaluation?.issues ?? [],
    conclusions: i.evaluation?.conclusions ?? '',
    assertions: i.assertions,
    artifacts: {
      video: 'final.mp4',
      raw_video: 'raw.mkv',
      chapters_vtt: 'chapters.vtt',
      screenshots: i.screenshots.map((s) => s.path),
    },
  };
}

type ReportJson = ReturnType<typeof buildReportJson>;

/** §15.6 report.md — the human-readable markdown rendering of report.json. */
export function renderReportMd(r: ReportJson): string {
  const md: string[] = [
    `# ${r.title}`,
    '',
    `**Status:** ${r.status}`,
    `**Summary:** ${r.summary}`,
    `**Run:** ${r.run_id} · **Model:** ${r.model} · **Chrome:** ${r.chrome_version}`,
    `**Started:** ${r.timing.started_at} · **Ended:** ${r.timing.ended_at} · **Tokens:** ${r.tokens.input} in / ${r.tokens.output} out`,
    '',
    '## Instructions',
    '',
    r.instructions,
    '',
    '## Video',
    '',
    '- [final.mp4](final.mp4) · [raw.mkv](raw.mkv) · [chapters.vtt](chapters.vtt)',
    '',
  ];
  if (r.plan) {
    md.push(`## Plan: ${r.plan.title}`, '');
    for (const s of r.plan.steps) {
      const shots = s.screenshots.length ? ` (${s.screenshots.length} screenshot${s.screenshots.length === 1 ? '' : 's'})` : '';
      md.push(
        `- **${s.id}** ${s.intent} — ${s.outcome}${s.notes ? ` — ${s.notes}` : ''}${s.chapter_start !== null ? ` @ ${s.chapter_start}s` : ''}${shots}`,
      );
    }
    md.push('', '### Criteria', '');
    for (const c of r.plan.criteria) {
      md.push(`- **${c.id}** ${c.description} — ${c.verified ? 'VERIFIED' : c.evaluator_status}${c.evidence ? ` (${c.evidence})` : ''}`);
    }
    md.push('');
  }
  if (r.issues.length) {
    md.push('## Issues', '');
    for (const i of r.issues) md.push(`- **${i.severity}** ${i.title}${i.description ? ` — ${i.description}` : ''}`);
    md.push('');
  }
  if (r.conclusions) md.push('## Conclusions', '', r.conclusions, '');
  if (r.egress) {
    md.push('## Egress', '', `- allowed: ${r.egress.allowed}`, ...r.egress.denied.map((d) => `- denied: ${d.host} ×${d.count}`), '');
  }
  if (r.artifacts.screenshots.length) {
    md.push('## Screenshots', '', ...r.artifacts.screenshots.map((s) => `- [${s}](${s})`), '');
  }
  return `${md.join('\n')}\n`;
}

const CSS = `body{font-family:system-ui,-apple-system,sans-serif;max-width:1100px;margin:2em auto;padding:0 1em;color:#222}
h1{font-size:1.6em}.status-PASSED{color:#0a7a2f}.status-FAILED{color:#b00}.status-UNVERIFIED,.status-CANCELLED{color:#a60}
table{border-collapse:collapse;width:100%;margin:1em 0}td,th{border:1px solid #ddd;padding:.4em .6em;text-align:left;font-size:.9em}
video{width:100%;background:#000}section{margin:1.5em 0}.gallery{display:flex;flex-wrap:wrap;gap:8px}
.gallery img{max-width:240px;border:1px solid #ddd}.issue-high{border-left:4px solid #b00;padding:.3em .8em}
.issue-medium{border-left:4px solid #a60;padding:.3em .8em}.issue-low{border-left:4px solid #888;padding:.3em .8em}
code{background:#f4f4f4;padding:.1em .3em}`;

/** §15.6 report.html — self-contained, no scripts; every interpolated string escaped. */
export function renderReportHtml(r: ReportJson): string {
  const e = escapeHtml;
  const html: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${e(r.title)} — ${e(r.run_id)}</title>`,
    `<style>${CSS}</style>`,
    '</head><body>',
    `<h1>${e(r.title)}</h1>`,
    `<p><strong class="status-${e(r.status)}">${e(r.status)}</strong> — ${e(r.summary)}</p>`,
    `<p>Run <code>${e(r.run_id)}</code> · model <code>${e(r.model)}</code> · Chrome ${e(r.chrome_version)}<br>`,
    `Started ${e(r.timing.started_at)} · Ended ${e(r.timing.ended_at)} · Tokens ${r.tokens.input} in / ${r.tokens.output} out</p>`,
    '<section><h2>Instructions</h2>',
    `<p>${e(r.instructions)}</p></section>`,
    '<section><h2>Video</h2>',
    '<video controls src="final.mp4"><track kind="chapters" src="chapters.vtt" default></video>',
    `<p><a href="raw.mkv">raw.mkv</a> · <a href="chapters.vtt">chapters.vtt</a></p></section>`,
  ];
  if (r.plan) {
    html.push(
      `<section><h2>Plan: ${e(r.plan.title)}</h2><table><tr><th>Step</th><th>Intent</th><th>Expected</th><th>Outcome</th><th>Notes</th><th>Chapter</th></tr>`,
    );
    for (const s of r.plan.steps) {
      html.push(
        `<tr><td>${e(s.id)}</td><td>${e(s.intent)}</td><td>${e(s.expected)}</td><td>${e(s.outcome)}</td><td>${e(s.notes ?? '')}</td><td>${s.chapter_start !== null ? e(`${s.chapter_start}s`) : ''}</td></tr>`,
      );
    }
    html.push('</table>');
    html.push('<h3>Criteria</h3><table><tr><th>Id</th><th>Description</th><th>Status</th><th>Evidence</th></tr>');
    for (const c of r.plan.criteria) {
      html.push(
        `<tr><td>${e(c.id)}</td><td>${e(c.description)}</td><td>${e(c.verified ? 'VERIFIED' : c.evaluator_status)}</td><td>${e(c.evidence)}</td></tr>`,
      );
    }
    html.push('</table></section>');
  }
  if (r.issues.length) {
    html.push('<section><h2>Issues</h2>');
    for (const i of r.issues) {
      html.push(
        `<div class="issue-${e(i.severity)}"><strong>${e(i.severity)}</strong> ${e(i.title)}<br>${e(i.description)}${i.plan_step ? ` <em>${e(i.plan_step)}</em>` : ''}</div>`,
      );
    }
    html.push('</section>');
  }
  if (r.conclusions) html.push('<section><h2>Conclusions</h2>', `<p>${e(r.conclusions)}</p></section>`);
  if (r.artifacts.screenshots.length) {
    html.push('<section><h2>Screenshots</h2><div class="gallery">');
    for (const s of r.artifacts.screenshots) {
      html.push(`<a href="${e(s)}"><img src="${e(s)}" alt="${e(s)}" loading="lazy"></a>`);
    }
    html.push('</div></section>');
  }
  html.push('</body></html>');
  return html.join('\n');
}
