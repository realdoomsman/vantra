// Browser wallet access: EIP-6963 discovery over an EIP-1193 injected provider, driven with viem.
// This replaces the wallet-adapter stack the app used before the chain cutover, which existed to do
// exactly four things — list wallets, connect, expose the account, and sign. EVM needs one more: the
// account carries a NETWORK, and a wallet sitting on Ethereum mainnet will happily sign a transfer
// that never reaches Robinhood Chain, so the chain id is part of the connection state and
// `switchNetwork()` is part of the surface.
//
// Discovery is EIP-6963 (wallets announce themselves) with `window.ethereum` as the fallback for a
// wallet that predates it. There is no "not installed" state to render any more: a wallet that is
// not there never announces, so the menu lists what actually exists rather than advertising
// installs, which is why the old adapter `readyState` has no successor here.
//
// `publicKey` keeps its name — the field is the connected account, and the rest of the codebase
// (`walletPubkey`, `CustodialWallet.pubkey`, `depositPubkey`) kept its `pubkey` naming through the
// EVM cutover too. It is now an EIP-55 address string, not a key object.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createPublicClient, createWalletClient, custom, getAddress, http, numberToHex, toHex,
  type Address, type EIP1193Provider, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { chainFor, walletRpcUrl, type RobinhoodChain } from '../lib/chains';
import { rpcEndpoint } from '../lib/mode';
import { useAppStore } from '../store/app';

/** One wallet as it announced itself over EIP-6963. `rdns` is the stable id we select by. */
export interface InjectedWallet {
  rdns: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
}

export interface WalletState {
  /** Every wallet that announced itself, in announcement order. */
  wallets: InjectedWallet[];
  /** The selected wallet, or null when none has been picked yet. */
  wallet: InjectedWallet | null;
  select: (rdns: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  connected: boolean;
  connecting: boolean;
  /** The connected account as an EIP-55 address, or null. */
  publicKey: string | null;
  /** The wallet's current chain id, or null when not connected. */
  chainId: number | null;
  /** Connected, but the wallet is pointed at some other network. Nothing may be signed in this state. */
  wrongNetwork: boolean;
  /** Ask the wallet to switch to Robinhood Chain, adding the network first if it does not know it. */
  switchNetwork: () => Promise<void>;
  /** personal_sign over a UTF-8 message; returns the `0x` signature. Throws when not connected. */
  signMessage: (message: string) => Promise<Hex>;
  /** Signing client bound to the connected account and Robinhood Chain; null until connected. */
  walletClient: WalletClient | null;
  /** The network this deployment expects the wallet to be on. */
  chain: RobinhoodChain;
}

const SELECTED_KEY = 'rw_wallet';

const WalletContext = createContext<WalletState | null>(null);
const ClientContext = createContext<PublicClient | null>(null);

/** EIP-6963 announcement payload. */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

export function ChainProviders({ children }: { children: ReactNode }) {
  const mode = useAppStore((s) => s.stats?.chain.mode ?? null);
  const cluster = useAppStore((s) => s.stats?.chain.cluster ?? null);
  const chain = useMemo(() => chainFor(cluster), [cluster]);

  // Read client. Rebuilt when the network changes; the transport URL keeps any server-side RPC key
  // out of the bundle (see lib/mode.ts).
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(rpcEndpoint(mode && cluster ? { mode, cluster } : null)) }),
    [chain, mode, cluster],
  );

  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  });
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);

  // ---- discovery (EIP-6963) ------------------------------------------------
  useEffect(() => {
    const seen = new Map<string, InjectedWallet>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.info?.rdns || seen.has(detail.info.rdns)) return;
      seen.set(detail.info.rdns, {
        rdns: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider,
      });
      setWallets([...seen.values()]);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    // A wallet that predates EIP-6963 only ever appears on `window.ethereum`. Give the announcements
    // a tick to arrive first so it is not listed twice under a different name.
    const legacy = setTimeout(() => {
      const injected = (window as { ethereum?: EIP1193Provider }).ethereum;
      if (!injected || seen.size > 0) return;
      seen.set('injected', { rdns: 'injected', name: 'Browser Wallet', icon: '', provider: injected });
      setWallets([...seen.values()]);
    }, 300);
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      clearTimeout(legacy);
    };
  }, []);

  const wallet = useMemo(() => wallets.find((w) => w.rdns === selected) ?? null, [wallets, selected]);

  // ---- account + chain state ----------------------------------------------
  // The selected provider is mirrored into a ref so `connect`/`disconnect`/`switchNetwork` keep a
  // stable identity across wallet changes: they are handed to buttons and to effect dependency
  // arrays, and re-creating them on every selection would re-run those effects for nothing.
  // Subscriptions below deliberately close over `wallet.provider` instead, so each cleanup detaches
  // from the exact object it attached to.
  const providerRef = useRef<EIP1193Provider | null>(null);
  providerRef.current = wallet?.provider ?? null;

  const readChainId = useCallback(async (provider: EIP1193Provider): Promise<number> => {
    const hex = (await provider.request({ method: 'eth_chainId' })) as Hex;
    return Number.parseInt(hex, 16);
  }, []);

  // Reconnect silently to a wallet this browser already authorised: `eth_accounts` never prompts,
  // so an authorised session survives a reload without a popup, which is what the adapter's
  // `autoConnect` did.
  useEffect(() => {
    if (!wallet) return;
    let live = true;
    void (async () => {
      try {
        const accounts = (await wallet.provider.request({ method: 'eth_accounts' })) as Address[];
        if (!live) return;
        setAddress(accounts.length > 0 ? getAddress(accounts[0]!) : null);
        setChainId(accounts.length > 0 ? await readChainId(wallet.provider) : null);
      } catch {
        if (live) setAddress(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [wallet, readChainId]);

  // Account and network changes come from the wallet, not from us: the user can switch either one in
  // the extension at any moment and the app has to follow, or it signs for the wrong account.
  useEffect(() => {
    const provider = wallet?.provider;
    // EIP-6963 requires `on`/`removeListener`, but a pre-6963 `window.ethereum` may have neither.
    if (!provider || typeof provider.on !== 'function') return;
    const onAccounts = (accounts: Address[]) => {
      setAddress(accounts.length > 0 ? getAddress(accounts[0]!) : null);
    };
    const onChain = (id: string) => setChainId(Number.parseInt(id, 16));
    const onDisconnect = () => {
      setAddress(null);
      setChainId(null);
    };
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    provider.on('disconnect', onDisconnect);
    return () => {
      if (typeof provider.removeListener !== 'function') return;
      provider.removeListener('accountsChanged', onAccounts);
      provider.removeListener('chainChanged', onChain);
      provider.removeListener('disconnect', onDisconnect);
    };
  }, [wallet]);

  const select = useCallback((rdns: string) => {
    setAddress(null);
    setChainId(null);
    setSelected(rdns);
    try {
      localStorage.setItem(SELECTED_KEY, rdns);
    } catch {
      // A browser with storage blocked still connects; it just will not remember the choice.
    }
  }, []);

  const connect = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) throw new Error('Pick a wallet first');
    setConnecting(true);
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
      if (accounts.length === 0) throw new Error('The wallet returned no account');
      setAddress(getAddress(accounts[0]!));
      setChainId(await readChainId(provider));
    } finally {
      setConnecting(false);
    }
  }, [readChainId]);

  const disconnect = useCallback(async () => {
    const provider = providerRef.current;
    setAddress(null);
    setChainId(null);
    setSelected(null);
    try {
      localStorage.removeItem(SELECTED_KEY);
    } catch {
      // Storage blocked: the session is already dropped in memory, which is what matters.
    }
    // EIP-1193 has no disconnect, and a site cannot revoke its own permission in every wallet: only
    // some implement EIP-2255 `wallet_revokePermissions` and the rest reject it outright. Asking is
    // still worth it — it is the difference between the wallet forgetting us and silently
    // reconnecting on the next visit — but a refusal is expected and changes nothing locally.
    await provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => undefined);
  }, []);

  const switchNetwork = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) throw new Error('Connect a wallet first');
    const hexId = numberToHex(chain.id);
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    } catch (e) {
      // 4902 is "unrecognized chain"; some wallets answer -32603 with the same meaning. Either way
      // the cure is to describe the network once and switch again.
      const code = (e as { code?: number }).code;
      if (code !== 4902 && code !== -32603) throw e;
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [walletRpcUrl(chain)],
          blockExplorerUrls: [chain.blockExplorers.default.url],
        }],
      });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    }
    setChainId(await readChainId(provider));
  }, [chain, readChainId]);

  const signMessage = useCallback(async (message: string): Promise<Hex> => {
    const provider = providerRef.current;
    if (!provider || !address) throw new Error('Connect a wallet first');
    // personal_sign takes (data, address) in that order — the reverse of the deprecated eth_sign —
    // and the data is hex-encoded UTF-8, which the wallet decodes again to show the user the text.
    return (await provider.request({ method: 'personal_sign', params: [toHex(message), address] })) as Hex;
  }, [address]);

  const walletClient = useMemo(() => {
    const provider = wallet?.provider;
    if (!provider || !address) return null;
    return createWalletClient({ account: address, chain, transport: custom(provider) });
  }, [wallet, address, chain]);

  const value = useMemo<WalletState>(() => ({
    wallets,
    wallet,
    select,
    connect,
    disconnect,
    connected: address !== null,
    connecting,
    publicKey: address,
    chainId,
    wrongNetwork: address !== null && chainId !== null && chainId !== chain.id,
    switchNetwork,
    signMessage,
    walletClient,
    chain,
  }), [
    wallets, wallet, select, connect, disconnect, address, connecting, chainId, chain,
    switchNetwork, signMessage, walletClient,
  ]);

  return (
    <ClientContext.Provider value={publicClient}>
      <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
    </ClientContext.Provider>
  );
}

/** The connected wallet. Throws outside ChainProviders, which would otherwise fail silently. */
export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside ChainProviders');
  return ctx;
}

/** The read-only chain client (balances, receipts). Never signs; needs no wallet. */
export function usePublicClient(): PublicClient {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('usePublicClient must be used inside ChainProviders');
  return ctx;
}
