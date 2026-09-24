// Errors raised by the chain adapters and the pool. Messages never contain key material.
export type ChainErrorCode =
  | 'invalid_key'          // secret has the wrong shape or cannot be decrypted
  | 'invalid_address'      // not a valid EVM address
  | 'invalid_amount'       // non-integer, zero or negative
  | 'insufficient_funds'   // sender cannot cover the transfer
  | 'treasury_dry'         // treasury USDC cannot cover the funding an agent was paid for
  | 'no_route'             // no aggregator route for this pair/size, and no bonding curve to fall back to
  | 'tx_failed'            // transaction reverted or never confirmed
  | 'launch_failed'        // a submitted launch tx is not a successful Pons launch (unknown, reverted, no event)
  | 'launch_mismatch'      // a successful Pons launch whose deployer/recipient/tax/pair differs from what was agreed
  | 'rpc_error';           // RPC unreachable or returned an unexpected shape

export class ChainError extends Error {
  constructor(public readonly code: ChainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChainError';
  }
}

export const isChainError = (e: unknown, code?: ChainErrorCode): e is ChainError =>
  e instanceof ChainError && (code === undefined || e.code === code);
