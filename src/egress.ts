export interface AccessLogEntry {
  epoch_s: number;
  client: string;
  listen: string;
  method: string;
  url: string;
  status: number;
  result: string;
}

export interface EgressSummary {
  allowed: number;
  denied: { host: string; count: number }[];
}

/** Parses one line of the Squid access log: "%ts.%03tu %>a %>la:%>lp %rm %ru %>Hs %Ss". */
export function parseAccessLogLine(line: string): AccessLogEntry | null {
  const m = /^(\d+(?:\.\d+)?)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)/.exec(line);
  if (!m) return null;
  return { epoch_s: Number(m[1]), client: m[2], listen: m[3], method: m[4], url: m[5], status: Number(m[6]), result: m[7] };
}

/** host:port of a request target; CONNECT lines are already host:port, others come from the URL. */
export function targetHostPort(entry: AccessLogEntry): string {
  const u = entry.url;
  if (u.includes('://')) {
    try {
      const url = new URL(u);
      return url.port ? `${url.hostname}:${url.port}` : `${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`;
    } catch {
      return u;
    }
  }
  return u;
}

export function summarizeAccessLog(text: string): EgressSummary {
  const denied = new Map<string, number>();
  let allowed = 0;
  for (const line of text.split('\n')) {
    const e = parseAccessLogLine(line);
    if (!e) continue;
    if (e.result.startsWith('TCP_DENIED')) {
      const host = targetHostPort(e);
      denied.set(host, (denied.get(host) ?? 0) + 1);
    } else {
      allowed += 1;
    }
  }
  return {
    allowed,
    denied: [...denied.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
  };
}
