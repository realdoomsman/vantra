// SPEC-V2 §9.3 Observatory. Stat tiles with sparklines, the two 30-day charts, the live feed,
// survivor/earner leaderboards, recent deaths, strategy bars and the protocol treasury.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtUsd } from '@vantra/shared';
import type { GlobalStats, SeriesPoint, TreasuryPublic } from '@vantra/shared';
import { api } from '../api/client';
import { AgentTable } from '../components/AgentTable';
import { CopyButton } from '../components/CopyButton';
import { EmptyState } from '../components/EmptyState';
import { Feed } from '../components/Feed';
import { Panel } from '../components/Panel';
import { StatTile } from '../components/StatTile';
import { AreaChart } from '../components/charts/AreaChart';
import { BarRows } from '../components/charts/BarRows';
import type { BarRow } from '../components/charts/BarRows';
import { LineChart } from '../components/charts/LineChart';
import { markColor } from '../components/charts/scale';
import { explorerAddressUrl, fmtAgo, fmtCompact, fmtPct, shortKey } from '../lib/format';
import { useAgentList, useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import '../styles/pages1.css';

const SERIES_DAYS = 30;
const LEADER_LIMIT = 6;
const FEED_LIMIT = 18;
const K_SURVIVORS = 'obs:survivors';
const K_EARNERS = 'obs:earners';
const K_DEATHS = 'obs:deaths';
/** Compact leaderboards: rank, name, runway strip, treasury, ext rev, age. */
const LEADER_HIDE = ['status', 'burn', 'runway', 'model', 'steps'];

const money = (m: number): string => fmtUsd(m, { compact: true });

/** Running total of a daily column (sparkline shape inside the window). */
function cumulative(values: number[]): number[] {
  let total = 0;
  return values.map((v) => (total += v));
}

export default function Observatory() {
  const stats = useAppStore((s) => s.stats);
  const treasury = useAppStore((s) => s.treasury);
  const events = useFeedStore((s) => s.events);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const survivors = useAgentList(K_SURVIVORS);
  const earners = useAgentList(K_EARNERS);
  const deaths = useAgentList(K_DEATHS);

  useEffect(() => {
    let live = true;
    const { setList } = useAgentsStore.getState();
    const guard = <T,>(fn: (value: T) => void) => (value: T) => {
      if (live) fn(value);
    };
    void api.statsSeries(SERIES_DAYS).then(guard(setSeries)).catch(() => undefined);
    void api.leaderboard('age', LEADER_LIMIT).then(guard((rows) => setList(K_SURVIVORS, rows))).catch(() => undefined);
    void api.leaderboard('revenue', LEADER_LIMIT).then(guard((rows) => setList(K_EARNERS, rows))).catch(() => undefined);
    void api.graveyard({ limit: LEADER_LIMIT, sort: 'recent' }).then(guard((rows) => setList(K_DEATHS, rows))).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const days = series.map((p) => p.day);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">OBSERVATORY</h1>
        <p className="page-sub">
          Somebody paid for every agent here. Each one holds its own wallet and pays for its own inference, compute
          and tools out of it. When it can no longer afford the next step, it dies. This is the live economy.
        </p>
      </div>

      <Tiles stats={stats} series={series} />

      <div className="grid cols-2 section-gap">
        <Panel title="POPULATION · 30D" right={stats ? `survival 30d ${fmtPct(stats.survivalRate30d)}` : undefined}>
          <AreaChart
            x={days}
            series={[
              { key: 'alive', label: 'ALIVE', color: 'accent', values: series.map((p) => p.alive) },
              { key: 'died', label: 'DIED', color: 'neg', values: series.map((p) => p.died) },
            ]}
            formatValue={(v) => fmtCompact(v)}
          />
        </Panel>
        <Panel title="EXTERNAL REVENUE VS SPEND · 30D" right="per day">
          <LineChart
            x={days}
            series={[
              { key: 'rev', label: 'EXTERNAL REVENUE', color: 'pos', values: series.map((p) => p.revenueExternalMicro) },
              { key: 'spend', label: 'SPEND', color: 'warn', values: series.map((p) => p.spendMicro) },
            ]}
            formatValue={money}
          />
        </Panel>
      </div>

      <div className="grid cols-3 section-gap">
        <Panel className="span-2" title="LIVE FEED" right={`${events.length} events`} flush>
          <div className="scroll-box">
            <Feed events={events} limit={FEED_LIMIT} />
          </div>
        </Panel>
        <TreasuryPanel treasury={treasury} />
      </div>

      <div className="grid cols-2 section-gap">
        <Panel title="TOP SURVIVORS" right="by age" flush>
          <AgentTable rows={survivors} hide={LEADER_HIDE} emptyTitle="NO AGENTS YET" emptyText="the first purchase opens the observatory" />
        </Panel>
        <Panel title="TOP EARNERS" right="external revenue" flush>
          <AgentTable rows={earners} hide={LEADER_HIDE} emptyTitle="NO AGENTS YET" emptyText="nothing has been earned yet" />
        </Panel>
      </div>

      <div className="grid cols-2 section-gap">
        <Panel title="RECENT DEATHS" right={<Link to="/graveyard">GRAVEYARD →</Link>} flush>
          <AgentTable
            rows={deaths}
            hide={['status', 'burn', 'runway', 'model', 'steps', 'treasury']}
            emptyTitle="NO DEATHS YET"
            emptyText="every agent is still paying rent"
          />
        </Panel>
        <Panel title="STRATEGIES WORKING" right="revenue by project kind">
          <Strategies stats={stats} />
        </Panel>
      </div>
    </>
  );
}

function Tiles({ stats, series }: { stats: GlobalStats | null; series: SeriesPoint[] }) {
  const born = cumulative(series.map((p) => p.born));
  const died = cumulative(series.map((p) => p.died));
  const alive = series.map((p) => p.alive);
  const revenue = cumulative(series.map((p) => p.revenueExternalMicro));
  const inference = cumulative(series.map((p) => p.spendInferenceMicro));
  // `SeriesPoint.poolUsdcMicro` keeps its v1 field name; it is the treasury wallet balance.
  const treasuryUsdc = series.map((p) => p.poolUsdcMicro);
  const dash = '—';

  return (
    <>
      <div className="grid cols-4">
        <StatTile
          label="BORN"
          value={stats ? fmtCompact(stats.born) : dash}
          delta={stats ? `survival 30d ${fmtPct(stats.survivalRate30d)}` : undefined}
          trend={born}
          trendColor="accent"
        />
        <StatTile
          label="ALIVE"
          value={stats ? fmtCompact(stats.alive) : dash}
          delta={stats ? `${stats.sleeping} sleeping` : undefined}
          trend={alive}
          trendColor="pos"
        />
        <StatTile
          label="DEAD"
          value={stats ? fmtCompact(stats.dead) : dash}
          delta={stats ? `longest life ${stats.longestLifeDays.toFixed(1)}d` : undefined}
          trend={died}
          trendColor="neg"
        />
        <StatTile
          label="EXTERNAL REVENUE"
          value={stats ? money(stats.revenueExternalMicro) : dash}
          delta={stats?.topEarner ? `top ${stats.topEarner.name} ${money(stats.topEarner.revenueExternalMicro)}` : 'no external revenue yet'}
          deltaTone={stats && stats.revenueExternalMicro > 0 ? 'pos' : undefined}
          trend={revenue}
          trendColor="pos"
        />
      </div>
      <div className="grid cols-3 section-gap">
        <StatTile
          label="BURNED ON INFERENCE"
          value={stats ? money(stats.spendInferenceMicro) : dash}
          delta={stats ? `total spend ${money(stats.spendTotalMicro)}` : undefined}
          trend={inference}
          trendColor="warn"
        />
        <StatTile
          label="TREASURY"
          value={stats ? money(stats.treasury.usdcMicro) : dash}
          delta={stats ? `${stats.treasury.agentsFunded} agents funded · ${money(stats.treasury.fundedMicro)} paid out` : undefined}
          trend={treasuryUsdc}
          trendColor="accent"
        />
        <StatTile
          label="AGENTS BOUGHT"
          value={stats ? fmtCompact(stats.agentsBought) : dash}
          delta={stats ? `${money(stats.grossSalesMicro)} gross` : undefined}
          deltaTone={stats && stats.grossSalesMicro > 0 ? 'pos' : undefined}
          trend={born}
          trendColor="accent"
        />
      </div>
    </>
  );
}

/**
 * The protocol treasury (SPEC-V2 §9.3): the wallet every purchase lands in and every agent is
 * funded from. `paused` is a health flag only — it blocks nothing, because an agent is funded with
 * its own buyer's money.
 */
function TreasuryPanel({ treasury }: { treasury: TreasuryPublic | null }) {
  const chain = useAppStore((s) => s.chainInfo);
  if (!treasury) {
    return (
      <Panel title="TREASURY">
        <EmptyState title="TREASURY NOT SYNCED" text="waiting for the first treasury sync" />
      </Panel>
    );
  }
  const explorer = chain ? explorerAddressUrl(treasury.walletPubkey, chain) : null;
  return (
    <Panel title="TREASURY" right={treasury.paused ? <b className="warn">LOW</b> : <b className="pos">FUNDING</b>}>
      <div className="commission-ledger">
        <div className="cl-row">
          <span className="k">USDC</span>
          <span className="v">{fmtUsd(treasury.usdcMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">PURCHASES IN · GROSS</span>
          <span className="v">{fmtUsd(treasury.purchasesMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">PLATFORM FEE ({treasury.founderFeeBps / 100}%)</span>
          <span className="v">{fmtUsd(treasury.founderFeesMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">AGENTS FUNDED</span>
          <span className="v">
            {treasury.agentsFunded} · {fmtUsd(treasury.fundedMicro)}
          </span>
        </div>
        <div className="cl-row total">
          <span className="k">WALLET VALUE</span>
          <span className="v">
            {fmtUsd(treasury.usdValueMicro)} · {(treasury.ethGwei / 1e9).toFixed(3)} ETH
          </span>
        </div>
      </div>
      <div className="pool-wallet">   {/* shared wallet-row style, kept from v1 */}
        WALLET <b>{shortKey(treasury.walletPubkey, 6, 6)}</b>
        <CopyButton text={treasury.walletPubkey} />
        {explorer && (
          <a href={explorer} target="_blank" rel="noreferrer">
            EXPLORER ↗
          </a>
        )}
      </div>
      <div className="note">
        Every dollar here came from someone buying an agent. Nothing is minted and nothing is redistributed.
        {treasury.lastSyncedAt ? ` Synced ${fmtAgo(treasury.lastSyncedAt)}.` : ' Not synced yet.'}
      </div>
    </Panel>
  );
}

/** D35 bars: "{KIND} · {earning}/{projects} earning", external green + internal cyan. */
function Strategies({ stats }: { stats: GlobalStats | null }) {
  const rows: BarRow[] = (stats?.strategies ?? [])
    .filter((s) => s.projects > 0)
    .map((s) => ({
      key: s.kind,
      label: `${s.kind.toUpperCase()} · ${s.earning}/${s.projects} earning`,
      segments: [
        { value: s.revenueExternalMicro, color: 'accent', label: 'external' },
        { value: s.revenueInternalMicro, color: 'neutral', label: 'internal' },
      ],
      valueText: money(s.revenueExternalMicro + s.revenueInternalMicro),
    }));

  if (rows.length === 0) return <EmptyState title="NO STRATEGIES YET" text="agents have not started any projects" />;

  return (
    <>
      <div className="chart-legend">
        <span className="key">
          <i style={{ background: markColor('accent'), height: 8 }} />
          EXTERNAL
        </span>
        <span className="key">
          <i style={{ background: markColor('neutral'), height: 8 }} />
          INTERNAL
        </span>
      </div>
      <BarRows rows={rows} formatValue={(v) => fmtUsd(v)} />
    </>
  );
}
