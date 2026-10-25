# What has been tested

All testing is on **Canton testnet** (Splice 0.9.0, Canton 3.6.1). Nothing has run on mainnet and nothing has been audited externally. Last updated with `yap-token` 0.9.0 / `yap-governance` 0.5.0.

## 1. Daml unit tests (Daml Script, no network)

| Package | Tests | Covers |
|---|---|---|
| `yap-token-test` | 73 | Transfers (offer, direct, self, V1 and V2, wrong actors), allocations V1 and V2 (net settlement, committed, batch guards) and delegated settlement, locks and expiry, linear vesting (cliff, linearity, revoke, close, funded from the treasury), BurnMint, operator allowance and expiry, field and precision guards |
| `yap-governance-test` | 11 | Every governed action: appoint / set / revoke operator, revoke vesting, governor mint, rescue, burn treasury, vesting and transfer from the treasury, the atomic allocation (guards, threading of change, vesting behaviour) |

**Mutation testing** (`daml/yap-token-test/mutations.py`) breaks one rule at a time and checks that some test fails. Latest full run (0.9.0 sources, 136 mutations): 114 killed, 22 survived. 21 survivors are behaviour-neutral double guards (for example a check that the contract's own `ensure`, its signatories or a second check one layer down already enforce). 1 was a real gap (direct settlement with iteration fields) that now has a test; the run has not been repeated since. Earlier runs found and closed gaps in the V2 direct-transfer rule and in operator minting. The governance package has no mutation run.

## 2. Live tests on the ledger

Each script prints its checks; most end by proving that the supply is back where it started.

| Area | Scripts | Result |
|---|---|---|
| Transfer rules, authorization, disclosure, preapprovals, 6-decimal limit, edge cases | `6`, `7`, `10`, `13`, `17` | pass (re-run on 25 Oct, see below the table) |
| Allocations and settlement across participants and across three nodes, delegated settlement, cross-node races | `12`, `21`, `22`, `24`, `25`, `27`, `28`, `30` | pass |
| Invariants under load, contention, preapproval cap | `14`, `15`, `16` | pass |
| Registry: resilience, fuzzing (70 cases), TLS, stale-factory window | `18`, `19`, `26`, `28` | pass |
| Spam and ledger limits: 200-element cap, websocket stream, pending-offer spam | `29`, `31` to `34` | pass; limits documented in the README |
| BurnMint + V2 transfers incl. theft attempts | `35` | 28 / 28 |
| Locks, expiry, linear vesting (claim, revoke, close) | `36` | 32 / 32 |
| Operator: allowance, expiry, limits, governor revoke | `37` | 21 / 21 |
| Operator-minted tokens through the registry (V1, V2, direct) | `38` | 12 / 12 |
| Parallel operator mints (one wins, re-read and retry lands all) | `39` | 4 / 4 |
| **Decentralized governor**: one node cannot act; appoint and revoke operator through confirmations on both nodes; mint; registry transfer | `40` | 13 / 13 |
| Governed `BurnTreasury` | `41` | 8 / 8 |
| **YAP launch**: 100,000,000 issued once; vesting and transfer from the treasury; supply exactly 100M at every step | `42` | 12 / 12 |
| **Tokenomics allocation** in one governed decision: nine pools, TGE share, vesting, team cannot claim before its cliff | `43` | 23 / 23 |
| **Allocation V2** on the YAP instance: net settlement (alice pays 10, bob pays 3, net 7), mismatched legs and other settlements refused, direct settle refused, committed allocations, withdrawal; supply unchanged | `44` | 23 / 23 |

### Re-run of scripts 4 to 39 on a fresh single-owner `yap-token` deployment (25 Oct 2026)

`node scripts/run-single-admin-suite.mjs` creates a separate admin (`yap-sa-admin`) with clean test parties on t1, a local registry for it, and runs the scripts one by one (the governed YAP instance is untouched). **19 of 19 scripts pass:**

| Script | Result | Script | Result |
|---|---|---|---|
| `4` e2e through the registry | exit 0 | `26` registry fuzz | 70 / 70 |
| `6` negative tests | 18 / 18 | `28` stale-factory window | 5 / 5 |
| `7` disclosure | 3 / 3 | `29` pending-offer spam (50) | 8 / 8 |
| `10` preapprovals | 10 / 10 | `31` websocket ACS | exit 0 |
| `12` allocations | 19 / 19 | `35` BurnMint + V2 | 28 / 28 |
| `13` precision | 8 / 8 | `36` locks + vesting | 32 / 32 |
| `14` invariant soak (60 ops) | exit 0 | `37` operator | 21 / 21 |
| `15` contention | 22 / 22 | `38` operator through the registry | 12 / 12 |
| `17` edge cases | 27 / 27 | `39` operator contention | 4 / 4 |
| `18` registry resilience | 26 / 26 | | |

Not re-run, and why:

- `16`, `32`, `33` (200+ contracts each): they would use most of the remaining t1 traffic (about 0.66 of 1.41 MB were left), which the YAP instance and DecMan also need. Their earlier results (the 200-element limit and the websocket answer) are documented in the README.
- `21`, `22`, `24`, `25`, `27`, `30`, `34`: they need a second or third node (the MZF node was down and no credentials for another node are available). The cross-participant settlement path is covered by the unit tests and by the governed tests, but these scripts have not been re-run since the rename.
- `19`, `23` (read-only diagnostics), `5`, `8`, `9`, `20` (setup tools).

## 3. Wallet SDK and registry

- Official `@canton-network/wallet-sdk` against the public YAP registry: discovery, offer, accept, reject, withdraw, UTXO merge (`sdk-test/yap-flows.mjs`, 5 / 5).
- Earlier full flows on a single-owner admin (preapproval, allocation, external parties, dust spam): 10 / 10.
- Registry unit test with a mock ledger: 42 / 42 (including the Allocation V2 routes and "the newest factory wins").

## 4. What testing found (and was fixed)

Gaps in the tests, found by mutation testing (the contract was right, but nothing would have failed if the rule were removed):

- On the V2 direct-transfer path, the rule "the sender must be an actor" had no test. Without it, someone else's holding could be spent. Three tests were added.
- Operator mint: the 6-decimal limit was untested inside the allowance. A test was added.
- Allocation V2 and the settlement factory: reviewing the new mutations showed no test for a batch settled after its deadline or for an allocation of another admin, and the run itself found that direct settlement with iteration fields was untested. Three tests were added.

Found while re-running the old scripts:

- Script `6` summed balances as floating-point decimals and compared them with `===`; with 25 small holdings the sum differed in the last digit (`995.4023739999998`), which failed five checks that had nothing to do with the contract. It now sums in integer micro-units.
- The registry answered an oversized request line with Node's bare 431 (no body); it now answers a JSON 431 and keeps serving (`clientError` handler, one new registry test).
- The old scripts hard-coded the test parties, which also hold governed YAP; they now read `CUSDT_ALICE` / `CUSDT_BOB` from the environment when set.

Real defects and incidents:

- A cross-participant settlement authority could not be revoked by one party, because the built-in `Archive` needs every signatory. Separate revoke choices were added.
- A Splice bundle upgrade silently reset ledger authentication to open (for about an hour). It is now a standing check after every upgrade.
- An nginx `listen` bound to one IP took over all hostnames on that IP, and an over-broad firewall rule blocked DecMan's own outgoing connections. Both were fixed and are documented in the README.

## 5. Not tested

- Mainnet; an external security audit; behaviour under real production load.
- Two **independent** operators: all governor tests used two nodes run by one person. That exercises the mechanism fully, but not the security property.
- Joining an existing decentralized party (add member), removing a member, changing the threshold.
- A wallet or venue that speaks Token Standard V2 end to end; Allocation V2 was tested on our own ledger only, not against any DEX or wallet.
- Staking, fee buyback and burn, and Jobs escrow from the tokenomics: not part of this repository.
