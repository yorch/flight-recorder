import fs from 'node:fs';
import path from 'node:path';
import type { TestSpec } from './config.ts';

export class SecretBindingError extends Error {}

const registry = new Map<string, string>();

/** Loads /run/secrets/<NAME> values (dir configurable via env SECRETS_DIR) into the process registry. */
export function loadSecrets(names: string[], dir = process.env.SECRETS_DIR ?? '/run/secrets'): Map<string, string> {
  registry.clear();
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new SecretBindingError(`Missing secret file: ${file}`);
    registry.set(name, fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''));
  }
  return new Map(registry);
}

export type SecretTarget = { origin: string; inputType: string };

/**
 * Replaces {{secret:NAME}} placeholders in `text` with values, enforcing the §6.5 binding:
 * the secret must be declared in spec.secrets and the target's origin and input type must
 * both appear in its binding. Any violation throws SecretBindingError.
 */
export function resolvePlaceholders(text: string, spec: TestSpec, target: SecretTarget): string {
  return text.replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_whole, name: string) => {
    const binding = spec.secrets?.[name];
    if (!binding) throw new SecretBindingError(`Undeclared secret: ${name}`);
    if (!registry.has(name)) throw new SecretBindingError(`Secret not loaded: ${name}`);
    if (!binding.origins.includes(target.origin)) {
      throw new SecretBindingError(`Secret ${name} may not be typed into origin ${target.origin}`);
    }
    if (!binding.input_types.includes(target.inputType)) {
      throw new SecretBindingError(`Secret ${name} may not be typed into input type ${target.inputType}`);
    }
    const value = registry.get(name);
    if (value === undefined) throw new SecretBindingError(`Secret not loaded: ${name}`);
    return value;
  });
}

/** Replaces every loaded secret value (longest first) with its {{secret:NAME}} placeholder. */
export function redact(s: string): string {
  let out = s;
  for (const [name, value] of [...registry.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (value) out = out.split(value).join(`{{secret:${name}}}`);
  }
  return out;
}

/** Test hook: clears the registry between unit tests. */
export function _resetSecrets(): void {
  registry.clear();
}
