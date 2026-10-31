import { useEffect, useState } from 'react';
import { apiGet, apiPostForm } from '../lib/api.ts';
import { nav } from '../lib/router.ts';

const INPUT_TYPES = ['password', 'email', 'text'] as const;

interface CredSel {
  name: string;
  enabled: boolean;
  input_types: Set<string>;
}

/** §16.3 new-run form → multipart POST /api/runs (§16.2). */
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
  const [reviewPlan, setReviewPlan] = useState(false);
  const [stubScript, setStubScript] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<{ models: string[] }>('/api/models').then((m) => {
      setModels(m.models);
      setModel((cur) => cur || (m.models.includes('stub') ? 'stub' : (m.models[0] ?? '')));
    });
    void apiGet<{ secrets: string[] }>('/api/secrets').then((s) =>
      setCreds(s.secrets.map((name) => ({ name, enabled: false, input_types: new Set<string>() }))),
    );
  }, []);

  const isStub = model === 'stub' || model.startsWith('stub/');

  const setCred = (i: number, patch: Partial<CredSel>) => setCreds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
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

  const missingTypes = creds.filter((c) => c.enabled && c.input_types.size === 0).map((c) => c.name);

  return (
    <section className="form-page">
      <h2>New run</h2>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="f-title">Title</label>
          <input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short label (optional)" />
        </div>
        <div className="field">
          <label htmlFor="f-instructions">Instructions</label>
          <textarea
            id="f-instructions"
            required
            rows={5}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="what the agent should do and verify"
          />
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="f-start">Start URL</label>
            <input
              id="f-start"
              required
              type="url"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="field">
            <label htmlFor="f-model">Model</label>
            <select id="f-model" required value={model} onChange={(e) => setModel(e.target.value)}>
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
              className="mono"
              value={stubScript}
              onChange={(e) => setStubScript(e.target.value)}
              placeholder='{"turns":[…]} — empty uses a trivial done script'
            />
          </div>
        )}
        <fieldset>
          <legend>Credentials</legend>
          {creds.length === 0 && <p className="muted">no credentials in ./secrets</p>}
          {creds.map((c, i) => (
            <div className="cred row" key={c.name}>
              <label>
                <input type="checkbox" data-cred={c.name} checked={c.enabled} onChange={(e) => setCred(i, { enabled: e.target.checked })} />{' '}
                {c.name}
              </label>
              {INPUT_TYPES.map((t) => (
                <label key={t} className="muted">
                  <input
                    type="checkbox"
                    data-cred={`${c.name}:${t}`}
                    disabled={!c.enabled}
                    checked={c.input_types.has(t)}
                    onChange={(e) => {
                      const s = new Set(c.input_types);
                      if (e.target.checked) s.add(t);
                      else s.delete(t);
                      setCred(i, { input_types: s });
                    }}
                  />{' '}
                  {t}
                </label>
              ))}
            </div>
          ))}
          {missingTypes.length > 0 && <p className="warn small">select at least one input type for: {missingTypes.join(', ')}</p>}
        </fieldset>
        <div className="grid2">
          <div className="field">
            <label htmlFor="f-hosts">Extra allowed hosts</label>
            <input id="f-hosts" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="host:port, host2:443" />
          </div>
          <div className="field">
            <label htmlFor="f-origins">Extra allowed origins</label>
            <input id="f-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://app.example" />
          </div>
        </div>
        <div className="grid3">
          <div className="field">
            <label htmlFor="f-steps">Max steps</label>
            <input
              id="f-steps"
              type="number"
              min={1}
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
        <div className="field row">
          <label>
            <input id="f-review" type="checkbox" checked={reviewPlan} onChange={(e) => setReviewPlan(e.target.checked)} /> Review plan
            before executing
          </label>
        </div>
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || missingTypes.length > 0}>
            {busy ? 'Submitting…' : 'Start run'}
          </button>
          <a className="btn" href="#/">
            Back
          </a>
        </div>
      </form>
    </section>
  );
}
