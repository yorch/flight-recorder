export class BudgetExceeded extends Error {}

export type TokenUsage = { input_tokens: number; output_tokens: number };

export class Budget {
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly startMs: number;
  private readonly now: () => number;
  private tokens = 0;
  private inTokens = 0;
  private outTokens = 0;

  constructor(opts: { timeout_s?: number; max_model_tokens?: number; now?: () => number }) {
    this.timeoutMs = (opts.timeout_s ?? 600) * 1000;
    this.maxTokens = opts.max_model_tokens ?? 500_000;
    this.now = opts.now ?? (() => Date.now());
    this.startMs = this.now();
  }

  check(): void {
    const elapsed = this.now() - this.startMs;
    if (elapsed > this.timeoutMs) throw new BudgetExceeded(`timeout_s exceeded: ${Math.round(elapsed)}ms > ${this.timeoutMs}ms`);
    if (this.tokens > this.maxTokens) throw new BudgetExceeded(`max_model_tokens exceeded: ${this.tokens} > ${this.maxTokens}`);
  }

  addTokens(usage: TokenUsage): void {
    this.tokens += usage.input_tokens + usage.output_tokens;
    this.inTokens += usage.input_tokens;
    this.outTokens += usage.output_tokens;
  }

  get totalTokens(): number {
    return this.tokens;
  }

  get usage(): { input: number; output: number } {
    return { input: this.inTokens, output: this.outTokens };
  }
}
