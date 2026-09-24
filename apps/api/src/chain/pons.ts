// Pons V2 on Robinhood Chain: the launchpad that replaces pump.fun. Addresses and ABI fragments are
// transcribed from the verified sources at github.com/ReptilianHQ/ponsfamily (contractsV2/src/v2/) and
// were confirmed against mainnet by eth_call — `launchFee()` 0.0005 ETH, `maxCreatorTaxBps()` 1000,
// `launchEnabled()` true, `launchConfigCount()` 1 (so 0 is the only valid launch config).
//
// This module is the ONE declaration of the Pons surface: economy/token.ts launches and claims through
// it, chain/evm.ts trades ungraduated tokens on their bonding curve through it. No second copy.
import { parseAbi, type Address } from 'viem';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address;
// Read from `factory.feeEscrow()` at runtime rather than trusted blindly; kept here so an operator can
// recognise the address in a log line.
export const PONS_FEE_ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e' as Address;
export const PONS_ROUTER = '0xe33e9e479df8802cb0866d5d05258bec4cf62948' as Address;
export const PONS_MEME_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address;
export const PONS_LAUNCH_LOCKER = '0x267444d099b10fb5ed7c3cc7b7c767adca574952' as Address;
export const UNISWAP_V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;

// `launchConfigCount()` is 1, so this is the only id the factory accepts.
export const PONS_LAUNCH_CONFIG_ID = 0n;
// keccak256('TokenLaunched(address,address,address,address,uint256,uint256)'), verified against a real
// mainnet launch receipt — the topic a launch receipt is matched on to recover (token, curve).
export const TOKEN_LAUNCHED_TOPIC0 = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607' as const;

// Deliberately ABSENT from this fragment: `transferCreatorFeeRecipient` and `setBuybackEnabled`. A
// launched agent's creator tax is wired to the agent's wallet, only that wallet may ever redirect it,
// and VANTRA holds that wallet's key. The trust guarantee to a coin's holders is that this codebase
// cannot make the call at all: no fragment, no selector, no encoder. Buyback stays off because Pons's
// native buyback LOCKS tokens in a 5-year vest; VANTRA buys and `burn()`s instead (see ponsTokenAbi).
// Never declare either function here or anywhere else.
export const ponsFactoryAbi = parseAbi([
  'function launchFee() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function feeEscrow() view returns (address)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

// Every Pons token is a PonsV2LauncherToken: ERC20Burnable with a fixed 1,000,000,000 × 1e18 supply.
// `burn` is how an agent retires the coin it bought back — it reduces `totalSupply`, unlike Pons's own
// buyback, which only locks.
export const PONS_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const ponsTokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function burn(uint256 amount)',
]);

// The creator-fee loop. `claim()` is permissionless and credits msg.sender, so the agent wallet claims
// its own tax and pays its own gas — no protocol key ever signs for an agent's revenue.
export const ponsFeeEscrowAbi = parseAbi([
  'function balanceOf(address recipient) view returns (uint256)',
  'function claim() returns (uint256 amount)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claimToken(address token) returns (uint256 amount)',
]);

// One curve per launched token, live until the token graduates to a Uniswap v4 pool. Before graduation
// this is the only venue that can price the token at all, which is why chain/evm.ts routes through it.
export const ponsBondingCurveAbi = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function graduated() view returns (bool)',
  'function quoteReserve() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);

// The public page for a launched token — what an agent links to when it tells the world it has a coin.
export const ponsUrl = (token: string): string => `https://www.ponsfamily.com/token/${token}`;
