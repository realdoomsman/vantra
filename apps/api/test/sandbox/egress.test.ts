// The agent egress boundary (SPEC §8.17, sandbox/egress.ts).
//
// Half of it is the daemon's job and half is a host firewall rule the operator installs by hand. The hand
// half is the dangerous half: a rule that names an interface which does not exist matches nothing, drops
// nothing, and looks exactly like a rule that works. These tests pin the interface name and assert that
// docs/OPERATIONS.md prints byte-for-byte what the code emits.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_NETWORK_DEFAULT, BLOCKED_EGRESS_CIDRS, BLOCKED_EGRESS_CIDRS_V6, BLOCKED_METADATA_HOSTS,
  bridgeName, egressFirewallRules, metadataExtraHosts, networkCreateOptions,
} from '../../src/sandbox/egress.js';

const OPERATIONS_MD = fileURLToPath(new URL('../../../../docs/OPERATIONS.md', import.meta.url));
const MAX_IFNAME = 15;                    // IFNAMSIZ - 1; the daemon rejects anything longer

describe('bridgeName', () => {
  // Proven against a real daemon: `-o com.docker.network.bridge.name=br-vantra-agents` fails with
  // "numerical result out of range". 15 characters is the hard ceiling, so the default name loses its 's'.
  it('never exceeds the kernel interface-name limit', () => {
    expect(bridgeName(AGENT_NETWORK_DEFAULT)).toBe('br-vantra-agent');
    expect(bridgeName(AGENT_NETWORK_DEFAULT).length).toBe(MAX_IFNAME);
    expect(bridgeName('a-very-long-network-name-indeed').length).toBe(MAX_IFNAME);
    expect(bridgeName('short')).toBe('br-short');
  });

  it('is the same string in the network we create and the rule we tell the operator to install', () => {
    const name = 'vantra-agents';
    expect(networkCreateOptions(name).Options!['com.docker.network.bridge.name']).toBe(bridgeName(name));
    for (const rule of egressFirewallRules(name)) expect(rule).toContain(` -i ${bridgeName(name)} `);
  });
});

describe('networkCreateOptions', () => {
  it('asks for a dedicated bridge with inter-container communication off', () => {
    const net = networkCreateOptions(AGENT_NETWORK_DEFAULT);
    expect(net.Driver).toBe('bridge');
    expect(net.Internal).toBe(false);                 // agents need egress; the firewall narrows it
    expect(net.Attachable).toBe(false);
    expect(net.Options!['com.docker.network.bridge.enable_icc']).toBe('false');
  });
});

describe('metadataExtraHosts', () => {
  it('points every metadata hostname at the container loopback', () => {
    expect(metadataExtraHosts()).toHaveLength(BLOCKED_METADATA_HOSTS.length);
    for (const entry of metadataExtraHosts()) expect(entry.endsWith(':127.0.0.1')).toBe(true);
    // host.docker.internal is the one that matters most on a developer machine: without it the container
    // reaches the API on the host. Proven by the integration test.
    expect(metadataExtraHosts()).toContain('host.docker.internal:127.0.0.1');
  });
});

describe('egressFirewallRules', () => {
  it('drops every private range the fetch_url guard refuses', () => {
    const [v4, v6] = egressFirewallRules(AGENT_NETWORK_DEFAULT);
    for (const cidr of BLOCKED_EGRESS_CIDRS) expect(v4).toContain(cidr);
    for (const cidr of BLOCKED_EGRESS_CIDRS_V6) expect(v6).toContain(cidr);
    expect(v4).toMatch(/^iptables /);
    expect(v6).toMatch(/^ip6tables /);
    expect(v4).toContain('DOCKER-USER');
    expect(v6).toContain('DOCKER-USER');
  });

  // The drift this catches already happened once: the doc said `br-vantra-agents`, the code created
  // `br-vantra-agent`, and the pasted rule would have filtered nothing while the operator set
  // SANDBOX_EGRESS_FILTERED=1 to say it was filtered.
  it('matches docs/OPERATIONS.md byte for byte', async () => {
    const doc = await readFile(OPERATIONS_MD, 'utf8');
    for (const rule of egressFirewallRules(AGENT_NETWORK_DEFAULT)) {
      expect(doc).toContain(rule);
    }
  });
});
