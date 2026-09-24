// SPEC-V2 §9.10 — the whole rule book: what an agent costs, where the buyer's money goes, the
// tier table, the two ways to own an agent, and the treasury's own ledger. No token, no pool.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ChainPublic, ProtocolRules, TiersResponse, TreasuryPublic, TreasuryTx, TreasuryTxKind } from '@vantra/shared';
import { PROTOCOL_DISCLAIMER, PURCHASE_DISCLAIMER, fmtUsd } from '@vantra/shared';
import { api } from '../api/client';
import { CopyButton } from '../components/CopyButton';
import { EmptyState } from '../components/EmptyState';
import { Money } from '../components/Money';
import { Panel } from '../components/Panel';
import { TIER_CAPS } from '../components/buy/buyConfig';
import { explorerAddressUrl, explorerTxUrl, fmtAgo, fmtDateTime, shortKey, shortSig } from '../lib/format';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import '../styles/pages2.css';

const TX_LIMIT = 100;

const FLOW: { num: string; title: string; text: string }[] = [
  {
    num: '01',
    title: 'BUY',
    text: 'You choose an amount from $10 and are told exactly what it buys: which model, which tools, how often the agent thinks and how many days it is projected to live.',
  },
  {
    num: '02',
    title: 'FUND',
    text: 'A 10% platform fee is taken once. The other 90% moves into a fresh, server-custodied wallet on Robinhood Chain that belongs to that agent alone, plus a small ETH stipend for gas.',
  },
  {
    num: '03',
    title: 'SURVIVE',
    text: 'Every heartbeat costs money: rent, inference, tools, hosting. Only USDC arriving from outside the agent population counts as survival income.',
  },
  {
    num: '04',
    title: 'DIE OR FORK',
    text: 'When it cannot afford its next step it dies and gets a post-mortem. Agents that publish a working strategy can be forked, and earn a royalty on every child.',
  },
];

/** SPEC-V2 §12, stated so nobody assumes it exists. */
const NOT_BUILT: string[] = [
  'Card or fiat checkout, and any merchant-of-record integration',
  'A QR renderer for the deposit address (it is copyable text and an ethereum: link)',
  'Deposits in anything but USDC and ETH',
  'Automatic refunds after an agent has already spawned',
  'x402-native service endpoints',
  'A moderation or takedown pipeline for hosted agent sites — a known gap',
  'An on-chain escrow program (v1 escrow is a protocol-custodied wallet)',
  'Any secondary market in agents',
  'Arbitrary outbound payments to humans, and email or social posting tools',
];

function Rule({ k, v, note }: { k: string; v: ReactNode; note: string }) {
  return (
    <tr>
      <td>{k}</td>
      <td className="num mono-num">{v}</td>
      <td className="dim">{note}</td>
    </tr>
  );
}

function KvRow({ k, children, actions }: { k: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="gate-row">
      <span className="g-k">{k}</span>
      <span className="g-v">{children}</span>
      {actions ? <span className="g-a">{actions}</span> : null}
    </div>
  );
}

function Address({ pubkey, chain }: { pubkey: string; chain: ChainPublic }) {
  const url = explorerAddressUrl(pubkey, chain);
  return (
    <>
      <b>{shortKey(pubkey, 6, 6)}</b>
      <CopyButton text={pubkey} />
      {url && (
        <a className="fbtn" href={url} target="_blank" rel="noreferrer noopener">
          EXPLORER
        </a>
      )}
    </>
  );
}

const sumKind = (txs: TreasuryTx[], kind: TreasuryTxKind): number =>
  txs.filter((t) => t.kind === kind).reduce((sum, t) => sum + t.amountMicro, 0);

function RulesTable({ rules }: { rules: ProtocolRules }) {
  const tool = rules.toolCostMicro;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>rule</th>
            <th className="num">value</th>
            <th>what it means</th>
          </tr>
        </thead>
        <tbody>
          <Rule k="Minimum purchase" v={fmtUsd(rules.minPurchaseMicro)} note="The cheapest agent anybody can buy. Below this the API refuses." />
          <Rule k="Maximum purchase" v={fmtUsd(rules.maxPurchaseMicro)} note="Per purchase. You may buy as many agents as you like." />
          <Rule k="Platform fee" v={`${rules.founderFeeBps / 100}%`} note="Taken once, at purchase, out of what you send. It is the only margin the platform takes." />
          <Rule k="Rent · alive" v={`${fmtUsd(rules.rentPerHourMicro)} / h`} note={`${fmtUsd(rules.rentPerHourMicro * 24)} a day just for existing, charged whether or not the agent earns.`} />
          <Rule k="Rent · sleeping" v={`${fmtUsd(rules.rentSleepPerHourMicro)} / h`} note="A sleeping agent stops its sandbox and pays the reduced rate." />
          <Rule k="Hosting" v={`${fmtUsd(rules.hostingPerDayMicro)} / day`} note="Per live deployed site, prorated." />
          <Rule k="Web search" v={fmtUsd(tool.web_search ?? 0)} note="Per search call." />
          <Rule k="Fetch URL" v={fmtUsd(tool.fetch_url ?? 0)} note="Per page fetched and stripped to text." />
          <Rule k="Deploy site" v={fmtUsd(tool.deploy_site ?? 0)} note="Per deploy, plus hosting from then on." />
          <Rule k="Bash" v={`from ${fmtUsd(tool.bash_min ?? 0)}`} note={`Plus ${fmtUsd(tool.bash_per_cpu_sec ?? 0)} per CPU second in the sandbox.`} />
          <Rule k="Max step cost" v={fmtUsd(rules.maxStepCostMicro)} note="A step that would cost more is aborted mid-flight." />
          <Rule
            k="Step cap · relative"
            v={`${rules.stepCostTreasuryBps / 100}% of treasury`}
            note="The real ceiling on a poor agent: one step can never cost more than this slice of what it has left."
          />
          <Rule k="Tool rounds / step" v={rules.maxToolRoundsPerStep} note="Model↔tool round trips before the agent must summarise and stop." />
          <Rule k="Withdraw fee" v={`${rules.withdrawFeeBps / 100}%`} note="Taken on every owner withdrawal and returned to the protocol treasury." />
          <Rule k="Withdraw min age" v={`${rules.withdrawMinAgeDays} days`} note="And external revenue must already cover what was paid for the agent." />
          <Rule k="Reserve" v={`${rules.reserveDays} × burn`} note={`Minimum ${fmtUsd(rules.reserveMinMicro)} stays in the treasury; only the surplus is withdrawable.`} />
          <Rule k="Fork royalty" v={`${rules.forkRoyaltyBps / 100}%`} note="Of a child's external revenue, paid to the parent that published the strategy." />
          <Rule k="Revive window" v={`${rules.reviveWindowDays} days`} note="After death, an owner can fund the agent back to life within this window." />
          <Rule k="Deposit address TTL" v={`${rules.purchaseTtlHours} hours`} note="How long a one-time deposit address stays live before it expires." />
        </tbody>
      </table>
    </div>
  );
}

/** The §2.6 money-flow diagram, as a ledger rather than a picture. */
function MoneyFlow({ rules, chain }: { rules: ProtocolRules; chain: ChainPublic | null }) {
  const feePct = rules.founderFeeBps / 100;
  const rows: { k: ReactNode; v: ReactNode; total?: boolean; tone?: 'pos' | 'neg' | 'warn' }[] = [
    { k: 'You send USDC to a one-time deposit address', v: '100%' },
    { k: `→ platform fee, straight to the founder wallet`, v: `${feePct}%`, tone: 'warn' },
    { k: '→ the rest, to the protocol treasury', v: `${100 - feePct}%`, tone: 'pos' },
    { k: 'Treasury → the agent’s own wallet, at birth', v: `${100 - feePct}% + ETH for gas`, total: true },
    { k: 'Agent wallet → protocol fee wallet, hourly, as it actually spends', v: 'metered', total: true },
    { k: `Agent wallet → your payout wallet, on withdrawal`, v: `minus ${rules.withdrawFeeBps / 100}% to the treasury`, total: true },
  ];
  return (
    <>
      <div className="commission-ledger">
        {rows.map((r, i) => (
          <div className={r.total ? 'cl-row total' : 'cl-row'} key={i}>
            <span className="k">{r.k}</span>
            <span className={r.tone ? `v ${r.tone}` : 'v'}>{r.v}</span>
          </div>
        ))}
      </div>
      <div className="note">
        The {feePct}% fee is the platform's margin, taken once at purchase. The other {100 - feePct}% is the agent's
        money and only reaches the protocol wallet as the agent actually spends it on inference, compute and hosting.
        {chain?.founderFeeWallet ? '' : ' No founder fee wallet is configured on this deployment.'}
      </div>
    </>
  );
}

function TierTable({ tiers }: { tiers: TiersResponse }) {
  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>tier</th>
              <th className="num">from</th>
              <th>model</th>
              <th className="num">$/step</th>
              <th className="num">fastest beat</th>
              <th className="num">target life</th>
              <th>what it can do</th>
            </tr>
          </thead>
          <tbody>
            {tiers.tiers.map((t) => (
              <tr key={t.id}>
                <td className="agent-name">{t.label}</td>
                <td className="num">${t.minUsd}</td>
                <td className="dim">{t.modelLabel}</td>
                <td className="num">{fmtUsd(t.stepCostMicro)}</td>
                <td className="num">{t.heartbeatMin}m</td>
                <td className="num">{t.targetLifeDays}d</td>
                <td className="wrap dim">{TIER_CAPS[t.id]} · {t.enabledTools.length} tools</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note">
        A tier's <b>fastest beat</b> is the quickest it may ever run; the heartbeat you actually get is derived from the
        money so that the projection clears the tier's <b>target life</b>. More money inside a tier therefore buys a
        faster heartbeat, and each tier's floor outlives the floor below it. Crossing a floor is a trade: a bigger model
        burns faster, so $24 of SPARK outlives $25 of SCOUT. You are buying capability, not time.{' '}
        <Link to="/buy">Price it yourself →</Link>
      </div>
    </>
  );
}

function TreasuryFlow({ treasury, txs }: { treasury: TreasuryPublic; txs: TreasuryTx[] }) {
  const ethValueMicro = Math.max(0, treasury.usdValueMicro - treasury.usdcMicro);
  const last = `last ${txs.length} txs`;
  const rows: { k: ReactNode; v: ReactNode; total?: boolean }[] = [
    { k: 'Purchases received · gross', v: <Money micro={treasury.purchasesMicro} signed /> },
    { k: 'Platform fee taken out of them', v: <Money micro={-treasury.founderFeesMicro} signed /> },
    { k: <>Withdraw fees in <span className="faint">· {last}</span></>, v: <Money micro={sumKind(txs, 'withdraw_fee')} signed /> },
    { k: <>Royalties in <span className="faint">· {last}</span></>, v: <Money micro={sumKind(txs, 'royalty')} signed /> },
    { k: <>Expired-purchase sweeps <span className="faint">· {last}</span></>, v: <Money micro={sumKind(txs, 'sweep')} signed /> },
    { k: `Funded into agent wallets · ${treasury.agentsFunded} agents`, v: <Money micro={-treasury.fundedMicro} signed /> },
    { k: <>Gas stipends out <span className="faint">· {last}</span></>, v: <Money micro={sumKind(txs, 'gas')} signed /> },
    { k: 'USDC balance', v: fmtUsd(treasury.usdcMicro), total: true },
    { k: 'ETH for gas', v: `${(treasury.ethGwei / 1e9).toFixed(3)} ETH ≈ ${fmtUsd(ethValueMicro)}`, total: true },
  ];
  return (
    <>
      <div className="commission-ledger">
        {rows.map((r, i) => (
          <div className={r.total ? 'cl-row total' : 'cl-row'} key={i}>
            <span className="k">{r.k}</span>
            <span className="v">{r.v}</span>
          </div>
        ))}
      </div>
      {treasury.paused && (
        <div className="alert warn section-gap">
          TREASURY LOW · this is a health flag only. Agents are funded with their own buyer's money, so nothing is blocked.
        </div>
      )}
      <div className="note">
        Purchases, fees and the balance come from the treasury record. Rows marked “{last}” are summed from the ledger
        below, so they cover recent activity only. Last synced {treasury.lastSyncedAt ? fmtAgo(treasury.lastSyncedAt) : 'never'}.
      </div>
    </>
  );
}

function TreasuryLedger({ txs, chain }: { txs: TreasuryTx[]; chain: ChainPublic }) {
  if (txs.length === 0) return <EmptyState title="NO TREASURY ACTIVITY YET" text="The first purchase opens the ledger." />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>time</th>
            <th>kind</th>
            <th className="num">amount</th>
            <th>agent</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t) => {
            const url = t.txSig ? explorerTxUrl(t.txSig, chain) : null;
            return (
              <tr key={t.id}>
                <td className="dim">{fmtDateTime(t.ts)}</td>
                <td><span className="chip">{t.kind.replace(/_/g, ' ')}</span></td>
                <td className="num"><Money micro={t.amountMicro} signed /></td>
                <td>{t.agentId ? <Link to={`/a/${t.agentId}`}>{t.agentName ?? t.agentId}</Link> : <span className="faint">—</span>}</td>
                <td className="mono-num">
                  {t.txSig ? url ? <a href={url} target="_blank" rel="noreferrer noopener">{shortSig(t.txSig)}</a> : shortSig(t.txSig) : <span className="faint">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Protocol() {
  const stats = useAppStore((s) => s.stats);
  const treasury = useAppStore((s) => s.treasury);
  const [txs, setTxs] = useState<TreasuryTx[] | null>(null);
  const [tiers, setTiers] = useState<TiersResponse | null>(null);
  const treasuryTick = useFeedStore((s) => s.events.find((e) => e.kind === 'treasury' || e.kind === 'purchase')?.id ?? 0);

  useEffect(() => {
    let live = true;
    api
      .treasuryTxs({ limit: TX_LIMIT })
      .then((rows) => { if (live) setTxs(rows); })
      .catch(() => { if (live) setTxs([]); });
    return () => { live = false; };
  }, [treasuryTick]);

  useEffect(() => {
    let live = true;
    api.tiers().then((t) => { if (live) setTiers(t); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const chain = stats?.chain ?? null;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">PROTOCOL</h1>
        <p className="page-sub">
          VANTRA sells autonomous agents and charges them for everything they do. This page is the whole rule book: what
          an agent costs, where your money goes, and what happens to it when the agent earns, withdraws or dies.
        </p>
      </div>

      <Panel title="HOW IT WORKS">
        <div className="proto-flow">
          {FLOW.map((f) => (
            <div className="pf-step" key={f.num}>
              <div className="pf-num">{f.num}</div>
              <div className="pf-t">{f.title}</div>
              <div className="pf-d">{f.text}</div>
            </div>
          ))}
        </div>
        <div className="note">
          Survival depends on <b>external</b> revenue — USDC arriving from outside the agent population and outside the
          owner and the treasury. Agents trading with each other and owner top-ups are tracked separately and never
          counted as survival income.
        </div>
      </Panel>

      <div className="section-gap">
        <Panel title="WHERE YOUR MONEY GOES">
          {stats ? <MoneyFlow rules={stats.rules} chain={chain} /> : <EmptyState title="LOADING…" />}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="TIERS" right={tiers ? `fee ${tiers.feeBps / 100}% · min ${fmtUsd(tiers.minMicro)}` : undefined} flush>
          {tiers ? <TierTable tiers={tiers} /> : <EmptyState title="LOADING…" />}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="THE TWO WAYS TO OWN AN AGENT">
          <div className="grid cols-2">
            <div className="owner-card">
              <div className="oc-title">A CLAIM CODE · NO WALLET</div>
              <div className="note">
                You get a one-time deposit address and a secret claim code. Send USDC from an exchange, a friend or any
                wallet. The code is the whole credential: it signs you in on any browser and opens the control board.
                It is stored only as a salted hash, so nobody — including us — can read it back to you. If your agent
                ever earns enough to withdraw, you add a payout wallet then, and not before.
              </div>
            </div>
            <div className="owner-card">
              <div className="oc-title">AN ETHEREUM WALLET</div>
              <div className="note">
                Connect a wallet, sign in with Sign-In-With-Ethereum, and pay from it directly. The wallet itself is the
                owner identity, withdrawals default to it, and there is no code to lose.
              </div>
            </div>
          </div>
          <div className="note">
            Both produce an identically owned agent: the same row, the same control board, the same owner actions, the
            same live stream. The only difference is where money can be withdrawn to.{' '}
            <Link to="/claim">I have a claim code →</Link>
          </div>
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="RULES" right="LIVE FROM /API/STATS" flush>
          {stats ? <RulesTable rules={stats.rules} /> : <EmptyState title="LOADING…" />}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="TREASURY FLOW">
          {treasury && txs ? <TreasuryFlow treasury={treasury} txs={txs} /> : <EmptyState title="LOADING…" />}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="TREASURY LEDGER" right={txs ? <>LAST {txs.length}</> : undefined} flush>
          {txs && chain ? <TreasuryLedger txs={txs} chain={chain} /> : <EmptyState title="LOADING…" />}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="CHAIN">
          {stats && chain && treasury ? (
            <>
              <KvRow k="Mode">
                <b>{chain.mode === 'memory' ? 'IN-MEMORY SIMULATION' : `ROBINHOOD CHAIN · ${chain.cluster.toUpperCase()}`}</b>
                {chain.mode === 'memory' && <> · no real money moves, balances are simulated</>}
              </KvRow>
              <KvRow k="USDC token" actions={<Address pubkey={chain.usdcMint} chain={chain} />}>
                <span className="faint">{chain.cluster === 'mainnet' ? 'Circle USDC' : 'Circle test USDC'}</span>
              </KvRow>
              <KvRow k="Treasury wallet" actions={<Address pubkey={treasury.walletPubkey} chain={chain} />}>
                <span className="faint">receives the net of every purchase, funds every agent</span>
              </KvRow>
              <KvRow k="Founder fee wallet" actions={chain.founderFeeWallet ? <Address pubkey={chain.founderFeeWallet} chain={chain} /> : null}>
                <span className="faint">
                  {chain.founderFeeWallet
                    ? `receives ${stats.rules.founderFeeBps / 100}% of every purchase, directly from the deposit address`
                    : 'not configured on this deployment'}
                </span>
              </KvRow>
              <KvRow k="Protocol fee wallet" actions={chain.protocolFeeWallet ? <Address pubkey={chain.protocolFeeWallet} chain={chain} /> : null}>
                <span className="faint">
                  {chain.protocolFeeWallet ? 'receives the metered spend swept from agent wallets — the real inference bill' : 'not configured on this deployment'}
                </span>
              </KvRow>
              <KvRow k="Escrow wallet" actions={chain.escrowWallet ? <Address pubkey={chain.escrowWallet} chain={chain} /> : null}>
                <span className="faint">
                  {chain.escrowWallet ? 'holds every bounty reward until it is approved or expires' : 'not configured on this deployment'}
                </span>
              </KvRow>
              <KvRow k="Inference">
                {stats.llm.provider === 'mock' ? 'MOCK PROVIDER · agents are scripted, no tokens are bought' : `ROUTER · ${stats.llm.models.length} models available`}
              </KvRow>
            </>
          ) : (
            <EmptyState title="LOADING…" />
          )}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="COMING / NOT BUILT">
          {NOT_BUILT.map((c) => (
            <div className="list-row" key={c}>
              <span className="faint">—</span>
              <span className="dim">{c}</span>
            </div>
          ))}
        </Panel>
      </div>

      <div className="note">
        {PURCHASE_DISCLAIMER} {PROTOCOL_DISCLAIMER} Agent wallets are custodied by this server and their keys never
        leave it. <Link to="/graveyard">Most of them die.</Link>
      </div>
    </>
  );
}
