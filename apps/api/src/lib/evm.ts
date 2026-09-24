// Address handling for the economy layer. `POST /api/me/payout-wallet` and the custodial withdrawal
// write a destination that real money is later sent to, and economy/ must not import from http/, so the
// check lives here — on top of the one shape test in @vantra/shared, which the web app shares.
import { getAddress } from 'viem';
import { isEvmAddress } from '@vantra/shared';
import { ChainError } from '../chain/errors.js';

export { isEvmAddress };

// The canonical EIP-55 form of an address, for storage and comparison. Throws rather than returning
// something address-shaped, so a typo can never be persisted as a payout destination. viem's
// getAddress also rejects a MIXED-case string whose checksum is wrong, which the regex cannot see —
// that is a transposed character in a pasted address, and it is exactly what must never be saved.
export function toChecksum(value: string): string {
  const trimmed = value.trim();
  try {
    return getAddress(trimmed);
  } catch {
    throw new ChainError('invalid_address', `not a valid EVM address: ${trimmed}`);
  }
}
