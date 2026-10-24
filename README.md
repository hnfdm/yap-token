# YAP: CIP-56 token on Canton testnet

The Daml contracts, the off-ledger registry API and the operations tooling for **$YAP**, the token of Yapper Agent on Canton Network: a from-scratch implementation of the Canton Token Standard (CIP-0056 **V1 and V2**), issued by a **multi-owner governor** (a Canton decentralized party managed with the Decentralization Manager).

> **Status: yap-token 0.8.0 + yap-governance 0.4.0, testnet only.** Never on mainnet, never audited. The testnet token is a rehearsal of the launch described in the tokenomics draft v1.3 (100,000,000 fixed supply, no token sale); it has no value. The repository was called `cusdt-token` while it was a stablecoin-style test token; some identifiers that exist on a live ledger or server kept the old name on purpose (party ids `cusdt-*`, env vars `CUSDT_*`, the `cusdt-registry` service, the preapproval metadata key).

## The YAP testnet instance

| | |
|---|---|
| Governor (admin) | a 2-of-2 decentralized party over two validators; nobody can act alone (checked: a direct command from one node is refused, an execution with 1 of 2 confirmations is refused by the ledger) |
| Supply | **100,000,000 YAP, issued once** to the governor's treasury by three governed mints (60M + 20M + 20M) |
| Allocation | one governed decision (`AllocationProposal`) paid the whole treasury out to nine pool parties following the tokenomics: airdrop 15M, creator 22M (four yearly slices 8 / 6 / 4.5 / 3.5M), staking 7M, ecosystem 10M, liquidity 8M, marketing 5M, treasury 13.5M, team 15M, advisors 3M. TGE share free to use = **6,250,000** (as in the document); the rest is on-ledger vesting. The treasury pool is 13.5M instead of 15M on this instance because 1.5M of test tokens left the treasury before the schedule |
| Supply invariant | exactly 100,000,000 after every step of the launch and the allocation (`scripts/42`, `43` check it) |
| Registry | `https://yap-registry-testnet.yapperagent.xyz` (Let's Encrypt), read by the official Wallet SDK: discovery, offer / accept / reject / withdraw and UTXO merge pass (`sdk-test/yap-flows.mjs`) |

**What "fixed supply" means here.** The cap is enforced by governance, not by the contract: the governor *can* still mint (`YapAdmin_Mint` / the governed `GovernorMint`), but only by a decision of both nodes, and a mint is visible on the ledger. A contract-level hard cap would not help because the admin is the only signatory of every holding.

**Vesting differences to the document**, on purpose: vesting is continuous (per second) instead of equal monthly portions; a month is 30 days; vesting starts after the cliff; no grant is revocable.

**Not in this repository**: the application-level mechanics of the document (staking plans with multipliers, fee buyback and burn, Jobs escrow, points-to-token conversion, the DEX pool). Burning treasury tokens is supported (`BurnTreasury`).

## What the token package implements

| Piece | Here |
|---|---|
| Holding (V1 + V2 views) | `YapHolding` (UTXO; locks) |
| Transfers (V1 + V2) | `YapTransferFactory`, `YapTransferInstruction`: **offer** (receiver accepts), **direct** (receiver has a `YapTransferPreapproval`), **self**. V2 is advertised by the registry only with `CUSDT_ENABLE_V2=1` |
| Allocations (V1) | `YapAllocationFactory`, `YapAllocation`; cross-participant settlement through `YapSettlementProposal` / `YapSettlementAuthority` |
| BurnMint (burn-mint-v1) | `YapBurnMintFactory`: reshape / net mint / net burn; the admin always acts, the owner of a burnt holding must co-sign |
| Locks | `YapHolding_Lock` (holders can release early; no holders = a pure time lock), expiry is automatic |
| Linear vesting | `YapAdmin_GrantVesting` (mints) and `YapAdmin_GrantVestingFromTreasury` (paid from the admin's own holdings, supply unchanged); `YapVesting` (claim / revoke / close); the unvested part is an ordinary locked holding |
| Operator / governor split | `YapOperatorAuthority`: a day-to-day **operator** mints and grants vestings inside a shrinking **allowance** until an expiry; only the **governor** tops it up, revokes it, revokes vestings, runs BurnMint or archives holdings |
| Not implemented | Allocation V2; a wallet that speaks V2 end to end (V2 transfers work through the registry, no V2 wallet was available to test) |

Rules worth knowing: amounts are limited to **6 decimals** on every entry point; `executeBefore` is honored. The admin is the only signatory of every holding, so a **single-owner** admin can still archive any holding (built-in `Archive`); with the decentralized governor that power needs both nodes.

### Governed actions (`yap-governance`)

Proposals implementing `GovernableAction` from the Decentralization Manager's `governance-action-v1`. A member creates one, both nodes confirm, the governor executes it with its own authority:

`AppointOperator`, `SetOperatorAllowance`, `RevokeOperator`, `RevokeVesting`, `GovernorMint`, `RescueHolding`, `BurnTreasury`, `GrantVestingFromTreasury`, `TreasuryTransfer`, and **`AllocationProposal`** (a list of immediate releases and vesting grants paid out of the treasury in order, the change of each step feeding the next; atomic).

Every proposal names the contract it acts on, so a stale contract id makes the execution fail harmlessly (propose again with the current id), and every proposal checks that its target belongs to the governance party.

## Roles

- **Governor** = the `admin` party. Either an ordinary party (single-owner deployments, scripts 2 to 39) or a **decentralized party** that can only act through governed actions (the YAP instance, scripts 40 to 43).
- **Operator** = an ordinary party that holds a `YapOperatorAuthority`. It cannot archive holdings, revoke vestings, run BurnMint or raise its own limits. `YapOperator_Mint` is consuming, so parallel mints on one authority collide (1 wins): re-read the latest authority and retry, or appoint several authorities.

## Layout

| Path | What |
|---|---|
| `daml/yap-token/` | The token package (`daml/YapToken.daml`) and the vendored Splice API DARs (`dars/`, see its README) |
| `daml/yap-token-test/` | Daml Script unit tests (+ `mutations.py`, a mutation tester: 106 mutations, the survivors are equivalent double guards) |
| `daml/yap-governance/` | The governed actions (needs `governance-action-v1` from DLC-Link, vendored in `dars/`) |
| `daml/yap-governance-test/` | Unit tests for those proposals |
| `registry/` | Registry server, zero-dependency Node >= 18 (`src/server.mjs`); `test/local.mjs` runs it against a mock ledger |
| `scripts/` | Testnet deploy + live tests, numbered in the order you would use them (each file's header says what it does) |
| `sdk-test/` | Drives YAP through the official `@canton-network/wallet-sdk` |
| `deploy/` | Generator for the paste-able VPS scripts (`templates/` + `generate.mjs`; output goes to the git-ignored `deploy/out/`) |
| `docs/PARTNER-GUIDE.md` | Guide (Indonesian) for an independent party who runs a node and holds a governor key |

## Build and test (no local Daml SDK needed)

`node deploy/generate.mjs` writes self-contained scripts into `deploy/out/`. On a fresh VPS:

1. `build-test-fresh-vps.sh`: JDK + dpm, sha256-verified Splice DARs, builds `yap-token`, runs the Daml Script tests.
2. `build-test-governance-on-vps.sh`: builds `yap-governance` and runs its tests (needs step 1 first).
3. `mutation-test-on-vps.sh`: the mutation run (long).

Changing a package that is already uploaded **requires a version bump** (same name + version with other content is refused). Adding templates or choices is SCU-compatible. Check the sha256 of every DAR you move between hosts.

## Deploy

Configuration lives in `.env.testnet` (git-ignored; copy `.env.testnet.example`): a Keycloak client able to act on the participant, `LEDGER_USER_ID`, and the party ids (`CUSDT_ADMIN_PARTY`, `CUSDT_ALICE`, `CUSDT_BOB`, `CUSDT_OPERATOR`, `YAP_POOL_*`).

**Single-owner admin** (simplest; scripts 2 to 39 are written for it): build and upload the DAR (`scripts/1-upload-dar.mjs`), `scripts/2-setup.mjs` (admin party + singletons), `scripts/11-create-allocation-factory.mjs`; after an upgrade `scripts/8-rotate-singletons.mjs`. Registry: `install-registry-on-vps.sh` / `update-registry-on-vps.sh`.

**Decentralized admin** (YAP): see the next section, then the registry with `install-registry-yap-on-vps.sh` (a second systemd service, `yap-registry` on 127.0.0.1:8788, next to any existing registry; optional own HTTPS name with `DOMAIN=...`; the DNS record must be **DNS only**, not proxied, for Let's Encrypt).

Always: real auth on the validator is **not optional**. A Splice bundle upgrade resets the ledger API to open (`unsafe-jwt-hmac-256`); verify with a no-token call after every upgrade (it must answer 401). nginx needs `client_max_body_size 20m` in both layers (the DAR is ~1.1 MB; the default is 1 MiB).

## Multi-owner governor with the Decentralization Manager (DecMan)

Scripts in `deploy/templates/decman-*.sh.in`, in this order:

`decman-discover` (read-only survey) → `decman-install` (pinned image next to the validator, UI on localhost only, Noise port limited to the peer) → `decman-api` (trust the validator's own Keycloak client; everything then works with `curl` from the VPS) → `decman-peers` → onboarding (`POST /onboarding`, the peer accepts the invitation) → `decman-party-creds` → `decman-dars` + `decman-governance` (GovernanceRules, threshold 2) → `decman-cusdt` (distribute the DARs, then create the singleton contracts as the decentralized party; the file name predates the rename) → `decman-vote` → `decman-harden` (firewall rule that survives a reboot via systemd, encrypted state backup).

Facts that matter:

- Both nodes host the party with **confirmation-only** permission: nobody can submit alone. Proposals are plain ledger creates by a member (`/governance/propose` only knows the built-in types).
- **Wait until the DAR run is `completed` and the peer has accepted it before starting the contracts run** (starting it early fails with "package not vetted by all hosting participants"). A stuck run can be cancelled (`POST /workflows/<run>/cancel`) and a failed one dismissed (`/dismiss`).
- Several proposals can be open at once: pass the action label (`decman-vote-on-vps.sh confirm <label>`). `confirm-all` lists the open proposals and pauses 15 s; it prints only the *description*. **Review the content before confirming**: DecMan does not show the items of a proposal, `node scripts/show-allocation-proposal.mjs` reads them from the ledger.
- Confirmations expire after 30 minutes.
- Docker bypasses ufw: the Noise port rule goes into `DOCKER-USER` and must be limited to **inbound** packets on the public interface, otherwise it also drops the container's own outgoing connections.
- SFTP with a path that does not start with `/` lands under the login directory (`/root/opt/...`).

**What the testing proves, and what it does not.** All of it was run with two DecMan nodes operated by one person. Mechanically that is identical to two independent operators (the ledger enforces the threshold, not the people), which is what the tests exercise. The *security* property, however, only exists if the operators are independent. See `docs/PARTNER-GUIDE.md` for the role of a second operator and how to join (the "add member" procedure itself is not yet rehearsed).

## Tests

Live tests run against the testnet and restore state where they can.

| Script | Covers | Needs |
|---|---|---|
| `scripts/6, 7, 10, 12, 13` | Transfer rules, disclosure, preapprovals, allocations, 6-decimal limit | single-owner admin |
| `scripts/14-17` | Invariant soak, contention, preapproval cap, edge cases | single-owner admin |
| `scripts/21-34` | Cross-participant / three-node settlement, races, registry fuzz, spam, websocket ACS | single-owner admin |
| `scripts/35-39` | BurnMint + V2, locks + vesting, operator (allowance, registry, contention) | single-owner admin |
| `scripts/40-live-governed.mjs` | The decentralized governor end to end: appoint / revoke operator through proposals, mint, registry transfer (13 checks, two human steps on the VPSes) | decentralized admin |
| `scripts/41-live-governed-burn.mjs` | Governed `BurnTreasury` (8 checks) | decentralized admin |
| `scripts/42-live-yap-launch.mjs` | The launch: 100M issued once, vesting + transfer from the treasury, supply exactly 100M at every step (12 checks) | decentralized admin |
| `scripts/43-live-yap-allocation.mjs` | The tokenomics allocation in one governed decision, pools, TGE share, vesting behaviour (23 checks) | decentralized admin |
| `sdk-test/yap-flows.mjs`, `discover.mjs` | Official Wallet SDK against the public registry (5 checks + discovery) | `npm install --ignore-scripts` first |
| `sdk-test/flows.mjs` and the rest | Full wallet flows incl. preapproval and allocation execution, which need the issuer to submit | single-owner admin |

Scripts 2 to 39 and the older `sdk-test` files predate the rename: they reference the `yap-token` package, so run them against a **single-owner `yap-token` deployment** (`scripts/2-setup.mjs`), not against the governed instance. Daml tests: 64 in `yap-token-test`, 11 in `yap-governance-test`.

## Known limits

- Preapproval lookup scans all of the admin's preapprovals; the Ledger JSON API caps that at 200 elements (raise it with `ADDITIONAL_CONFIG_LIST_LIMIT` or use the websocket stream). On failure the registry falls back to an offer.
- A wallet merge (`utxos.merge` in the SDK) merges *all* holdings of a party, including instruments the registry does not know; merge only parties that hold YAP only.
- With a single-owner admin: unlimited mint, and the admin can destroy any holding. There is no pause.
- Internal and external parties can transfer to each other freely (each step is signed by one kind), but ONE transaction cannot need both: an interactive (externally signed) submission requires an external-party submitter.
- `settleBefore` of an allocation is recorded, not enforced automatically: the sender can always withdraw.
- A governed BurnMint only works on holdings the governor owns (the owner of a burnt holding must co-sign).
- "Vesting is enforced on-ledger" holds against beneficiaries and operators. The governor can still archive a holding (`RescueHolding`), so for a third party the guarantee is only as strong as the independence of the governor's owners.
- Buy / sell against USDC and the pool are **not** part of this repo.
