# cUSDT: CIP-56 token on Canton testnet

A from-scratch implementation of the Canton Token Standard (CIP-0056 v1): the Daml contracts **and** the off-ledger registry API that wallets use to discover them.

> **Status: v0.3.1, deployed and tested on the MahaWallet testnet only.** Never on mainnet, never audited. "cUSDT" is just a ticker: the token is self-issued by the `cusdt-admin` party and is **not** backed by or related to real USDT. Tested with the scripts in this repo and with the official Wallet SDK using *internal* parties; the external-party (prepare / sign) path is untested.

## What it implements

| Standard piece | Here |
|---|---|
| Holding | `CusdtHolding` (UTXO, locked holdings for allocations) |
| TransferFactory / TransferInstruction | `CusdtTransferFactory`, `CusdtTransferInstruction`: **offer** (receiver accepts), **direct** (receiver has a `CusdtTransferPreapproval`), **self** |
| AllocationFactory / Allocation | `CusdtAllocationFactory`, `CusdtAllocation` (locks funds; execute needs executor + sender + receiver; withdraw by sender; cancel by all three) |
| Token metadata / registry APIs | `registry/` (off-ledger HTTP, see below) |
| Not implemented | `AllocationInstruction` (allocations are created directly), BurnMint, Token Standard V2 |

Rules worth knowing: transfers archive the given `inputHoldingCids` and return change; `executeBefore` is honored; amounts are limited to **6 decimals** on every entry point; `Burn` is owner-only (the admin cannot burn other people's holdings); `CusdtHolding_Merge` consolidates holdings.

## Layout

| Path | What |
|---|---|
| `daml/cusdt-token/` | Daml package (`daml/CusdtToken.daml`) and the vendored Splice API DARs (`dars/`, see its README) |
| `registry/` | Registry server, zero-dependency Node >= 18 (`src/server.mjs`). Serves `/registry/metadata/v1/*`, `/registry/transfer-instruction/v1/*`, `/registry/allocation-instruction/v1/*`, `/registry/allocations/v1/*`, and the same under the Utility-style prefix `/api/token-standard/v0/registrars/<admin>/` |
| `scripts/` | Testnet deploy + tests, numbered in the order you would use them (each file's header says what it does) |
| `sdk-test/` | Drives cUSDT through the official `@canton-network/wallet-sdk` |
| `deploy/` | Generator for the paste-able VPS scripts (`templates/` + `generate.mjs`; output goes to the git-ignored `deploy/out/`) |

## Deploy (testnet)

Configuration lives in `.env.testnet` (git-ignored; copy `.env.testnet.example`). It needs a Keycloak client able to act on the participant and `LEDGER_USER_ID`.

1. **Build the DAR** (needs JDK 17+ and the Daml SDK pinned in `daml.yaml`). On a machine without them, generate the helper scripts and paste them into a shell on the validator host:
   ```
   node deploy/generate.mjs
   # deploy/out/bootstrap-vps.sh   (one-time: JDK + dpm + SDK)
   # deploy/out/update-on-vps.sh   (builds the DAR, updates the registry service)
   ```
   Copy `.daml/dist/cusdt-token-<version>.dar` back and check the SHA-256.
2. `node scripts/1-upload-dar.mjs`
3. First time only: `node scripts/2-setup.mjs` (creates the `cusdt-admin` party + singletons), put the printed `CUSDT_ADMIN_PARTY` into `.env.testnet`, then `node scripts/11-create-allocation-factory.mjs`.
4. Upgrading to a new package version: upload the DAR, then `node scripts/8-rotate-singletons.mjs` so the singletons run the new code.
5. Registry: `deploy/out/install-registry-on-vps.sh` installs it as a systemd service bound to 127.0.0.1:8787 and writes an nginx snippet for you to review. Give it a **read-only** Keycloak client: `node scripts/5-readonly-client.mjs`.
6. Try it: `node scripts/3-mint.mjs <party> 100`, then `node scripts/4-e2e-test.mjs <sender> <receiver> 10`.

## Tests

All run against the live testnet (parties `cusdt-alice` / `cusdt-bob`, balances are restored afterwards). Set `CUSDT_REGISTRY_URL` to your registry.

| Script | Covers |
|---|---|
| `scripts/6-negative-tests.mjs` | Transfer rules, authorization, expiry, merge, self-transfer |
| `scripts/7-disclosure-tests.mjs` | Ownership asserts reached via disclosed foreign contracts |
| `scripts/10-preapproval-tests.mjs` | Direct transfers, wrong or fake preapproval, cancellation |
| `scripts/12-allocation-tests.mjs` | Allocation lifecycle, locks, expiry, validation |
| `scripts/13-precision-tests.mjs` | 6-decimal limit, smallest unit |
| `sdk-test/flows.mjs` | The same flows built by the official Wallet SDK (`npm install --ignore-scripts` first) |

## Known limits

- Preapproval lookup scans all of the admin's preapprovals; the Ledger JSON API caps that at 200 elements. On failure the registry falls back to an offer instead of erroring.
- The registry's TLS certificate on the testnet is self-signed.
- The admin can mint without a cap and there is no pause; `cusdt-admin` is a participant-hosted party. Fine for a testnet, not for mainnet.
- Lock expiry (`settleBefore`) is recorded, not enforced automatically: the sender can always withdraw.
- Buy / sell against USDCx is **not** part of this repo.
