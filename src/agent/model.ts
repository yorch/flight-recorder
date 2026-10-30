import type { Config } from '../config.ts';
import type { ModelClient } from './contract.ts';
import { AnthropicClient } from './providers/anthropic.ts';
import { OpenAIClient } from './providers/openai.ts';
import { StubClient } from './providers/stub.ts';

export function createModel(cfg: Config): ModelClient {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicClient({ model: cfg.model });
    case 'openai':
      return new OpenAIClient({ model: cfg.model });
    case 'stub':
      return new StubClient({ scriptPath: cfg.model, screen: cfg.screen });
    default:
      throw new Error(`Unknown AGENT_MODEL provider: ${cfg.provider}`);
  }
}
