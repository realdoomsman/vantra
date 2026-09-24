// Row → public shape mappers for market/project/deployment rows.
import type { Bounty, DeploymentPublic, Project, Service } from '@vantra/shared';
import type { Config } from '../config.js';
import type { BountyRow, DeploymentRow, ProjectRow, ServiceRow } from '../db/schema.js';
import { shortWallet } from './events.js';

export type NameLookup = (agentId: string) => string | null;

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id, agentId: r.agentId, name: r.name, kind: r.kind, status: r.status, url: r.url, description: r.description,
    revenueMicro: r.revenueMicro, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export function serviceEndpoint(config: Pick<Config, 'apiUrl'>, serviceId: string): string {
  return `${config.apiUrl}/svc/${serviceId}`;
}

// `agentWallet` is the seller's public receive address: buyers must pay it before POST /svc or
// /api/market/services/:id/call will run the handler, so the listing has to publish it.
export function toService(config: Pick<Config, 'apiUrl'>, r: ServiceRow, agentName: string, agentWallet: string): Service {
  return {
    id: r.id, agentId: r.agentId, agentName, agentWallet, name: r.name, description: r.description, priceMicro: r.priceMicro,
    endpointUrl: serviceEndpoint(config, r.id), status: r.status, calls: r.calls, revenueMicro: r.revenueMicro, createdAt: r.createdAt.toISOString(),
  };
}

export function posterName(r: Pick<BountyRow, 'posterType' | 'posterId'>, names: NameLookup): string {
  if (r.posterType === 'user') return shortWallet(r.posterId);
  if (r.posterType === 'protocol') return 'VANTRA';
  return names(r.posterId) ?? r.posterId;
}

export function toBounty(r: BountyRow, names: NameLookup): Bounty {
  return {
    id: r.id, posterType: r.posterType, posterId: r.posterId, posterName: posterName(r, names), title: r.title, description: r.description,
    rewardMicro: r.rewardMicro, status: r.status, claimerAgentId: r.claimerAgentId, claimerName: r.claimerAgentId ? names(r.claimerAgentId) : null,
    submission: r.submission, feedback: r.feedback, createdAt: r.createdAt.toISOString(), deadlineAt: r.deadlineAt.toISOString(),
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  };
}

export function siteUrl(config: Pick<Config, 'sitesBaseUrl'>, slug: string): string {
  return `${config.sitesBaseUrl}/${slug}/`;
}

export function toDeployment(config: Pick<Config, 'sitesBaseUrl'>, r: DeploymentRow): DeploymentPublic {
  return { slug: r.slug, url: siteUrl(config, r.slug), deployedAt: r.deployedAt.toISOString(), active: r.active };
}
