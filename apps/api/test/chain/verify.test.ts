import { describe, expect, it } from 'vitest';
import { usd } from '@vantra/shared';
import { createMemoryChain } from '../../src/chain/memory.js';
import { verifyUsdcTransfer } from '../../src/chain/verify.js';
import { isApiError } from '../../src/lib/errors.js';
import { silentLogger } from '../../src/lib/log.js';
import { testConfig } from './helpers.js';

const chain = createMemoryChain(testConfig(), silentLogger);
const owner = chain.newKeypair();
const agent = chain.newKeypair();

async function pay(amount: number): Promise<string> {
  await chain.faucet(owner.pubkey, amount, 'bank');
  return (await chain.transferUsdc(owner.secret, agent.pubkey, amount)).sig;
}

const expectInvalid = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toSatisfy((e) => isApiError(e) && e.status === 400 && e.code === 'INVALID_TX');
  await expect(p).rejects.toThrowError(re);
};

describe('chain/verify', () => {
  it('accepts a transfer that matches sender, recipient and amount', async () => {
    const sig = await pay(usd(10));
    const tx = await verifyUsdcTransfer(chain, sig, { to: agent.pubkey, from: owner.pubkey, minAmount: usd(10) });
    expect(tx).toMatchObject({ sig, from: owner.pubkey, to: agent.pubkey, amount: usd(10) });
  });

  it('accepts an overpayment and any sender when none is required', async () => {
    const sig = await pay(usd(12));
    await expect(verifyUsdcTransfer(chain, sig, { to: agent.pubkey, minAmount: usd(5) })).resolves.toMatchObject({ amount: usd(12) });
  });

  it('rejects an unknown or empty transaction hash', async () => {
    await expectInvalid(verifyUsdcTransfer(chain, '0xneverhappened', { to: agent.pubkey, minAmount: 1 }), /No confirmed USDC transfer/);
    await expectInvalid(verifyUsdcTransfer(chain, '   ', { to: agent.pubkey, minAmount: 1, what: 'escrow transfer' }), /escrow transfer transaction hash is missing/);
  });

  it('rejects the wrong recipient, the wrong sender and an underpayment', async () => {
    const sig = await pay(usd(1));
    const other = chain.newKeypair();
    await expectInvalid(verifyUsdcTransfer(chain, sig, { to: other.pubkey, minAmount: usd(1) }), /credited/);
    await expectInvalid(verifyUsdcTransfer(chain, sig, { to: agent.pubkey, from: other.pubkey, minAmount: usd(1) }), /was sent by/);
    await expectInvalid(verifyUsdcTransfer(chain, sig, { to: agent.pubkey, minAmount: usd(2) }), /moved \$1\.00, at least \$2\.00/);
  });

  it('shortens addresses so errors stay readable and leak nothing', async () => {
    const sig = await pay(usd(1));
    const other = chain.newKeypair();
    const err = await verifyUsdcTransfer(chain, sig, { to: other.pubkey, minAmount: usd(1) }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toContain(other.pubkey);
    expect(err?.message).toContain(other.pubkey.slice(0, 4));
  });
});
