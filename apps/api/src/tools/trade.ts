// trade: buy or sell an allowlisted token from the agent's own wallet (USDC is always the quote leg).
// The tool is thin on purpose — every guardrail (allowlist, max position, liquid reserve, 24h loss halt,
// gas check) lives in economy/trading.ts so it is enforced no matter how the model calls this. Buying
// converts liquid USDC into a tracked position; selling realizes P&L back into the treasury.
import { z } from 'zod';
import type { CoreDeps } from '../core/interfaces.js';
import { fail, ok } from './common.js';
import type { PortResolver } from './ports.js';
import { defineTool, type ToolSpec } from './spec.js';

export function tradeTools(_deps: CoreDeps, port: PortResolver): ToolSpec[] {
  const trade = defineTool({
    name: 'trade',
    description:
      `Buy or sell a token to grow your treasury. USDC is always the other side: "buy" spends your USDC on ` +
      `a token, "sell" turns a token back into USDC and realizes the profit or loss. Call it when you have a ` +
      `specific reason to expect a move — never to pass the time, and never with money you need for rent. ` +
      `You may only trade allowlisted tokens (e.g. ETH), one position per token, capped in size, and you must ` +
      `keep a liquid USDC reserve for rent — the platform enforces all of this and will refuse a trade that ` +
      `breaks a rule. The tool itself is free: the protocol meters no fee for calling it. The trade is not — ` +
      `your own wallet pays ETH for gas, and a bad trade shrinks your treasury and shortens your runway. ` +
      `Use "buy" with amountUsd to open or add to a position; "sell" with amountUsd for part, or omit it to ` +
      `sell the whole position. Check your positions and P&L in the wallet/status before trading.`,
    params: z.strictObject({
      action: z.enum(['buy', 'sell']).describe('"buy" (spend USDC on the token) or "sell" (token back to USDC).'),
      token: z.string().min(2).max(64).describe('Token symbol (e.g. "ETH") or 0x token address. Must be allowlisted.'),
      amountUsd: z.number().positive().optional().describe('USD to spend (buy) or to sell (sell). Omit on sell to sell the whole position.'),
    }),
    parallelSafe: false,
    summarize: (i) => `${i.action} ${i.token}${i.amountUsd ? ` $${i.amountUsd}` : ''}`,
    async run(ctx, input) {
      const res = await port('trading').execute({
        agentId: ctx.agent.id,
        action: input.action,
        token: input.token,
        amountUsd: input.amountUsd ?? null,
      });
      return res.ok ? ok(res.message, { event: { kind: 'update', text: `${ctx.agent.name}: ${res.message}` } }) : fail(res.message);
    },
  });

  return [trade];
}
