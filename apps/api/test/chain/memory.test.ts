import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { usd } from '@vantra/shared';
import { isChainError } from '../../src/chain/errors.js';
import { MEMORY_GENESIS_FROM, createMemoryChain, type MemoryChain } from '../../src/chain/memory.js';
import { silentLogger } from '../../src/lib/log.js';
import { fixedClock, testConfig } from './helpers.js';

const TREASURY_USD = 500;

function chainWith(env: Record<string, string> = {}): { chain: MemoryChain; treasury: string; escrow: string } {
  const config = testConfig({ DEMO_TREASURY_USD: String(TREASURY_USD), ...env });
  const chain = createMemoryChain(config, silentLogger);
  return { chain, treasury: chain.wallets.treasury.pubkey, escrow: chain.wallets.escrow.pubkey };
}

describe('chain/memory', () => {
  it('funds the treasury wallet with DEMO_TREASURY_USD and a gas balance', async () => {
    const { chain, treasury } = chainWith();
    expect(await chain.getUsdcBalance(treasury)).toBe(usd(TREASURY_USD));
    expect(await chain.getEthBalance(treasury)).toBeGreaterThan(0);
    expect(chain.mode).toBe('memory');
    expect(chain.cluster).toBe('memory');
  });

  it('derives stable treasury and escrow wallets from KEY_ENCRYPTION_KEY', () => {
    expect(chainWith().treasury).toBe(chainWith().treasury);
    expect(chainWith().treasury).not.toBe(chainWith().escrow);
  });

  it('skips genesis funding when DEMO_TREASURY_USD is 0', async () => {
    const { chain, treasury } = chainWith({ DEMO_TREASURY_USD: '0' });
    expect(await chain.getUsdcBalance(treasury)).toBe(0);
    expect(await chain.listUsdcInflows(treasury, null)).toEqual([]);
  });

  it('mints fresh keys whose public identity is an EIP-55 address', () => {
    const { chain } = chainWith();
    const a = chain.newKeypair();
    const b = chain.newKeypair();
    expect(a.secret).toHaveLength(32);
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(privateKeyToAccount(toHex(a.secret)).address).toBe(a.pubkey);
  });

  it('transfers USDC between wallets and records the transaction', async () => {
    const { chain, treasury } = chainWith();
    const agent = chain.newKeypair();
    const { sig } = await chain.transferUsdc(chain.wallets.treasury.secret, agent.pubkey, usd(10), 'VANTRA seed');

    expect(await chain.getUsdcBalance(agent.pubkey)).toBe(usd(10));
    expect(await chain.getUsdcBalance(treasury)).toBe(usd(TREASURY_USD - 10));
    const tx = await chain.getUsdcTransfer(sig);
    expect(tx).toMatchObject({ sig, from: treasury, to: agent.pubkey, amount: usd(10) });
    expect(await chain.getUsdcTransfer('sim-unknown')).toBeNull();
  });

  it('transfers ETH and reports gwei balances', async () => {
    const { chain, treasury } = chainWith();
    const agent = chain.newKeypair();
    const before = await chain.getEthBalance(treasury);
    await chain.transferEth(chain.wallets.treasury.secret, agent.pubkey, 5_000_000);
    expect(await chain.getEthBalance(agent.pubkey)).toBe(5_000_000);
    expect(await chain.getEthBalance(treasury)).toBe(before - 5_000_000);
  });

  it('refuses overdrafts and invalid amounts without moving money', async () => {
    const { chain, treasury } = chainWith();
    const agent = chain.newKeypair();
    await expect(chain.transferUsdc(agent.secret, treasury, usd(1))).rejects.toSatisfy((e) => isChainError(e, 'insufficient_funds'));
    for (const bad of [0, -1, 1.5]) {
      await expect(chain.transferUsdc(chain.wallets.treasury.secret, agent.pubkey, bad)).rejects.toSatisfy((e) => isChainError(e, 'invalid_amount'));
    }
    await expect(chain.transferUsdc(chain.wallets.treasury.secret, '', usd(1))).rejects.toSatisfy((e) => isChainError(e, 'invalid_address'));
    expect(await chain.getUsdcBalance(treasury)).toBe(usd(TREASURY_USD));
  });

  it('lists inflows newest first and only for the given wallet', async () => {
    const { chain, treasury } = chainWith();
    const agent = chain.newKeypair();
    await chain.transferUsdc(chain.wallets.treasury.secret, agent.pubkey, usd(10), 'seed');
    await chain.faucet(agent.pubkey, usd(3), 'customer-1');
    await chain.faucet(agent.pubkey, usd(4), 'customer-2');
    await chain.faucet('someone-else', usd(9), 'customer-3');

    const inflows = await chain.listUsdcInflows(agent.pubkey, null);
    expect(inflows.map((i) => [i.from, i.amount])).toEqual([
      ['customer-2', usd(4)],
      ['customer-1', usd(3)],
      [treasury, usd(10)],
    ]);
    expect(inflows.every((i) => i.ts instanceof Date)).toBe(true);
    // outbound transfers are not inflows
    await chain.transferUsdc(agent.secret, treasury, usd(1));
    expect(await chain.listUsdcInflows(agent.pubkey, null)).toHaveLength(3);
  });

  it('returns only inflows newer than sinceSig', async () => {
    const { chain } = chainWith();
    const agent = chain.newKeypair();
    const first = await chain.faucet(agent.pubkey, usd(1), 'customer-1');
    await chain.faucet(agent.pubkey, usd(2), 'customer-2');

    expect((await chain.listUsdcInflows(agent.pubkey, first.sig)).map((i) => i.amount)).toEqual([usd(2)]);
    const second = (await chain.listUsdcInflows(agent.pubkey, null))[0]!;
    expect(await chain.listUsdcInflows(agent.pubkey, second.sig)).toEqual([]);
    // an unknown cursor (pruned history) replays everything rather than skipping deposits
    expect(await chain.listUsdcInflows(agent.pubkey, 'simGone')).toHaveLength(2);
  });

  it('returns the OLDEST page when more inflows exist than the limit', async () => {
    const { chain } = chainWith();
    const agent = chain.newKeypair();
    for (let i = 1; i <= 5; i++) await chain.faucet(agent.pubkey, usd(i), `customer-${i}`);

    const page = await chain.listUsdcInflows(agent.pubkey, null, 2);
    expect(page.map((i) => i.amount)).toEqual([usd(2), usd(1)]);      // newest first within the oldest page
    const next = await chain.listUsdcInflows(agent.pubkey, page[0]!.sig, 2);
    expect(next.map((i) => i.amount)).toEqual([usd(4), usd(3)]);      // cursor advances without skipping
  });

  it('faucets external customer USDC and ETH', async () => {
    const { chain } = chainWith();
    const agent = chain.newKeypair();
    const { sig } = await chain.faucet(agent.pubkey, usd(2.5), 'customer-7');
    expect(await chain.getUsdcBalance(agent.pubkey)).toBe(usd(2.5));
    expect(await chain.getUsdcTransfer(sig)).toMatchObject({ from: 'customer-7', to: agent.pubkey, amount: usd(2.5) });
    await chain.faucetEth(agent.pubkey, 1_000);
    expect(await chain.getEthBalance(agent.pubkey)).toBe(1_000);
    expect((await chain.listUsdcInflows(chain.wallets.treasury.pubkey, null))[0]!.from).toBe(MEMORY_GENESIS_FROM);
  });

  it('serves arbitrary ERC-20 balances through getTokenBalance, and USDC through the token address it knows', async () => {
    const { chain } = chainWith();
    const mint = 'SomeMint111111111111111111111111111111111';
    const holder = chain.newKeypair().pubkey;
    expect(await chain.getTokenBalance(holder, mint)).toBe(0);
    chain.setTokenBalance(holder, mint, 250_000_000_000);
    expect(await chain.getTokenBalance(holder, mint)).toBe(250_000_000_000);
    expect(await chain.getTokenBalance(chain.wallets.treasury.pubkey, chain.usdcMint)).toBe(usd(TREASURY_USD));
  });

  // The purchase sweep (SPEC-V2 §5.6): one transaction, several legs, the payer covers the fees.
  describe('sweepUsdc / sweepEth', () => {
    it('splits a deposit between the founder fee and the treasury under one signature', async () => {
      const { chain, treasury } = chainWith();
      const deposit = chain.newKeypair();
      const founder = chain.wallets.founderFee;
      await chain.faucet(deposit.pubkey, usd(25), 'exchange-withdrawal');

      const { sig } = await chain.sweepUsdc(deposit.secret, chain.wallets.treasury.secret, [
        { to: founder, amount: usd(2.5) },
        { to: treasury, amount: usd(22.5) },
      ], 'VANTRA pu_test');

      expect(await chain.getUsdcBalance(deposit.pubkey)).toBe(0);
      expect(await chain.getUsdcBalance(founder)).toBe(usd(2.5));
      expect(await chain.getUsdcBalance(treasury)).toBe(usd(TREASURY_USD + 22.5));
      const legs = await chain.listUsdcInflows(treasury, null, 5);
      expect(legs[0]).toMatchObject({ sig, from: deposit.pubkey, amount: usd(22.5) });
    });

    it('skips zero-amount legs so a fee that rounds to nothing is not an error', async () => {
      const { chain, treasury } = chainWith();
      const deposit = chain.newKeypair();
      await chain.faucet(deposit.pubkey, usd(10), 'buyer');
      await chain.sweepUsdc(deposit.secret, chain.wallets.treasury.secret, [
        { to: chain.wallets.founderFee, amount: 0 },
        { to: treasury, amount: usd(10) },
      ]);
      expect(await chain.getUsdcBalance(chain.wallets.founderFee)).toBe(0);
      expect(await chain.getUsdcBalance(deposit.pubkey)).toBe(0);
    });

    it('moves a named number of gwei, or the whole balance when null', async () => {
      const { chain, treasury } = chainWith();
      const deposit = chain.newKeypair();
      await chain.faucetEth(deposit.pubkey, 3_000_000_000);
      const before = await chain.getEthBalance(treasury);

      await chain.sweepEth(deposit.secret, chain.wallets.treasury.secret, treasury, 1_000_000_000);
      expect(await chain.getEthBalance(deposit.pubkey)).toBe(2_000_000_000);
      await chain.sweepEth(deposit.secret, chain.wallets.treasury.secret, treasury, null);
      expect(await chain.getEthBalance(deposit.pubkey)).toBe(0);
      expect(await chain.getEthBalance(treasury)).toBe(before + 3_000_000_000);
    });

    it('refuses to sweep an empty address rather than pretending it worked', async () => {
      const { chain, treasury } = chainWith();
      const deposit = chain.newKeypair();
      await expect(chain.sweepEth(deposit.secret, chain.wallets.treasury.secret, treasury, null))
        .rejects.toSatisfy((e) => isChainError(e, 'insufficient_funds'));
      await expect(chain.sweepUsdc(deposit.secret, chain.wallets.treasury.secret, [{ to: treasury, amount: usd(1) }]))
        .rejects.toSatisfy((e) => isChainError(e, 'insufficient_funds'));
    });
  });

  it('reports the configured ETH price and stamps transactions with the injected clock', async () => {
    const config = testConfig({ ETH_PRICE_USD: '210.5' });
    const clock = fixedClock(new Date('2026-01-02T03:04:05.000Z'));
    const chain = createMemoryChain(config, silentLogger, { clock });
    expect(await chain.ethPriceUsd()).toBe(210.5);

    const agent = chain.newKeypair();
    await chain.faucet(agent.pubkey, usd(1), 'customer-1');
    clock.set(new Date('2026-01-03T00:00:00.000Z'));
    await chain.faucet(agent.pubkey, usd(1), 'customer-2');
    const [newest, oldest] = await chain.listUsdcInflows(agent.pubkey, null);
    expect(oldest!.ts.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(newest!.ts.toISOString()).toBe('2026-01-03T00:00:00.000Z');

    chain.useClock(fixedClock(new Date('2026-02-01T00:00:00.000Z')));
    const later = await chain.faucet(agent.pubkey, usd(1), 'customer-3');
    expect((await chain.getUsdcTransfer(later.sig))!.ts.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});
