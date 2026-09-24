/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Browser RPC endpoint for Robinhood Chain. Unset = the API's own same-origin /rpc proxy. */
  readonly VITE_RHC_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
