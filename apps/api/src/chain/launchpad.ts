// The Pons launchpad port (LaunchpadPort in core/interfaces.ts). Every Pons interaction a launched
// agent has — the launch call its dev signs, the proof that launch is what was agreed, the creator-tax
// escrow, the claim, the burn — goes through here, so CHAIN_MODE=memory is a complete fake and a demo
// never reads or writes mainnet.
//
// The trust guarantee lives in what this file CANNOT do: it never declares, encodes or sends the
// factory's fee-recipient transfer or its buyback toggle (see the note on ponsFactoryAbi in pons.ts).
// Once a coin launches with the agent as `creatorFeeRecipient`, nothing here can move that income.
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress, keccak256, parseEventLogs, toBytes, toHex, type Address, type Hex } from 'viem';
import { isEvmAddress, sameAddress, usd } from '@vantra/shared';
import type { Config } from '../config.js';
import type { LaunchCallParams, LaunchpadPort } from '../core/interfaces.js';
import { toChecksum } from '../lib/evm.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { createEvmTransactor, rhcChain } from './evm.js';
import { accountFromSecret, pubkeyOfSecret } from './keys.js';
import type { MemoryChain } from './memory.js';
import { withAddressLock } from './mutex.js';
import {
  PONS_FACTORY, PONS_FEE_ESCROW, PONS_LAUNCH_CONFIG_ID, PONS_TOKEN_SUPPLY, ZERO_ADDRESS, ponsFactoryAbi,
  ponsFeeEscrowAbi, ponsTokenAbi,
} from './pons.js';

export type { LaunchCallParams, LaunchpadPort } from '../core/interfaces.js';

export const WEI_PER_GWEI = 1_000_000_000n;
// Verified live on mainnet (launchpad spec §1); the memory fake answers with the same terms so the
// launch form shows the numbers a real launch would.
export const PONS_LAUNCH_FEE_WEI = 500_000_000_000_000n;   // 0.0005 ETH
export const PONS_MAX_CREATOR_TAX_BPS = 1_000;
// A memory-mode coin is priced as if its fully diluted value were this, so a $5 buyback retires 0.1%
// of supply — enough to watch the burn meter move in a demo.
export const MEMORY_LAUNCH_FDV_USD = 5_000;

type LaunchExpectation = Parameters<LaunchpadPort['verifyLaunch']>[1];
interface LaunchedToken { creatorFeeRecipient: string; creatorTaxBps: number; pairToken: string; exists: boolean }

// The factory reverts `CreatorTaxTooHigh` above its cap; the port refuses first, as a typed error. The
// encoder only checks the basis-point shape — the live cap is the service's check (maxCreatorTaxBps).
function assertCreatorTax(bps: number, max: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) {
    throw new ChainError('invalid_amount', `creator tax must be an integer 0-${max} bps, got ${bps}`);
  }
}

// `launchToken(params, 0, 0x0)` exactly as the dev's wallet will sign it. The agent wallet is the
// creator-fee recipient, buyback is off (Pons's buyback locks, VANTRA burns), and the salt is fixed per
// agent so one agent can never be the subject of two launches from the same dev. The dev is not in the
// calldata at all: the factory records `msg.sender` as the deployer.
function encodeLaunchCall(p: LaunchCallParams, expectedEconomics: Hex): Hex {
  assertCreatorTax(p.creatorTaxBps, 10_000);
  return encodeFunctionData({
    abi: ponsFactoryAbi,
    functionName: 'launchToken',
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        logo: p.logo,
        description: p.description,
        socials: p.socials,
        creatorFeeRecipient: toChecksum(p.agentWallet) as Address,
        creatorTaxBps: p.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics,
        salt: keccak256(toBytes(`vantra:${p.agentId}`)),
      },
      PONS_LAUNCH_CONFIG_ID,
      ZERO_ADDRESS,
    ],
  });
}

const mismatch = (field: string, actual: string | number, expected: string | number): ChainError =>
  new ChainError('launch_mismatch', `launch ${field} is ${actual}, expected ${expected}`);

// Checks 2 and 3 of "confirm must verify" (spec §5); check 1, the receipt, is each implementation's own.
// Shared so the fake and the real chain can never disagree about what counts as the agreed launch.
function assertAgreedLaunch(deployer: string, token: string, launched: LaunchedToken, expect: LaunchExpectation): void {
  if (!sameAddress(deployer, expect.devWallet)) throw mismatch('deployer', deployer, expect.devWallet);
  if (!launched.exists) throw mismatch(`record for ${token}`, 'missing', 'present');
  if (!sameAddress(launched.creatorFeeRecipient, expect.agentWallet)) {
    throw mismatch('creatorFeeRecipient', launched.creatorFeeRecipient, expect.agentWallet);
  }
  if (launched.creatorTaxBps !== expect.creatorTaxBps) throw mismatch('creatorTaxBps', launched.creatorTaxBps, expect.creatorTaxBps);
  if (!sameAddress(launched.pairToken, ZERO_ADDRESS)) throw mismatch('pairToken', launched.pairToken, ZERO_ADDRESS);
}

function assertBurnAmount(amount: bigint): void {
  if (amount <= 0n) throw new ChainError('invalid_amount', `burn amount must be positive, got ${amount}`);
}

// ---- Robinhood Chain ---------------------------------------------------------

export function createEvmLaunchpad(config: Config, log: Logger): LaunchpadPort {
  const { client, chain, rpc, send, sendUnlocked, landed } = createEvmTransactor(config.chain, log);

  // The escrow is `factory.feeEscrow()`, not the constant: if the factory is ever re-pointed the claim
  // must follow it. Memoised, and dropped again on failure so one flaky read does not poison the port.
  let escrowRead: Promise<Address> | null = null;
  const feeEscrow = (): Promise<Address> => (escrowRead ??= rpc('feeEscrow', () =>
    client.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'feeEscrow' }))
    .catch((e: unknown) => { escrowRead = null; throw e; }));

  const escrowBalanceWei = async (recipient: string): Promise<bigint> => {
    const escrow = await feeEscrow();
    return rpc('escrow.balanceOf', () => client.readContract({
      address: escrow, abi: ponsFeeEscrowAbi, functionName: 'balanceOf', args: [toChecksum(recipient) as Address],
    }));
  };

  return {
    launchFeeWei: () => rpc('launchFee', () => client.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'launchFee' })),
    async maxCreatorTaxBps() {
      return Number(await rpc('maxCreatorTaxBps', () => client.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'maxCreatorTaxBps' })));
    },
    // The terms are read live, in this call. `expectedEconomics` PINS them: if the launch config is
    // re-pegged between this read and the dev's signature, the launch reverts rather than pricing the
    // coin on terms nobody agreed to.
    async buildLaunchCall(p) {
      toChecksum(p.devWallet);   // the wallet that will sign; it must be one before any read is spent on it
      const [open, fee, expectedEconomics] = await Promise.all([
        rpc('launchEnabled', () => client.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'launchEnabled' })),
        rpc('launchFee', () => client.readContract({ address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'launchFee' })),
        rpc('previewLaunchEconomics', () => client.readContract({
          address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'previewLaunchEconomics', args: [PONS_LAUNCH_CONFIG_ID, ZERO_ADDRESS],
        })),
      ]);
      if (!open) throw new ChainError('launch_failed', 'the Pons launchpad is not accepting launches right now');
      return { to: PONS_FACTORY, data: encodeLaunchCall(p, expectedEconomics), value: fee, chainId: chain.id };
    },
    // The security boundary of a listing. A receipt that has not landed yet surfaces as `tx_failed`
    // (retryable); only a proven-bad launch is `launch_failed` / `launch_mismatch` (terminal).
    async verifyLaunch(txSig, expect) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txSig.trim())) throw new ChainError('launch_failed', `${txSig} is not a transaction hash`);
      const hash = txSig.trim().toLowerCase() as Hex;
      const receipt = await landed(hash, 'launch');
      if (receipt.status !== 'success') throw new ChainError('launch_failed', `launch ${hash} reverted on chain`);
      const event = parseEventLogs({ abi: ponsFactoryAbi, eventName: 'TokenLaunched', logs: receipt.logs })
        .find((l) => sameAddress(l.address, PONS_FACTORY));
      if (!event) throw new ChainError('launch_failed', `${hash} emitted no TokenLaunched event from the Pons factory`);
      const token = getAddress(event.args.token);
      const launched = await rpc('getLaunchedToken', () => client.readContract({
        address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token],
      }));
      assertAgreedLaunch(event.args.deployer, token, launched, expect);
      return { token, curve: getAddress(event.args.curve) };
    },
    escrowBalanceWei,
    // `claim()` credits msg.sender, so the agent signs it and pays its own gas. A sent transaction's
    // return value is unreadable, so the claimed amount is the wallet's balance delta with the claim's
    // own gas added back — measured under the wallet's nonce lock, so none of the agent's own sends can
    // land in between.
    async claimFees(agentSecret) {
      const account = accountFromSecret(agentSecret);
      const escrow = await feeEscrow();
      return withAddressLock(account.address, async () => {
        const [pending, before] = await Promise.all([
          escrowBalanceWei(account.address),
          rpc('getBalance', () => client.getBalance({ address: account.address })),
        ]);
        if (pending === 0n) throw new ChainError('insufficient_funds', `${account.address} has no creator fees in escrow`);
        const receipt = await sendUnlocked(account, 'fee claim', {
          to: escrow, data: encodeFunctionData({ abi: ponsFeeEscrowAbi, functionName: 'claim' }),
        });
        const after = await rpc('getBalance', () => client.getBalance({ address: account.address, blockNumber: receipt.blockNumber }));
        return { sig: receipt.transactionHash, claimedWei: after - before + receipt.gasUsed * receipt.effectiveGasPrice };
      });
    },
    async burn(agentSecret, token, amount) {
      assertBurnAmount(amount);
      const receipt = await send(accountFromSecret(agentSecret), 'burn', {
        to: toChecksum(token) as Address, data: encodeFunctionData({ abi: ponsTokenAbi, functionName: 'burn', args: [amount] }),
      });
      return { sig: receipt.transactionHash };
    },
    tokenBalance: (address, token) => rpc('token.balanceOf', () => client.readContract({
      address: toChecksum(token) as Address, abi: ponsTokenAbi, functionName: 'balanceOf', args: [toChecksum(address) as Address],
    })),
  };
}

// ---- memory -------------------------------------------------------------------

interface MemoryLaunch extends LaunchedToken { txSig: string; token: string; curve: string; deployer: string; name: string; symbol: string }

// The complete fake. Fee escrow: wei per recipient, credited by `creditEscrow` (the simulate-fees
// route) and claimed into the memory chain's own ETH store, so a claimed fee is spendable gas and
// swappable revenue exactly as on chain. Launched coins: `simulateLaunch` mints a deterministic token +
// curve and prices the token on the memory chain, so `chain.swap(usdc → token)` — the buyback leg —
// credits real memory-chain token units; `tokenBalance` and `burn` read and debit that same balance.
export function createMemoryLaunchpad(config: Config, chain: MemoryChain, log: Logger): LaunchpadPort {
  const escrow = new Map<string, bigint>();          // lower-cased recipient → wei
  const launchesBySig = new Map<string, MemoryLaunch>();
  const launchesByToken = new Map<string, MemoryLaunch>();
  const chainId = rhcChain(config.chain.cluster).id;
  const microPerBaseUnit = usd(MEMORY_LAUNCH_FDV_USD) / Number(PONS_TOKEN_SUPPLY);

  const tokenBalance = async (address: string, token: string): Promise<bigint> =>
    BigInt(await chain.getTokenBalance(toChecksum(address), toChecksum(token)));

  return {
    async launchFeeWei() { return PONS_LAUNCH_FEE_WEI; },
    async maxCreatorTaxBps() { return PONS_MAX_CREATOR_TAX_BPS; },
    // Never sent in memory mode (SIMULATE LAUNCH replaces the signature), but it is the same call a
    // real launch would produce, so the web can show it.
    async buildLaunchCall(p) {
      const expectedEconomics = keccak256(toBytes('vantra:memory:launch-economics'));
      return { to: PONS_FACTORY, data: encodeLaunchCall(p, expectedEconomics), value: PONS_LAUNCH_FEE_WEI, chainId };
    },
    async verifyLaunch(txSig, expect) {
      const launch = launchesBySig.get(txSig.trim().toLowerCase());
      if (!launch) throw new ChainError('launch_failed', `no launch transaction ${txSig} on the memory chain`);
      assertAgreedLaunch(launch.deployer, launch.token, launch, expect);
      return { token: launch.token, curve: launch.curve };
    },
    async escrowBalanceWei(recipient) {
      return escrow.get(toChecksum(recipient).toLowerCase()) ?? 0n;
    },
    // Only whole gwei move (the memory chain counts ETH in gwei, like the real adapter); a sub-gwei
    // remainder stays in escrow for the next claim rather than vanishing.
    async claimFees(agentSecret) {
      const owner = pubkeyOfSecret(agentSecret);
      const key = owner.toLowerCase();
      const pending = escrow.get(key) ?? 0n;
      const gwei = pending / WEI_PER_GWEI;
      if (gwei === 0n) throw new ChainError('insufficient_funds', `${owner} has no creator fees in escrow`);
      const claimedWei = gwei * WEI_PER_GWEI;
      const { sig } = await chain.faucetEth(owner, Number(gwei), PONS_FEE_ESCROW);
      escrow.set(key, pending - claimedWei);
      return { sig, claimedWei };
    },
    async burn(agentSecret, token, amount) {
      assertBurnAmount(amount);
      const owner = pubkeyOfSecret(agentSecret);
      const coin = toChecksum(token);
      const have = await tokenBalance(owner, coin);
      if (have < amount) throw new ChainError('insufficient_funds', `${owner} holds ${have} of ${coin}, cannot burn ${amount}`);
      chain.setTokenBalance(owner, coin, Number(have - amount));
      return { sig: toHex(randomBytes(32)) };
    },
    tokenBalance,
    // Deterministic per agent wallet, so a demo colony relaunches onto the same addresses every boot.
    // Re-simulating an identical launch returns the recorded one; the real factory would refuse a second
    // launch with the same salt, and so does this.
    async simulateLaunch(p) {
      // Memory-mode owners may be free labels (`demo-wallet-3`), exactly as the memory chain allows.
      const deployer = isEvmAddress(p.devWallet) ? toChecksum(p.devWallet) : p.devWallet.trim();
      if (deployer === '') throw new ChainError('invalid_address', 'launch deployer is empty');
      const recipient = toChecksum(p.agentWallet);
      assertCreatorTax(p.creatorTaxBps, PONS_MAX_CREATOR_TAX_BPS);
      const token = getAddress(`0x${keccak256(toBytes(`vantra:memory:token:${recipient.toLowerCase()}`)).slice(-40)}`);
      const existing = launchesByToken.get(token);
      if (existing) {
        const same = sameAddress(existing.deployer, deployer) && existing.creatorTaxBps === p.creatorTaxBps
          && existing.name === p.name && existing.symbol === p.symbol;
        if (!same) throw new ChainError('launch_failed', `${recipient} is already the recipient of launched token ${token}`);
        return { token: existing.token, curve: existing.curve, txSig: existing.txSig };
      }
      const launch: MemoryLaunch = {
        txSig: keccak256(toBytes(`vantra:memory:launch:${token}`)),
        token,
        curve: getAddress(`0x${keccak256(toBytes(`vantra:memory:curve:${token}`)).slice(-40)}`),
        deployer,
        creatorFeeRecipient: recipient,
        creatorTaxBps: p.creatorTaxBps,
        pairToken: ZERO_ADDRESS,
        exists: true,
        name: p.name,
        symbol: p.symbol,
      };
      launchesBySig.set(launch.txSig, launch);
      launchesByToken.set(token, launch);
      chain.setTokenPrice(token, microPerBaseUnit);
      log.info({ token, curve: launch.curve, deployer, recipient, creatorTaxBps: p.creatorTaxBps }, 'memory launch simulated');
      return { token, curve: launch.curve, txSig: launch.txSig };
    },
    creditEscrow(recipient, wei) {
      if (wei <= 0n) throw new ChainError('invalid_amount', `escrow credit must be positive, got ${wei}`);
      const key = toChecksum(recipient).toLowerCase();
      escrow.set(key, (escrow.get(key) ?? 0n) + wei);
    },
  };
}
