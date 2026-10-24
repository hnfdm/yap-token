# What has been tested

All testing is on **Canton testnet** (Splice 0.9.0, Canton 3.6.1). Nothing has run on mainnet and nothing has been audited externally. Last updated with `yap-token` 0.9.0 / `yap-governance` 0.5.0.

## 1. Daml unit tests (Daml Script, no network)

| Package | Tests | Covers |
|---|---|---|
| `yap-token-test` | 71 | Transfers (offer, direct, self, V1 and V2, wrong actors), allocations V1 and V2 (net settlement, committed, batch guards) and delegated settlement, locks and expiry, linear vesting (cliff, linearity, revoke, close, funded from the treasury), BurnMint, operator allowance and expiry, field and precision guards |
| `yap-governance-test` | 11 | Every governed action: appoint / set / revoke operator, revoke vesting, governor mint, rescue, burn treasury, vesting and transfer from the treasury, the atomic allocation (guards, threading of change, vesting behaviour) |

**Mutation testing** (`daml/yap-token-test/mutations.py`) breaks one rule at a time and checks that some test fails. Latest full run (0.9.0 sources, 136 mutations): 114 killed, 22 survived. 21 survivors are behaviour-neutral double guards (for example a check that the contract's own `ensure`, its signatories or a second check one layer down already enforce). 1 was a real gap (direct settlement with iteration fields) that now has a test; the run has not been repeated since. Earlier runs found and closed gaps in the V2 direct-transfer rule and in operator minting. The governance package has no mutation run.

## 2. Live tests on the ledger

Each script prints its checks; most end by proving that the supply is back where it started.

| Area | Scripts | Result |
|---|---|---|
| Transfer rules, authorization, disclosure, preapprovals, 6-decimal limit, edge cases | `6`, `7`, `10`, `13`, `17` | pass |
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

## 3. Wallet SDK and registry

- Official `@canton-network/wallet-sdk` against the public YAP registry: discovery, offer, accept, reject, withdraw, UTXO merge (`sdk-test/yap-flows.mjs`, 5 / 5).
- Earlier full flows on a single-owner admin (preapproval, allocation, external parties, dust spam): 10 / 10.
- Registry unit test with a mock ledger: 40 / 40 (including the Allocation V2 routes and "the newest factory wins").

## 4. What testing found (and was fixed)

Gaps in the tests, found by mutation testing (the contract was right, but nothing would have failed if the rule were removed):

- On the V2 direct-transfer path, the rule "the sender must be an actor" had no test. Without it, someone else's holding could be spent. Three tests were added.
- Operator mint: the 6-decimal limit was untested inside the allowance. A test was added.

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
