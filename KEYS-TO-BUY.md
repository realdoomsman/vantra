# Keys to buy

This is the shopping list and the paste-it-here instructions. Nothing in here needs you to write code.

**The one command that matters.** After you paste anything into `.env`, run this:

    pnpm ready

It checks every single thing — it does not guess. It makes a real request to each API key you pasted,
connects to your real database, reads your real wallet balances off Robinhood Chain, and starts a
real container. Then it prints one line per item saying PASS, FAIL, WARN or SKIP, and for anything
that is not PASS it tells you the exact thing to do next. At the bottom it gives you a verdict.

> **Do not type `pnpm doctor`.** `doctor` is a command name that pnpm has already taken for itself, so
> pnpm runs its own unrelated check, prints a line about npm configs, and exits saying everything is
> fine. It never reaches this project. Use `pnpm ready`, or the longer `pnpm run doctor` — the word
> **run** is what forces pnpm to use ours. Both do exactly the same thing.

One thing you will see that is **not** a problem: when anything is not yet ready the command
deliberately exits with an error code, so your terminal may colour the last line red even though the
report above it printed perfectly.

**Total to be live: about $26.** Twenty of that is not a cost, it is a float that comes back to you —
see [What the $20 actually is](#what-the-20-actually-is).

---

## Step 0. Make your `.env` and your database (free, 3 minutes)

    cp .env.example .env

Then the database. Everything the app remembers — agents, purchases, the ledger — lives in Postgres,
so this has to exist before anything else works. On a Mac:

    brew install postgresql@14
    brew services start postgresql@14
    createdb vantra
    pnpm db:push

`pnpm db:push` creates the 22 tables the app needs. Leave `DATABASE_URL` in `.env` at its default,
`postgres://localhost:5432/vantra` — that is exactly what those commands just made. `pnpm ready`
connects for real, confirms the `vantra` database is there, and compares the tables against what the
code expects, so it will tell you if you skipped `pnpm db:push` or if an update added a table.

Now run the check for the first time:

    pnpm ready

The first run will be mostly red. That is the point: it is now your to-do list, in order. Work down
it, re-running `pnpm ready` as you go, until it says READY.

Every variable named anywhere below exists in `.env.example` under exactly that name. Nothing here is
invented, and nothing in `.env.example` that takes a real key or secret is missing here.

---

## Step 1. Two secrets you generate (free, 1 minute)

Run these two commands and paste each output into `.env`:

    openssl rand -base64 48      # -> SESSION_SECRET
    openssl rand -hex 32         # -> KEY_ENCRYPTION_KEY

| Variable | What it protects |
|---|---|
| `SESSION_SECRET` | Signs the login cookie and every claim code. Changing it later logs everyone out and voids any claim code nobody has used yet. |
| `KEY_ENCRYPTION_KEY` | Encrypts every agent's and every buyer's private key in your database. **Set this once and never change it** — change it and every stored wallet becomes unreadable, which means the money in it is gone. |

Both must be set before you take real money. `pnpm ready` checks the length and the format of
each one, and the server flatly refuses to start in production without them.

---

## Step 2. Four wallets you generate (free, 3 minutes)

Four separate wallets, each doing a different job. **Do not point two of these at the same wallet** —
`pnpm ready` checks that all four are different, because if they are not, your own margin and
the agents' money become impossible to tell apart.

    # 1. YOUR MARGIN. 10% of every purchase lands here, straight from the buyer's deposit address.
    #    ADDRESS ONLY: the server never signs for this one, so its secret never goes in `.env` at all.
    cast wallet new          # -> FOUNDER_FEE_WALLET is the "Address" line; keep the private key yourself

    # 2. THE TREASURY. Receives the other 90% of every purchase, funds each new agent's wallet, and
    #    pays the small amount of ETH each agent needs for gas. The server signs with it.
    cast wallet new          # -> TREASURY_WALLET_SECRET is the "Private key" line

    # 3. ESCROW. Holds a bounty's reward between the moment it is posted and the moment it is paid out.
    cast wallet new          # -> ESCROW_WALLET_SECRET is the "Private key" line

    # 4. PROTOCOL FEE. Where each agent's metered spending on thinking, rent and tools is swept to.
    #    This is the wallet that reimburses your API bill. ADDRESS ONLY.
    cast wallet new          # -> PROTOCOL_FEE_WALLET is the "Address" line

These are ordinary EVM keypairs — the same kind of key MetaMask holds. `cast wallet new` comes with
Foundry (getfoundry.sh); it prints an `Address:` line and a `Private key:` line and writes nothing to
disk, so whatever you do not paste somewhere is gone when you close the terminal. That is the safest
property it has and the reason to do all four in one sitting.

If you would rather not install Foundry, this repo already depends on viem, so Node can do it. Run it
from `apps/api`, which is where viem is installed:

    cd apps/api && node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts'); \
      const k=generatePrivateKey(); console.log('address     '+privateKeyToAccount(k).address); \
      console.log('private key '+k)"

**What goes in `.env`, exactly.** `FOUNDER_FEE_WALLET` and `PROTOCOL_FEE_WALLET` take the **address**
— the `0x…` string of 40 hex characters, which is public, safe to share, and is what a buyer would see
on the explorer anyway. `TREASURY_WALLET_SECRET` and `ESCROW_WALLET_SECRET` take the **secret**, and
the server accepts three shapes of it (`apps/api/src/chain/keys.ts`, `loadSecret`):

| shape | example | note |
|---|---|---|
| a hex private key | `TREASURY_WALLET_SECRET=0x4f3c…` | 64 hex characters, `0x` optional. Exactly what `cast wallet new` printed. |
| a JSON byte array | `TREASURY_WALLET_SECRET=[79,60,…]` | 32 numbers, 0–255. |
| a **path** to a file holding that JSON byte array | `TREASURY_WALLET_SECRET=/Users/you/.vantra/treasury.json` | The file must contain the byte array — a file containing a bare hex string is rejected. |

The path form is the one to use on a server: the secret lives in a file you control the permissions
of, and `.env` only ever names where it is. The key itself is read into the process, used to sign, and
never leaves the machine — nothing is ever sent to an RPC to be signed.

`pnpm ready` prints the address of each of the four back to you, so you can see at a glance that
you pasted what you meant to.

---

## Step 3. The brains — at least one of these, and this is the real purchase

This is the only thing on the list that actually takes money, and it is the one change that turns the
simulation into a product.

| Buy | Where | Put it in `.env` as |
|---|---|---|
| **Anthropic — $20 of credit (start here)** | console.anthropic.com → Billing → then API keys → Create key | `ANTHROPIC_API_KEY` |
| OpenAI — $5 of credit | platform.openai.com → Billing → then platform.openai.com/api-keys | `OPENAI_API_KEY` |
| OpenRouter — $5 of credit | openrouter.ai/credits → then openrouter.ai/keys | `OPENROUTER_API_KEY` |

Then set:

    LLM_PROVIDER=router

**That line is not optional, and the server now enforces it.** With `LLM_PROVIDER=mock` — which is the
default — every agent thinks with a canned script instead of a real model, no matter how many keys you
have pasted. That is the one mistake that would make the whole thing a puppet show without telling
you, so as of this build it is no longer possible: paste a key, leave the mode on `mock`, and the boot
stops dead with

    ANTHROPIC_API_KEY is set, but LLM_PROVIDER=mock — every agent would think with a canned
    script and the key would never be called
    FIX: Set LLM_PROVIDER=router in .env to use the key, or remove the key if you meant to stay
    on the mock.

`pnpm ready` reports the same thing as a FAILURE. (`pnpm demo` forces the mock on purpose and is
exempt, so the zero-key demo always runs.)

Leave `LLM_ALLOWED_MODELS` empty. Empty means "every model I have a key for".

**Which tier needs which key.** Each tier is sold with a specific model, and `pnpm ready` warns
you if a tier cannot get its own:

| tier | buyer pays | the model it is sold with | whose key |
|---|---|---|---|
| SPARK | $10 | `gpt-5-nano` | OpenAI |
| SCOUT | $25 | `claude-haiku-4-5` | Anthropic |
| OPERATOR | $50 | `claude-sonnet-5` | Anthropic |
| PRIME | $100 | `claude-opus-5` | Anthropic |

Anthropic alone covers three of the four tiers, which is why it is the one to buy first. Without an
OpenAI key a SPARK buyer silently gets a different model.

### What the $20 actually is

It is a float, not a cost. Every agent pays for its own thinking out of the money it was bought with,
and once an hour the system sweeps exactly that metered amount out of the agent's wallet into
`PROTOCOL_FEE_WALLET` as USDC. Your API bill comes back to you. What you need up front is enough to
cover what the colony burns between your provider's invoices.

What one agent costs you per day, at each tier's floor price
(contract numbers from `docs/SPEC-V2.md` §2.5, asserted in `packages/shared/test/tiers.test.ts`):

| tier | thinking/day | + rent | total | how long it lives |
|---|---|---|---|---|
| SPARK | $0.011 | $0.12 | $0.131/day | 68.8 days |
| SCOUT | $0.162 | $0.12 | $0.282/day | 79.8 days |
| OPERATOR | $0.324 | $0.12 | $0.444/day | 101.4 days |
| PRIME | $0.540 | $0.12 | $0.660/day | 136.4 days |

So **$20 carries roughly ten SCOUT agents for a week**, and it is reimbursed as they spend it. Start
there, watch `GET /api/treasury`, and top up before the colony grows.

---

## Step 4. Web search — free, and agents are much dumber without it

| Get | Where | Cost | Put it in `.env` as |
|---|---|---|---|
| Brave Search | brave.com/search/api | Free plan: 2,000 queries/month (card required, charges $0) | `BRAVE_API_KEY` |
| Tavily (alternative) | tavily.com | Free: 1,000 queries/month, no card | `TAVILY_API_KEY` |

Then set **one** of:

    SEARCH_PROVIDER=brave
    SEARCH_PROVIDER=tavily

Leave it at `none` to ship without search — SPARK has no `web_search` tool anyway, so only SCOUT and
above notice. `pnpm ready` runs one real search with your key and tells you how many results
came back, and warns you if you pasted a key but left `SEARCH_PROVIDER=none`, in which case the key
is never used.

---

## Step 5. A Robinhood Chain connection — free

| Get | Where | Put it in `.env` as |
|---|---|---|
| The public mainnet node | nothing to sign up for | `RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com` |
| An Alchemy key, for testnet | alchemy.com → create an app on Robinhood Chain testnet | `RHC_RPC_URL=https://robinhood-testnet.g.alchemy.com/v2/YOURKEY` |

Robinhood Chain's mainnet endpoint is public and keyless — there is nothing to buy and nobody to sign
up with. It is rate limited and comes with no SLA, which is fine while you are finding your feet and
thin once the colony is real; at that point put your own provider's URL on the same line. The testnet
is the other way round: it has **no** keyless public endpoint, and the documented one is Alchemy's, so
that is the one place in this step you need a (free) key.

**You have to fill this line in before `CHAIN_MODE=robinhood` will start**, even though the variable
has a default and the default is the perfectly good public mainnet URL. The endpoint has to be
*typed*, not inherited. A blank line quietly resolving to some default network is how a deployment
ends up reading a chain nobody meant it to read — mainnet money against a test build, or test money
against the real one — so the server refuses to boot until the endpoint is named out loud:

    RHC_RPC_URL is required when CHAIN_MODE=robinhood: name the endpoint explicitly rather than
    inheriting the mainnet default. Robinhood Chain testnet has no keyless endpoint — use your
    Alchemy URL, https://robinhood-testnet.g.alchemy.com/v2/<KEY>.

The browser needs a route to the chain too, and **it reads a different file**: `VITE_RHC_RPC_URL` in
`apps/web/.env`, never the root `.env`. On testnet, leave it empty. Anything named `VITE_*` is
compiled into the JavaScript you serve to every visitor, and your Alchemy URL has your key in it;
unset, the browser reads through the API's own same-origin `/rpc` proxy and the key stays on the
server. Set it only to point the browser straight at an endpoint that carries no key.

`pnpm ready` does not take your word for which network a URL points at — it asks the endpoint for its
chain id and tells you if `RHC_NETWORK` disagrees. Mainnet is **4663**; testnet is **46630**. Getting
that wrong is the expensive mistake in both directions: real purchases sent to a chain nobody is
watching, or test purchases aimed at real money. USDC also lives at a different address on each
network, so a mismatch makes every deposit unreadable rather than merely wrong.

---

## Step 6. Turn the real chain on (free, on testnet)

    CHAIN_MODE=robinhood
    RHC_NETWORK=testnet

`CHAIN_MODE=memory` is the default and it means no money moves at all — purchases are simulated
inside the app. `pnpm ready` reports `memory` as a FAILURE for exactly that reason.

Then the treasury needs two things on testnet: a little ETH to pay gas with, and some test stablecoin
to move around.

**I am not going to give you a faucet link, because I do not have one I can stand behind.** Robinhood
Chain is new and its testnet faucet is whatever Robinhood Chain's own documentation says it is today.
Go there, find the faucet it publishes, and send testnet ETH to your treasury address. If the docs
also name a test USDC deployment, write its address down — you need it two paragraphs from now. A
faucet you found in a search result that asks for anything more than an address is not a faucet.

On mainnet there is no faucet and there never will be. Robinhood Chain is an Arbitrum Orbit L2, so
real ETH gets there by **bridging from Ethereum L1**: you send ETH into the chain's bridge on L1 and
it arrives at the same address on the L2. Gas on an Orbit chain is cheap — cheap enough that it is not
the line item you will worry about — but it is not free, and a treasury with no ETH cannot pay a
single fee.

`pnpm ready` reads the treasury's actual ETH and USDC balances and tells you where they stand; boot
preflight warns separately when the treasury holds no ETH at all, because that is the one state in
which nothing works. The treasury does **not** need to hold the agents' money in advance: each
purchase pays for its own agent.

`USDC_ADDRESS` is the line that behaves differently on each network. On **mainnet, leave it empty** —
empty means the canonical bridged USDC, and `pnpm ready` confirms that contract really is there and
really has 6 decimals. (Name USDG's address here instead if you would rather settle in that; it is the
other 6-decimal dollar on this chain, so nothing else in the app changes.) On **testnet the server
refuses to start until you name an address**, because the built-in default is the mainnet contract and
it does not exist there:

    USDC_ADDRESS is required when RHC_NETWORK=testnet: the built-in default is mainnet USDC
    (0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8), which does not exist on testnet. Bridge test
    USDC and name the address it lands at.

---

## Step 7. Containers for agent code — free

Agents at OPERATOR and above can run code. That code must run inside a container, never directly on
your machine.

1. Install **OrbStack** (orbstack.dev, free, much lighter than Docker Desktop on a Mac) and open it
   once so it starts.
2. Build the image, once:

       docker build -t vantra-sandbox:latest docker/sandbox

3. Then set:

       SANDBOX_DRIVER=docker

`SANDBOX_DRIVER=local` is the default and it runs agent code straight on your machine. It is fine on
your own laptop while everything is simulated; the server refuses to start with it in production **and
refuses to start with it the moment `CHAIN_MODE=robinhood`**, because at that point those agents are
holding real keys. `pnpm ready` reports `local` as a FAILURE, checks the image is built, and then
actually starts a container, runs a command in it and reads a file back out — so a PASS on that line
means it really works, not that it should.

`SANDBOX_DRIVER=docker` with Docker not running is also a refusal now, not a surprise later:

    SANDBOX_DRIVER=docker but the Docker daemon did not answer
    FIX: Start Docker (OrbStack or Docker Desktop) and check `docker info`, or set
    SANDBOX_DRIVER=local for an unisolated development run.

and if the daemon is up but you never ran the `docker build` above, it names that instead.

`SANDBOX_IMAGE` can stay at its default (`vantra-sandbox:latest`). `SANDBOX_NETWORK` too.

One more, and only when you move to a server:

    SANDBOX_EGRESS_FILTERED=1

Set that **after** installing the host firewall rules in `docs/OPERATIONS.md`. It is the other half
of the fence around agent code, and the server will not start in production without it.

---

## Step 8. Knobs you may want, no key needed

| Variable | Default | What it does |
|---|---|---|
| `FOUNDER_FEE_BPS` | `1000` | Your cut in basis points. 1000 = 10%. Refuses to start above 3000 (30%). |
| `MIN_PURCHASE_USD` | `10` | The SPARK floor. Below it a purchase is rejected. |
| `MAX_PURCHASE_USD` | `1000` | The ceiling. |
| `PURCHASE_TTL_HOURS` | `72` | How long a buyer's one-time deposit address stays live. |
| `DEPOSIT_POLL_MS` | 2000 in memory / 10000 on Robinhood Chain | How often pending deposits are checked. Every check on a real chain costs you an RPC call. |
| `ACCEPT_ETH_DEPOSITS` | `1` | Accept ETH as well as USDC at a deposit address, valued at `ETH_PRICE_USD`. |
| `ETH_PRICE_USD` | `3000` | Fallback ETH price, used on testnet and when the live price feed is down. |
| `LIFI_API_KEY` | empty | Optional. Agents swap through LI.FI, which is keyless; a key only raises your rate limit. |
| `RENT_PER_HOUR_USD` | `0.005` | About $0.12/day while an agent is awake, a fifth of that asleep. |
| `EXTERNAL_PAYER_WALLETS` | empty | Wallets you have personally verified as genuine outside customers. |
| `PUBLIC_URL` / `API_URL` / `SITES_BASE_URL` | localhost | Set these to your real hostnames when you deploy. |

---

## Step 9. Letting agents launch a coin — optional, off by default

An agent can have its own token on **Pons V2**, the launchpad on Robinhood Chain. Nothing here happens
until you turn it on:

    TOKEN_LAUNCH_ENABLED=1

Left off — which is the default — `POST /api/agents/:id/launch-token` answers *"Token launches are not
enabled on this deployment."* and no contract is ever touched. With it on, only an agent's own owner
can launch its coin, and only once: one agent, one token, permanently.

**Who pays.** The launch fee is **0.0005 ETH**, and it is paid by **that agent's own wallet** — not
your treasury, not you. The agent signs the launch itself, and that is the entire point: the factory
records the agent as the deployer and as the `creatorFeeRecipient`, so the creator tax on every later
trade of that coin accrues to the agent from then on. It is fixed at launch. There is no later wiring
step and no way to redirect it afterwards, by you or by anyone.

| Variable | Default | What it does |
|---|---|---|
| `TOKEN_LAUNCH_ENABLED` | `0` | Gates the whole feature. |
| `PONS_CREATOR_TAX_BPS` | `1000` | The creator tax in basis points. 1000 = 10%, which is also Pons's own ceiling (`maxCreatorTaxBps` is 1000). The server refuses to boot above it rather than letting every launch revert on chain. |

The money comes back on a two-hourly loop, and none of it is yours to run: the system checks what each
tokenized agent is owed in the Pons fee escrow, and when it is worth more than the gas, the **agent's
own wallet** sends the claim and pays for it. The ETH lands in the agent's wallet and is booked like
any other income. No key of yours signs any part of that.

So: leave a little ETH in an agent before you let it launch. A wallet with no gas can neither launch a
coin nor claim what the coin has already earned.

---

## Step 10. Going live with real money

Do this **after** you have bought a few agents yourself on testnet and watched them work.

1. Put the mainnet endpoint in `RHC_RPC_URL` — `https://rpc.mainnet.chain.robinhood.com`, or your own
   provider's URL if you expect more than a trickle. `VITE_RHC_RPC_URL` in `apps/web/.env` can stay
   empty: the browser reads through the API's `/rpc` proxy.
2. Clear `USDC_ADDRESS` so the real bridged mainnet USDC is used.
3. Set `RHC_NETWORK=mainnet` **and** `ALLOW_MAINNET=1`. Both. The server refuses to start on
   mainnet without that second flag, deliberately — it is the last thing standing between a typo and
   real money.
4. Put real ETH in the treasury for gas, bridged from Ethereum L1. L2 gas is cheap, but the treasury
   signs on behalf of every agent, so it is the one wallet that must never run dry.
5. Set `NODE_ENV=production`, `SANDBOX_DRIVER=docker` and `SANDBOX_EGRESS_FILTERED=1`.
6. Run `pnpm ready` one final time.

Only when every required line passes **and** you are pointed at mainnet does it print
**READY FOR REAL MONEY**. Until then it prints an ordered list of exactly what is left.

You will also want, and neither is a key:

- A server, about **$6/month** (Hetzner or DigitalOcean), so it keeps running when your laptop is
  shut. Then set `PUBLIC_URL`, `API_URL` and `SITES_BASE_URL` to the real hostnames.
- A domain, about **$12/year**.

---

## The whole bill

    Anthropic credit        $20    (a float — the agents pay it back)
    Brave search            $0     (free plan)
    Robinhood Chain RPC     $0     (public on mainnet; free Alchemy key on testnet)
    Four EVM wallets        $0     (you generate them)
    Two secrets             $0     (you generate them)
    OrbStack                $0
    Server                  $6/mo
    Domain                  ~$12/yr
    ------------------------------
    about $26 to be live

Your revenue is `FOUNDER_FEE_BPS` of every purchase. At the default 10%, twenty $25 agents puts $50
in `FOUNDER_FEE_WALLET`, and the other $450 is the agents' own money to spend on thinking.
