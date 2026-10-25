# YAP: CIP-56 token on Canton

Daml contracts, an off-ledger registry API and operations tooling for **$YAP** (Yapper Agent). Implements the Canton Token Standard (CIP-0056 V1 and V2). The issuer ("governor") is a **decentralized party**: no single node can act alone.

> **Testnet only, never audited.** `yap-token` 0.9.0 + `yap-governance` 0.5.0. The repository was called `cusdt-token`; identifiers that already exist on a live ledger or server kept the old name (party ids `cusdt-*`, env vars `CUSDT_*`, the `cusdt-registry` service).

## Testnet instance

| | |
|---|---|
| Governor | 2-of-2 decentralized party over two validators. A command from one node is refused; an execution with 1 of 2 confirmations is refused by the ledger |
| Supply | **100,000,000 YAP**, issued once (three governed mints) into the governor's treasury. Never changes afterwards (checked by `scripts/42`, `43`) |
| Allocation | One governed decision paid the treasury to nine pool parties as in the tokenomics v1.3: TGE 6,250,000 free, the rest on-ledger vesting. The treasury pool is 13.5M (not 15M) because 1.5M of test tokens left it earlier |
| Vesting | Continuous (per second, not monthly); 1 month = 30 days; starts after the cliff; no grant is revocable |
| Allocation V2 | Live: net settlement of two-way legs through the settlement factory, committed allocations, withdrawal and cancel (`scripts/44`). Not yet tested against any DEX or wallet |
| Registry | `https://yap-registry-testnet.yapperagent.xyz`. The official Wallet SDK discovers YAP and runs offer, accept, reject, withdraw and merge (`sdk-test/yap-flows.mjs`) |

The supply cap is enforced by **governance, not by the contract**: the governor can still mint, but only if both nodes agree, and it is visible on the ledger.

## How it works

- **Token (`yap-token`)**: UTXO holdings with V1 + V2 views; transfers (offer, direct with a preapproval, self); allocations V1 and V2 (multi-leg, net amount, committed, batch settlement through `YapSettlementFactory`) and cross-participant settlement; BurnMint; locks; linear vesting (minted, or paid from the treasury so the supply is unchanged).
- **Operator**: a day-to-day party holding a `YapOperatorAuthority` (a shrinking mint allowance with an expiry). It cannot archive holdings, revoke vestings or raise its own limits. Mints are consuming, so parallel mints on one authority collide: re-read and retry, or appoint several authorities.
- **Governed actions (`yap-governance`)**: a member creates a proposal, both nodes confirm, the governor executes it: `AppointOperator`, `SetOperatorAllowance`, `RevokeOperator`, `RevokeVesting`, `GovernorMint`, `RescueHolding`, `BurnTreasury`, `GrantVestingFromTreasury`, `TreasuryTransfer`, `AllocationProposal` (many releases and vestings in one atomic decision). A proposal names its target contract, so a stale id fails harmlessly.
- **Registry (`registry/`)**: zero-dependency Node >= 18 HTTP service for wallet discovery. V2 transfer routes are advertised with `CUSDT_ENABLE_V2=1`, the Allocation V2 routes with `CUSDT_ENABLE_ALLOCATION_V2=1`. After a package upgrade it uses the **newest** factory contract.

Not implemented: iterated allocation settlement (`nextIterationFunding` is refused with a clear message); the application mechanics of the tokenomics (staking plans, fee buyback and burn, Jobs escrow, the USDC pool).

## Layout

| Path | What |
|---|---|
| `daml/yap-token`, `daml/yap-token-test` | Token package, unit tests (73), `mutations.py` (136 mutations; 114 killed, 21 of the 22 survivors are equivalent double guards) |
| `daml/yap-governance`, `daml/yap-governance-test` | Governed actions, unit tests (11) |
| `registry/` | Registry server (`test/local.mjs`: 42 checks against a mock ledger) |
| `scripts/` | Live testnet scripts, numbered; each header says what it does |
| `sdk-test/` | Official Wallet SDK flows |
| `deploy/` | `node deploy/generate.mjs` writes paste-able VPS scripts to `deploy/out/` from `templates/` |
| `docs/PARTNER-GUIDE.md` | Guide for an independent co-signer |
| `docs/TESTING.md` | What has been tested, the results, and what has not |

## Build, test, deploy

No local Daml SDK needed. On a fresh VPS run `build-test-fresh-vps.sh` (builds `yap-token`, runs its tests), then `build-test-governance-on-vps.sh`; `mutation-test-on-vps.sh` is the long mutation run. A package that is already uploaded needs a **version bump** to change, and existing singleton contracts keep running the old code: after an upgrade create the new ones (`decman-cusdt-on-vps.sh contracts-v2` for the Allocation V2 factories) and re-run the registry install. Check the sha256 of every DAR you move.

Config is `.env.testnet` (git-ignored, see `.env.testnet.example`). Single-owner admin: `scripts/1-upload-dar.mjs`, `2-setup.mjs`, `11-create-allocation-factory.mjs`. Registry: `install-registry-on-vps.sh`, or `install-registry-yap-on-vps.sh` for a second service on port 8788 (optional own HTTPS name; the DNS record must be DNS-only, not proxied).

Two things that bite: a Splice bundle upgrade **resets ledger auth to open**, so test with a no-token call afterwards (it must answer 401); and nginx needs `client_max_body_size 20m` in both layers.

## Decentralized governor (DecMan)

Scripts `deploy/templates/decman-*.sh.in`, in order: `discover` (read-only), `install` (pinned image, UI on localhost, Noise port limited to the peer), `api` (reuse the validator's Keycloak client, then everything is `curl`), `peers`, onboarding, `party-creds`, `dars` + `governance` (GovernanceRules, threshold 2), `cusdt` (distribute DARs, create the singleton contracts; `contracts-v2` after an upgrade), `vote`, `harden` (systemd firewall rule, encrypted backup).

- Wait for the DAR run to be `completed` and accepted by the peer **before** the contracts run, or it fails with "package not vetted by all hosting participants". Stuck runs: `POST /workflows/<run>/cancel`; failed ones: `/dismiss`.
- Several proposals can be open: always pass the action label. DecMan shows only the description, so **read the content** with `node scripts/show-allocation-proposal.mjs` before confirming. Confirmations expire after 30 minutes.
- Docker bypasses ufw: limit the Noise port in `DOCKER-USER` to *inbound* packets on the public interface, or it also blocks the container's own outgoing connections.

All of this was tested with two nodes run by one person. That fully exercises the mechanism (the ledger enforces the threshold, not the people), but the **security property needs independent operators**: see `docs/PARTNER-GUIDE.md`. Joining an existing party ("add member") has not been rehearsed.

## Tests

| Script | Covers |
|---|---|
| `scripts/6` to `39` | Single-owner admin: transfer rules, allocations, soak, races, fuzz, BurnMint + V2, locks + vesting, operator. They need a single-owner `yap-token` deployment, not the governed one. `node scripts/run-single-admin-suite.mjs` sets one up (separate admin and parties, local registry) and runs the 19 scripts that work on one node, plus (`--heavy`) the 200-contract ones and (`--two-node`, second validator in `.env.t2`) 21, 22 and 24: **all passed** on 25 Oct 2026, except two assertions of script 16 that describe the default 200-element list limit (t1 has a raised one). Only the three-participant scripts (25, 27, 30, 34) were not re-run |
| `scripts/40` | Governed operator appointment and revocation, mint, registry transfer (13 checks) |
| `scripts/41` | Governed `BurnTreasury` (8) |
| `scripts/42` | Launch: 100M issued once, vesting and transfer from the treasury (12) |
| `scripts/43` | Tokenomics allocation in one governed decision (23) |
| `scripts/44` | Allocation V2 on the YAP instance: net settlement through the settlement factory, guards, committed allocations (23, no human steps) |
| `scripts/45` | Vesting claim by a pool on the governed instance (no human steps) |
| `scripts/46` | Node-failure probe: a governed transaction while t2 is stopped (needs the operator to stop and start t2) |
| `sdk-test/yap-flows.mjs` | Wallet SDK against the public registry (`npm install --ignore-scripts` first) |

Scripts 40 to 43 have human steps on the VPSes; each prints the exact commands.

## Known limits

- Preapproval lookup is capped at 200 contracts by the JSON API (raise `ADDITIONAL_CONFIG_LIST_LIMIT` or use the websocket stream); the registry then falls back to an offer.
- A wallet merge (`utxos.merge`) merges all holdings of a party, including instruments the registry does not know.
- "Vesting is enforced on-ledger" holds against beneficiaries and operators. The governor can still archive a holding (`RescueHolding`), so for third parties the guarantee is as strong as the independence of the governor's owners.
- A governed BurnMint only works on holdings the governor owns.
- An externally signed transaction cannot also need an internal party's signature.
- Allocation `settleBefore` (V1) is recorded, not enforced: the sender can always withdraw.
- Allocation V2: the executors are trusted for atomicity across instruments (as the standard assumes), and settling a single allocation alone burns its authorizer's net outflow; use the settlement factory. No venue has been tested against it yet.
