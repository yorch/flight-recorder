import { execFileSync } from 'node:child_process';
import dns from 'node:dns';

const out = {};
const tryFetch = async (u) => {
  try {
    const r = await fetch(u);
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};
out.dns_example = await new Promise((r) => dns.lookup('example.com', (e) => r(e ? String(e.code ?? e) : 'resolved')));
out.dns_sites = await new Promise((r) => dns.lookup('app.test', (e) => r(e ? String(e.code ?? e) : 'resolved')));
try {
  execFileSync('node', ['-e', `fetch('http://app.test/login').then(()=>process.exit(0)).catch(()=>process.exit(1))`], {
    env: { PATH: process.env.PATH },
    timeout: 8000,
  });
  out.noproxy_fetch = 'succeeded';
} catch {
  out.noproxy_fetch = 'failed';
}
out.llm_via_agent_port = await tryFetch('http://llm.test/agent?k=agent_ok');
out.app_via_agent_port = await tryFetch('http://app.test/x?k=agent_to_allowed');
try {
  execFileSync('sh', ['-c', `timeout 3 bash -c '</dev/tcp/${process.env.SITES_IP}/80'`], { shell: false });
  out.tcp_egress_ip = 'connected';
} catch {
  out.tcp_egress_ip = 'unreachable';
}
console.log(`EGRESS_RESULT ${JSON.stringify(out)}`);
