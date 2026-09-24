// The network boundary for agent containers (SPEC §8.17 "agents need egress").
//
// `fetch_url` refuses loopback, RFC1918, CGNAT, link-local/169.254, ULA and metadata hostnames, and
// pins the connection against DNS rebinding. `bash` has to enforce the SAME reachability boundary or
// the guard is decorative: `curl http://169.254.169.254/...` or `psql postgres://<gateway>:5432/runway`
// is one shell command away.
//
// Docker's API can express part of that and no more, so the boundary is built in two halves:
//
//   1. HERE, and enforced by the daemon: a dedicated user-defined bridge for agents instead of the
//      default one (so a container cannot reach whatever else the host runs — a Postgres container on
//      the default bridge, say), inter-container communication off (agents cannot reach each other),
//      and the well-known metadata hostnames blackholed to the container's own loopback.
//   2. ON THE HOST, and NOT expressible through the Docker API: dropping the private CIDRs below on
//      traffic leaving that bridge. `egressFirewallRules()` prints the exact rules; production must
//      install them and set SANDBOX_EGRESS_FILTERED=1 to say so (config.ts refuses to boot otherwise).
import type Docker from 'dockerode';

export const AGENT_NETWORK_DEFAULT = 'vantra-agents';

// Kept in step with tools/fetch.ts:isBlockedV4 — the two must describe one boundary.
export const BLOCKED_EGRESS_CIDRS: readonly string[] = [
  '0.0.0.0/8',          // this-network
  '10.0.0.0/8',         // private
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local, including every cloud metadata endpoint
  '172.16.0.0/12',      // private (Docker's own bridges live here)
  '192.0.0.0/24',       // IETF protocol assignments
  '192.168.0.0/16',     // private
  '198.18.0.0/15',      // benchmarking
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved
];

export const BLOCKED_EGRESS_CIDRS_V6: readonly string[] = [
  '::1/128',            // loopback
  'fc00::/7',           // ULA
  'fe80::/10',          // link-local
  'ff00::/8',           // multicast
];

// Names a container could otherwise resolve to a metadata service. Pointed at its own loopback, where
// nothing listens. Raw-IP access to the same services is the host firewall's job.
export const BLOCKED_METADATA_HOSTS: readonly string[] = [
  'metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data',
  'host.docker.internal', 'gateway.docker.internal',
];

export const metadataExtraHosts = (): string[] => BLOCKED_METADATA_HOSTS.map((h) => `${h}:127.0.0.1`);

// The host interface the bridge gets, and the interface the firewall rule below must name.
//
// Linux caps an interface name at 15 characters (IFNAMSIZ - 1); the daemon rejects a longer one outright
// with "numerical result out of range", so `br-vantra-agents` (16) is not a name that can exist and the
// rule has to say `br-vantra-agent`. One function so the bridge we create and the bridge the firewall
// filters can never be two different strings.
const MAX_IFNAME = 15;
export const bridgeName = (networkName: string): string => `br-${networkName}`.slice(0, MAX_IFNAME);

export function networkCreateOptions(name: string): Docker.NetworkCreateOptions {
  return {
    Name: name,
    Driver: 'bridge',
    CheckDuplicate: true,
    Internal: false,                                   // agents need egress; the host firewall narrows it
    Attachable: false,
    Labels: { 'runway.network': 'agents' },
    Options: {
      'com.docker.network.bridge.enable_icc': 'false', // one agent cannot reach another's container
      'com.docker.network.bridge.name': bridgeName(name),
    },
  };
}

// The half of the boundary Docker cannot enforce. Printed at boot and in docs/OPERATIONS.md so the
// rule and the code that assumes it never drift.
export function egressFirewallRules(networkName: string): string[] {
  const bridge = bridgeName(networkName);
  return [
    `iptables -I DOCKER-USER -i ${bridge} -d ${BLOCKED_EGRESS_CIDRS.join(',')} -j DROP`,
    `ip6tables -I DOCKER-USER -i ${bridge} -d ${BLOCKED_EGRESS_CIDRS_V6.join(',')} -j DROP`,
  ];
}
