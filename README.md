# YAP: CIP-56 token on Canton testnet

A from-scratch implementation of the Canton Token Standard (CIP-0056 V1 and V2): the Daml contracts **and** the off-ledger registry API that wallets use to discover them, plus an optional **multi-owner governor** built on the Decentralization Manager.

> **Status: v0.7.0 (yap-governance 0.2.0), testnet only.** Never on mainnet, never audited. "YAP" is just a ticker: the token is self-issued by its admin party and is **not** a stablecoin and **not** backed by anything. The live deployment is on `cryptolampung-testnet-1` (Splice 0.9.0, Canton 3.6.1).

## What it implements

| Piece | Here |
|---|---|
| Holding (V1 + V2 views) | `YapHolding` (UTXO; locks) |
| Transfers (V1 + V2) | `YapTransferFactory`, `YapTransferInstruction`: **offer** (receiver accepts), **direct** (receiver has a `YapTransferPreapproval`), **self**. V2 is advertised by the registry only with `CUSDT_ENABLE_V2=1` |
| Allocations (V1) | `YapAllocationFactory`, `YapAllocation`; cross-participant settlement through `YapSettlementProposal` / `YapSettlementAuthority` |
| BurnMint (burn-mint-v1) | `YapBurnMintFactory`: reshape / net mint / net burn; the admin always acts, the owner of a burnt holding must co-sign |
| Locks | `YapHolding_Lock` (holders can release early; no holders = a pure time lock), expiry is automatic |
| Linear vesting | `YapAdmin_GrantVesting`, `YapVesting` (claim / revoke / close); the unvested part is an ordinary locked holding |
| Operator / governor split (0.7.0) | `YapOperatorAuthority`: a day-to-day **operator** mints and grants vestings inside a shrinking **allowance** until an expiry; only the **governor** (the admin party) tops it up, revokes it, revokes vestings, runs BurnMint or archives holdings |
| Governed actions (yap-governance) | `AppointOperator`, `SetOperatorAllowance`, `RevokeOperator`, `RevokeVesting`, `GovernorMint`, `RescueHolding`, `BurnTreasury` proposals (`GovernableAction`) for a decentralized governor |
| Registry APIs | `registry/` (off-ledger HTTP, see below) |
| Not implemented | Allocation V2, a wallet that speaks V2 end to end (untested), governed BurnMint of holdings owned by others |

Rules worth knowing: amounts are limited to **6 decimals** on every entry point; `executeBefore` is honored; the admin is the only signatory of every holding, so a **single-owner** admin can still archive any holding (built-in `Archive`). That is the reason for the optional multi-owner governor below.

## Roles

- **Governor** = the `admin` party of the instrument. Either an ordinary party (the original deployment) or a **decentralized party** (2-of-2 over two validators) that can only act through governed actions.
- **Operator** = an ordinary party that holds a `YapOperatorAuthority`. It cannot archive holdings, revoke vestings, run BurnMint or raise its own limits.
- Day-to-day mint contention: `YapOperator_Mint` is consuming, so parallel mints on the same authority collide (1 wins). Re-read the latest authority and retry, or appoint several authorities (split the allowance) and rotate.

## Layout

| Path | What |
|---|---|
| `daml/yap-token/` | The token package (`daml/YapToken.daml`) and the vendored Splice API DARs (`dars/`, see its README) |
| `daml/yap-token-test/` | Daml Script unit tests (+ `mutations.py`, a mutation tester: 106 mutations, the survivors are equivalent double guards) |
| `daml/yap-governance/` | Governed-action proposals for a decentralized governor (needs `governance-action-v1` from DLC-link, vendored in `dars/`) |
| `daml/yap-governance-test/` | Unit tests for those proposals |
| `registry/` | Registry server, zero-dependency Node >= 18 (`src/server.mjs`); `test/local.mjs` runs it against a mock ledger |
| `scripts/` | Testnet deploy + live tests, numbered in the order you would use them (each file's header says what it does) |
| `sdk-test/` | Drives YAP through the official `@canton-network/wallet-sdk` |
| `deploy/` | Generator for the paste-able VPS scripts (`templates/` + `generate.mjs`; output goes to the git-ignored `deploy/out/`) |

## Build and test (no local Daml SDK needed)

`node deploy/generate.mjs` writes self-contained scripts into `deploy/out/`. On a fresh VPS:

1. `build-test-fresh-vps.sh`: JDK + dpm, sha256-verified Splice DARs, builds `yap-token`, runs the Daml Script tests.
2. `build-test-governance-on-vps.sh`: builds `yap-governance` and runs its tests (needs step 1 first).
3. `mutation-test-on-vps.sh`: the mutation run (long).

Changing a package that is already uploaded **requires a version bump** (same name + version with other content is refused). Adding templates or choices is SCU-compatible.

## Deploy (testnet)

Configuration lives in `.env.testnet` (git-ignored; copy `.env.testnet.example`): a Keycloak client able to act on the participant, `LEDGER_USER_ID`, and the party ids (`CUSDT_ADMIN_PARTY`, `CUSDT_ALICE`, `CUSDT_BOB`, `CUSDT_OPERATOR`).

1. Build the DAR (above) and check its SHA-256 on the PC. `node scripts/1-upload-dar.mjs <path.dar>`.
2. First time only: `scripts/2-setup.mjs` (admin party + singletons), `scripts/11-create-allocation-factory.mjs`. After an upgrade: `scripts/8-rotate-singletons.mjs` so the singletons run the new code.
3. Registry: `install-registry-on-vps.sh` / `update-registry-on-vps.sh` (systemd service on 127.0.0.1:8787 behind nginx). Give it a **read-only** Keycloak client.
4. Real auth on the validator is **not optional**: a Splice bundle upgrade resets the ledger API to open (`unsafe-jwt-hmac-256`). Verify with a no-token call after every upgrade.
5. nginx: `client_max_body_size 20m` in both layers (the 0.7.0 DAR is ~1.1 MB; the default is 1 MiB).

## Multi-owner governor with the Decentralization Manager (DecMan)

Optional and tested on testnet only (two validators, 2-of-2). The scripts are in `deploy/templates/decman-*.sh.in`:

`decman-discover` (read-only survey) → `decman-install` (pinned image next to the validator, UI on localhost, Noise port limited to the peer) → `decman-api` (trust the validator's own Keycloak client, curl helper) → `decman-peers` → onboarding (`POST /onboarding`, the peer accepts) → `decman-party-creds` → `decman-dars` + `decman-governance` (GovernanceRules, threshold 2) → `decman-cusdt` (DARs + the four singleton contracts as the decentralized party) → `decman-vote` (confirm / execute by action label) → `decman-harden` (systemd firewall rule, encrypted state backup).

Facts that matter: both nodes host the party with **confirmation-only** permission (nobody can submit alone); proposals are plain ledger creates by a member (not `/governance/propose`, which only knows built-in types); several proposals can be open, so always pass the action label; confirmations expire after 30 minutes; a proposal names the target contract id, so a stale id makes the execution fail harmlessly (propose again). `scripts/40-live-governed.mjs` proves the whole path (13 checks). Real security needs **independent** operators; both nodes here are one person's.

## Tests

All live tests run against the testnet and restore the supply (most end with "supply is back to the start"). Set `CUSDT_REGISTRY_URL` to your registry where a script needs it.

| Script | Covers |
|---|---|
| `scripts/6, 7, 10, 12, 13` | Transfer rules, disclosure, preapprovals, allocations, 6-decimal limit |
| `scripts/14-17` | Invariant soak, contention, preapproval cap, edge cases |
| `scripts/21-34` | Cross-participant / three-node settlement, races, registry fuzz, spam and websocket ACS |
| `scripts/35-live-burnmint-v2.mjs` | BurnMint + V2 transfers (28 checks) |
| `scripts/36-live-lock-vesting.mjs` | Locks, expiry, linear vesting (32 checks) |
| `scripts/37-live-operator.mjs` | Operator allowance, expiry, limits, governor revoke (21 checks) |
| `scripts/38-live-operator-registry.mjs` | Operator-minted tokens through the registry (V1/V2 offer, direct) |
| `scripts/39-live-operator-contention.mjs` | Parallel operator mints (1 wins) and re-read + retry |
| `scripts/40-live-governed.mjs` | The decentralized governor end to end (has two human steps on the VPSes) |
| `sdk-test/flows.mjs` | The same flows built by the official Wallet SDK (`npm install --ignore-scripts` first) |

## Known limits

- Preapproval lookup scans all of the admin's preapprovals; the Ledger JSON API caps that at 200 elements (raise it with `ADDITIONAL_CONFIG_LIST_LIMIT` or use the websocket stream). On failure the registry falls back to an offer.
- The registry's TLS certificate is a normal Let's Encrypt one; the ledger/validator/auth hosts stay self-signed on purpose.
- With a single-owner admin: unlimited mint, and the admin can destroy any holding. There is no pause.
- Internal and external parties can transfer to each other freely (each step is signed by one kind), but ONE transaction cannot need both: an interactive (externally signed) submission requires an external-party submitter.
- `settleBefore` of an allocation is recorded, not enforced automatically: the sender can always withdraw.
- Governed BurnMint only works on holdings the governor owns (the owner of a burnt holding must co-sign).
- Buy / sell against USDCx is **not** part of this repo.
