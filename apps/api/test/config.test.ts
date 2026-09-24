import { describe, expect, it } from 'vitest';
import { FOUNDER_FEE_BPS_DEFAULT, MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO, PURCHASE_TTL_HOURS } from '@vantra/shared';
import {
  DEPOSIT_POLL_MS_DEFAULT, PONS_CREATOR_TAX_BPS_MAX, USDC_ADDRESSES, describeConfig, loadConfig,
} from '../src/config.js';

const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

/** Everything CHAIN_MODE=robinhood requires, so a test can break exactly one thing at a time. */
const chainEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...base,
  CHAIN_MODE: 'robinhood',
  RHC_RPC_URL: 'https://robinhood-testnet.g.alchemy.com/v2/key',
  USDC_ADDRESS: '0x1111111111111111111111111111111111111111',
  TREASURY_WALLET_SECRET: 't', ESCROW_WALLET_SECRET: 'e', PROTOCOL_FEE_WALLET: 'p', FOUNDER_FEE_WALLET: 'f',
  ...over,
});

describe('loadConfig', () => {
  it('applies dev defaults and warns about insecure fallbacks', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8787);
    expect(c.chain.mode).toBe('memory');
    expect(c.chain.cluster).toBe('testnet');
    expect(c.chain.usdcMint).toBe(USDC_ADDRESSES.usdc);
    expect(c.chain.founderFeeWallet).toBeNull();
    expect(c.chain.acceptEthDeposits).toBe(true);
    expect(c.chain.lifiApiKey).toBeNull();
    expect(c.token.creatorTaxBps).toBe(PONS_CREATOR_TAX_BPS_MAX);
    expect(c.llm.provider).toBe('mock');
    expect(c.sandbox.driver).toBe('local');
    expect(c.economy.minPurchaseMicro).toBe(MIN_PURCHASE_MICRO);
    expect(c.economy.maxPurchaseMicro).toBe(MAX_PURCHASE_MICRO);
    expect(c.economy.founderFeeBps).toBe(FOUNDER_FEE_BPS_DEFAULT);
    expect(c.economy.purchaseTtlHours).toBe(PURCHASE_TTL_HOURS);
    expect(c.economy.rentPerHourMicro).toBe(5_000);          // $0.12/day: the v2 survival tuning
    expect(c.economy.heartbeatOverrideMin).toBeNull();
    expect(c.economy.depositPollMs).toBe(DEPOSIT_POLL_MS_DEFAULT.memory);
    expect(c.demo.treasuryUsd).toBe(2000);
    expect(c.sitesBaseUrl).toBe('http://localhost:8787/sites');
    expect(c.dataDir).toMatch(/[\\/]data$/);          // absolute, repo-rooted; separator is the platform's
    expect(c.warnings).toHaveLength(2);
  });

  it('parses lists and booleans, and takes the settlement token from USDC_ADDRESS', () => {
    const c = loadConfig({ ...base, LLM_ALLOWED_MODELS: 'a, b ,,c', DEMO: '1', USDC_ADDRESS: USDC_ADDRESSES.usdg });
    expect(c.llm.allowedModels).toEqual(['a', 'b', 'c']);
    expect(c.demo.enabled).toBe(true);
    expect(c.chain.usdcMint).toBe(USDC_ADDRESSES.usdg);
  });

  it('polls the chain less often when the RPC costs money', () => {
    expect(loadConfig(chainEnv()).economy.depositPollMs).toBe(DEPOSIT_POLL_MS_DEFAULT.robinhood);
    expect(loadConfig(chainEnv({ DEPOSIT_POLL_MS: '4000' })).economy.depositPollMs).toBe(4000);
  });

  // The schema default for RHC_RPC_URL is the public MAINNET endpoint. Inheriting it while asking for a
  // real chain is how a testnet deployment quietly spends on mainnet, so it has to name the endpoint.
  it('refuses CHAIN_MODE=robinhood that never named an RPC endpoint', () => {
    const { RHC_RPC_URL: _omitted, ...withoutRpc } = chainEnv();
    expect(() => loadConfig(withoutRpc)).toThrow(/RHC_RPC_URL is required when CHAIN_MODE=robinhood/);
    expect(loadConfig(chainEnv()).chain.rpcUrl).toBe('https://robinhood-testnet.g.alchemy.com/v2/key');
    expect(loadConfig(base).chain.rpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');   // memory mode never reads it
  });

  // Nothing bridges to a canonical testnet stablecoin, so inheriting the mainnet address would point
  // every deposit read at a contract that is not deployed there.
  it('refuses a testnet chain that never named its USDC', () => {
    const { USDC_ADDRESS: _omitted, ...withoutUsdc } = chainEnv();
    expect(() => loadConfig(withoutUsdc)).toThrow(/USDC_ADDRESS is required when RHC_NETWORK=testnet/);
    const mainnet = loadConfig(chainEnv({ RHC_NETWORK: 'mainnet', ALLOW_MAINNET: '1', USDC_ADDRESS: '' }));
    expect(mainnet.chain.usdcMint).toBe(USDC_ADDRESSES.usdc);
  });

  it('refuses the local sandbox in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), KEY_ENCRYPTION_KEY: 'a'.repeat(64), SANDBOX_DRIVER: 'local' }))
      .toThrow(/SANDBOX_DRIVER=local/);
  });

  it('requires secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SANDBOX_DRIVER: 'docker' })).toThrow(/SESSION_SECRET is required/);
  });

  it('requires all four wallets for robinhood mode and keys for the router', () => {
    expect(() => loadConfig({ ...base, CHAIN_MODE: 'robinhood' })).toThrow(/TREASURY_WALLET_SECRET/);
    expect(() => loadConfig({ ...base, CHAIN_MODE: 'robinhood', TREASURY_WALLET_SECRET: 't', ESCROW_WALLET_SECRET: 'e', PROTOCOL_FEE_WALLET: 'p' }))
      .toThrow(/FOUNDER_FEE_WALLET/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'router' })).toThrow(/at least one of/);
    expect(() => loadConfig({ ...base, DEMO: '1', LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' })).toThrow(/DEMO=1 requires/);
  });

  it('refuses mainnet without ALLOW_MAINNET, and says why', () => {
    expect(() => loadConfig({ ...base, RHC_NETWORK: 'mainnet' })).toThrow(/ALLOW_MAINNET=1/);
    expect(() => loadConfig({ ...base, RHC_NETWORK: 'mainnet' })).toThrow(/real money/);
  });

  it('refuses a heartbeat override in production and an absurd founder fee anywhere', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), KEY_ENCRYPTION_KEY: 'a'.repeat(64), SANDBOX_DRIVER: 'docker', SANDBOX_EGRESS_FILTERED: '1' };
    expect(() => loadConfig({ ...prod, HEARTBEAT_OVERRIDE_MIN: '5' })).toThrow(/HEARTBEAT_OVERRIDE_MIN/);
    expect(loadConfig({ ...base, HEARTBEAT_OVERRIDE_MIN: '5' }).economy.heartbeatOverrideMin).toBe(5);
    expect(() => loadConfig({ ...base, FOUNDER_FEE_BPS: '3001' })).toThrow(/FOUNDER_FEE_BPS/);
    expect(loadConfig({ ...base, FOUNDER_FEE_BPS: '0' }).economy.founderFeeBps).toBe(0);
  });

  // Above maxCreatorTaxBps() the Pons factory reverts CreatorTaxTooHigh, so every launch would fail.
  it('refuses a creator tax the launchpad would reject', () => {
    expect(() => loadConfig({ ...base, PONS_CREATOR_TAX_BPS: '1001' })).toThrow(/PONS_CREATOR_TAX_BPS/);
    expect(loadConfig({ ...base, PONS_CREATOR_TAX_BPS: '250' }).token.creatorTaxBps).toBe(250);
  });

  it('refuses a purchase range that cannot be satisfied', () => {
    expect(() => loadConfig({ ...base, MIN_PURCHASE_USD: '100', MAX_PURCHASE_USD: '50' })).toThrow(/MAX_PURCHASE_USD/);
    expect(() => loadConfig({ ...base, MIN_PURCHASE_USD: '0.5' })).toThrow(/MIN_PURCHASE_USD/);
  });

  it('validates the encryption key shape', () => {
    expect(() => loadConfig({ ...base, KEY_ENCRYPTION_KEY: 'nothex' })).toThrow(/64 hex/);
  });

  it('never prints a secret in the boot snapshot', () => {
    const c = loadConfig({
      ...base,
      TREASURY_WALLET_SECRET: '0xsuper-secret-private-key',
      FOUNDER_FEE_WALLET: '0xFounder1111111111111111111111111111111111',
      LIFI_API_KEY: 'lifi-secret-key',
    });
    const printed = JSON.stringify(describeConfig(c));
    expect(printed).not.toContain('0xsuper-secret-private-key');
    expect(printed).not.toContain('lifi-secret-key');
    expect(printed).not.toContain(c.sessionSecret);
    expect(printed).not.toContain(c.keyEncryptionKey);
    expect(printed).toContain('0xFounder1111111111111111111111111111111111');
    expect(printed).toContain('"lifiKey":true');
    expect(printed).toContain('"founderFeeBps":1000');
  });
});
