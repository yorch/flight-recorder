import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Banner } from '../components/Panel.tsx';
import { apiGet, apiPostForm } from '../lib/api.ts';
import { nav } from '../lib/router.ts';

const INPUT_TYPES = ['password', 'email', 'text'] as const;

const NETWORK_HINTS = {
  limited: 'The browser reaches only the start URL and the allowed origins/hosts, through the proxy.',
  full: 'Every site is reachable, still only through the proxy. Nothing bypasses it.',
  offline: 'No browser egress at all. Every request is denied at the proxy.',
} as const;
type NetworkPreset = keyof typeof NETWORK_HINTS;
const NETWORK_LABEL: Record<NetworkPreset, string> = { limited: 'Limited', full: 'Full', offline: 'Offline' };

interface CredSel {
  name: string;
  enabled: boolean;
  input_types: Set<string>;
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

function Section({ n, title, hint, children }: { n: string; title: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="brief-section">
      <legend>
        <span className="brief-n">{n}</span>
        {title}
      </legend>
      <p className="hint">{hint}</p>
      {children}
    </fieldset>
  );
}

function Pre({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) {
  return (
    <div className="pre-row" data-tone={tone}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

/** §16.3 new-run form → multipart POST /api/runs (§16.2), with a live preflight summary. */
export function NewRun() {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [creds, setCreds] = useState<CredSel[]>([]);
  const [hosts, setHosts] = useState('');
  const [origins, setOrigins] = useState('');
  const [maxSteps, setMaxSteps] = useState('');
  const [timeoutS, setTimeoutS] = useState('');
  const [network, setNetwork] = useState<NetworkPreset>('limited');
  const [reviewPlan, setReviewPlan] = useState(false);
  const [stubScript, setStubScript] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    void apiGet<{ models: string[] }>('/api/models')
      .then((m) => {
        setModels(m.models);
        setModel((cur) => cur || (m.models.includes('stub') ? 'stub' : (m.models[0] ?? '')));
      })
      .catch((err: Error) => setError(err.message));
    void apiGet<{ secrets: string[] }>('/api/secrets')
      .then((s) => setCreds(s.secrets.map((name) => ({ name, enabled: false, input_types: new Set<string>() }))))
      .catch((err: Error) => setError(err.message));
  }, []);

  const isStub = model === 'stub' || model.startsWith('stub/');

  const setCred = (i: number, patch: Partial<CredSel>) => setCreds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!instructions.trim()) {
      setError('Describe the test goal before starting a run.');
      return;
    }
    if (isStub && stubScript.trim()) {
      try {
        JSON.parse(stubScript);
      } catch {
        setError('Stub script must be valid JSON.');
        return;
      }
    }
    setBusy(true);
    try {
      const fd = new FormData();
      if (title.trim()) fd.set('title', title.trim());
      fd.set('instructions', instructions);
      fd.set('start_url', startUrl);
      fd.set('model', model);
      if (hosts.trim()) fd.set('allowed_hosts', hosts.trim());
      if (origins.trim()) fd.set('allowed_origins', origins.trim());
      if (maxSteps.trim()) fd.set('max_steps', maxSteps.trim());
      if (timeoutS.trim()) fd.set('timeout_s', timeoutS.trim());
      if (reviewPlan) fd.set('review_plan', 'true');
      fd.set('network', network);
      const chosen = creds.filter((c) => c.enabled);
      if (chosen.length) fd.set('credentials', JSON.stringify(chosen.map((c) => ({ name: c.name, input_types: [...c.input_types] }))));
      if (isStub && stubScript.trim()) fd.set('stub_script', stubScript);
      if (files) for (const f of files) fd.append('assets', f, f.name);
      const res = await apiPostForm<{ run_id: string }>('/api/runs', fd);
      nav(`/run/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Cmd/Ctrl+Enter submits from anywhere in the brief.
  const onKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.current?.requestSubmit();
    }
  };

  const missingTypes = creds.filter((c) => c.enabled && c.input_types.size === 0).map((c) => c.name);
  const chosenCreds = creds.filter((c) => c.enabled);
  const startOrigin = originOf(startUrl);
  const extraHosts = hosts.split(',').filter((h) => h.trim()).length;
  const extraOrigins = origins.split(',').filter((o) => o.trim()).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Mission brief</p>
          <h1>New run</h1>
          <p className="lede">Describe the goal. The agent plans, drives a sandboxed browser, and the harness decides the verdict.</p>
        </div>
      </header>
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="brief">
        <form ref={form} onSubmit={submit} onKeyDown={onKey} className="brief-form">
          <Section n="01" title="Test goal" hint="Be specific about the actions and what a successful result looks like.">
            <div className="field">
              <label htmlFor="f-title">Title</label>
              <input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short label (optional)" />
            </div>
            <div className="field">
              <label htmlFor="f-instructions">Instructions</label>
              <textarea
                id="f-instructions"
                aria-describedby="instructions-hint"
                required
                rows={6}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="What the agent should do and verify"
              />
              <p id="instructions-hint" className="hint">
                Include the workflow, expected results, and any conditions the agent should verify.
              </p>
            </div>
            <div className="grid2">
              <div className="field">
                <label htmlFor="f-start">Start URL</label>
                <input
                  id="f-start"
                  required
                  type="url"
                  className="mono"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://…"
                />
              </div>
              <div className="field">
                <label htmlFor="f-model">Model</label>
                <select id="f-model" required className="mono" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {models.length === 0 && <option value={model || 'stub'}>{model || 'stub'}</option>}
                </select>
              </div>
            </div>
            {isStub && (
              <div className="field">
                <label htmlFor="f-stub">Stub script (JSON)</label>
                <textarea
                  id="f-stub"
                  rows={6}
                  className="mono code"
                  value={stubScript}
                  onChange={(e) => setStubScript(e.target.value)}
                  placeholder='{"turns":[…]}; empty uses a trivial done script'
                />
              </div>
            )}
          </Section>

          <Section n="02" title="Access" hint="Credentials are bound to input types: the agent can only type a secret into those fields.">
            {creds.length === 0 ? (
              <p className="hint">No credentials in ./secrets.</p>
            ) : (
              <table className="cred-matrix" aria-label="Credentials">
                <thead>
                  <tr>
                    <th>Secret</th>
                    {INPUT_TYPES.map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {creds.map((c, i) => (
                    <tr key={c.name} className={c.enabled ? 'on' : ''}>
                      <td>
                        <label className="check mono">
                          <input
                            type="checkbox"
                            data-cred={c.name}
                            checked={c.enabled}
                            onChange={(e) => setCred(i, { enabled: e.target.checked })}
                          />
                          {c.name}
                        </label>
                      </td>
                      {INPUT_TYPES.map((t) => (
                        <td key={t}>
                          <input
                            type="checkbox"
                            aria-label={`${c.name} may fill ${t} fields`}
                            data-cred={`${c.name}:${t}`}
                            disabled={!c.enabled}
                            checked={c.input_types.has(t)}
                            onChange={(e) => {
                              const s = new Set(c.input_types);
                              if (e.target.checked) s.add(t);
                              else s.delete(t);
                              setCred(i, { input_types: s });
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {missingTypes.length > 0 && <p className="hint warn">Select at least one input type for: {missingTypes.join(', ')}</p>}
            <div className="field">
              <label htmlFor="f-network">Network access</label>
              <select id="f-network" value={network} onChange={(e) => setNetwork(e.target.value as NetworkPreset)}>
                <option value="limited">Limited: allowlist (default)</option>
                <option value="full">Full: all sites via proxy</option>
                <option value="offline">Offline: no browser egress</option>
              </select>
              <p className="hint">{NETWORK_HINTS[network]}</p>
            </div>
            <div className="grid2">
              <div className="field">
                <label htmlFor="f-hosts">Extra allowed hosts</label>
                <input
                  id="f-hosts"
                  className="mono"
                  value={hosts}
                  onChange={(e) => setHosts(e.target.value)}
                  placeholder="host:port, host2:443"
                />
              </div>
              <div className="field">
                <label htmlFor="f-origins">Extra allowed origins</label>
                <input
                  id="f-origins"
                  className="mono"
                  value={origins}
                  onChange={(e) => setOrigins(e.target.value)}
                  placeholder="https://app.example"
                />
              </div>
            </div>
          </Section>

          <Section n="03" title="Execution" hint="Leave budgets empty to use platform defaults. Upload any files the test needs.">
            <div className="grid3">
              <div className="field">
                <label htmlFor="f-steps">Max steps</label>
                <input
                  id="f-steps"
                  type="number"
                  min={1}
                  className="mono"
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                  placeholder="default"
                />
              </div>
              <div className="field">
                <label htmlFor="f-timeout">Timeout (s)</label>
                <input
                  id="f-timeout"
                  type="number"
                  min={1}
                  className="mono"
                  value={timeoutS}
                  onChange={(e) => setTimeoutS(e.target.value)}
                  placeholder="default"
                />
              </div>
              <div className="field">
                <label htmlFor="f-assets">Assets</label>
                <input id="f-assets" type="file" multiple onChange={(e) => setFiles(e.target.files)} />
              </div>
            </div>
            <label className="check gate">
              <input id="f-review" type="checkbox" checked={reviewPlan} onChange={(e) => setReviewPlan(e.target.checked)} />
              <span className="gate-text">
                <strong>Review plan before executing</strong>
                <span className="hint">The run pauses after planning until you approve or reject the plan.</span>
              </span>
            </label>
          </Section>

          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={busy || missingTypes.length > 0}>
              {busy ? 'Submitting…' : 'Start run'}
            </button>
            <a className="btn ghost" href="#/">
              Back to runs
            </a>
            <span className="hint">
              <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> to start
            </span>
          </div>
        </form>

        <aside className="preflight" aria-label="Preflight summary">
          <h2>Preflight</h2>
          <dl>
            <Pre k="title" v={title.trim() || '(from plan)'} />
            <Pre k="model" v={model || '—'} />
            <Pre k="start" v={startOrigin || (startUrl ? 'invalid URL' : '—')} tone={startUrl && !startOrigin ? 'bad' : undefined} />
            <Pre k="network" v={NETWORK_LABEL[network]} tone={network === 'full' ? 'warn' : undefined} />
            <Pre k="allowlist" v={network === 'limited' ? `start + ${extraOrigins} origin(s) + ${extraHosts} host(s)` : 'n/a'} />
            <Pre
              k="secrets"
              v={chosenCreds.length ? chosenCreds.map((c) => `${c.name}[${[...c.input_types].join(',') || '?'}]`).join(' ') : 'none'}
              tone={missingTypes.length ? 'bad' : undefined}
            />
            <Pre k="max steps" v={maxSteps || 'default'} />
            <Pre k="timeout" v={timeoutS ? `${timeoutS}s` : 'default'} />
            <Pre k="assets" v={files?.length ? `${files.length} file(s)` : 'none'} />
            <Pre k="plan gate" v={reviewPlan ? 'manual approval' : 'auto-approve'} tone={reviewPlan ? 'warn' : undefined} />
            {isStub && <Pre k="stub" v={stubScript.trim() ? `${stubScript.length} chars` : 'trivial done'} />}
          </dl>
          <p className="hint">
            Recorded: screen video, event timeline, screenshots, transcript and network. The harness, not the agent, decides pass/fail.
          </p>
        </aside>
      </div>
    </div>
  );
}
