# Partner guide: co-signing the YAP governor

For an independent party who runs **one node** and holds **one key** of the YAP governor on Canton. No Daml knowledge needed.

> Everything below except section 4 has been run on testnet with two nodes of one operator. Section 4 (joining an existing party) has **not been rehearsed**; we will practise it with you first. Not for mainnet before an audit.

## 1. Your role

The governor is a *decentralized party*: one identity owned jointly by several nodes, each holding one key. A decision takes effect only when **at least the threshold number of nodes approve it**. This was tested: a command from one node is refused, and an execution with too few confirmations is refused by the ledger.

- You hold no one's tokens. Pools, beneficiaries and users keep control of their own holdings.
- The governor decides only rare things: appointing or revoking the day-to-day operator, revoking vestings, burning treasury tokens, archiving a holding, minting, and large treasury allocations.
- Transfers, vesting claims and burns by owners keep working without you. In a 2-of-2 setup every governor decision stops if you are unavailable; 2-of-3 avoids that.
- If your node is compromised, an attacker holds one key: not enough to act, but one fewer key stands between them and the treasury.

## 2. Requirements

- A Splice validator on the same network and Canton version (**3.6.1**, Splice 0.9.x) as the other nodes. Only you have root on it.
- Docker, 8 GB RAM, SSH with keys only, a firewall that is on.
- Port **9000/TCP** (Noise) open **only to the other nodes' IPs**.
- A trusted channel (video call, encrypted messenger) to exchange and verify peer data.

## 3. Install DecMan

Software: the open-source **Decentralization Manager** (DLC-Link/BitSafe), pinned to one image digest:

```
public.ecr.aws/dlc-link/decentralization-manager:v1.13.0-nonroot
sha256:5a00d8b57e3c8187e9d1e4e604a78dc4607bead7eda7c166ca0128e3ddc7d9a9
```

Verify the digest after `docker pull`. It gets access to your participant's Admin and Ledger APIs: treat it as privileged software. The scripts are in `deploy/templates/decman-*.sh.in` (`node deploy/generate.mjs` writes them to `deploy/out/`). Run in order:

1. `decman-discover-on-vps.sh`: read-only survey, changes nothing. The scripts assume our validator layout (Docker network `splice-validator_splice_validator`, container `splice-validator-participant-1`); if yours differs, send us this output before going on.
2. `decman-install-on-vps.sh <your-IP> <other-node-IP>`: installs the container beside the validator, UI on `127.0.0.1:18080` only, port 9000 limited to the other node. It does not touch or restart the validator.
3. `decman-api-on-vps.sh`: reuses your validator's Keycloak client so everything works with `curl` from the server.
4. `decman-harden-on-vps.sh <other-node-IP>`: a firewall rule that survives reboots, and an **encrypted backup** of `/opt/decman` (database key and Noise key). Keep the passphrase off the server.

**Exchange peer data safely.** A node only talks to peers in its list, using their Noise public key. Get yours with `api GET /node-config` and `api GET /keys/status`, send **participant ID, IP, port and key** over a verified channel, and read the **last characters of the key aloud** on a call. Add the peer with `decman-peers-on-vps.sh` and check `api GET /participants-status` shows `Connected`.

## 4. Joining the party (not rehearsed)

An existing operator starts DecMan's "add member" procedure, you accept the invitation, and every node signs the change; then the `GovernanceRules` member list is updated by a normal governance decision. Before accepting, check the **party prefix**, the **participant list** and the **new threshold** against what was agreed outside the system.

## 5. Approving decisions

DecMan shows only a **title and short description**. The real content (who, how much, when) is in the contract on the ledger. **Never approve from the description alone**: read it with `node scripts/show-allocation-proposal.mjs` or ask the operator for the content, and compare it with the agreed decision.

| Label | Meaning | Check |
|---|---|---|
| `YapAllocate` | Large allocation from the treasury, with vesting schedules | Every item (pool, amount, start, end); total as agreed; supply stays 100,000,000 |
| `YapGrantVestingFromTreasury`, `YapTreasuryTransfer` | One grant or transfer out of the treasury | Recipient, amount, schedule, revocable or not |
| `YapAppointOperator`, `YapSetOperatorAllowance`, `YapRevokeOperator` | Day-to-day operator and its limits | Who, how much, until when |
| `YapRevokeVesting` | Cancel a revocable grant | Beneficiary and reason |
| `YapBurnTreasury` | Burn treasury tokens | Amount, reason |
| `YapRescueHolding` | Archive someone's holding | Only with a clear written reason (for example stolen tokens) |
| `YapGovernorMint` | Mint new tokens | **Refuse** without a written decision to change the fixed 100,000,000 supply |

- Confirmations **expire after 30 minutes**; do not let that rush you.
- Several proposals can be open: always confirm by **label** (`bash decman-vote-on-vps.sh confirm <label>`). Use `confirm-all` only after you checked every open proposal.
- After execution, verify the result: total supply still 100,000,000 YAP, pool balances as agreed.
- If in doubt, do not confirm. The proposal just expires.

## 6. Keeping the node safe

- Keep encrypted backups of `/opt/decman/env` and `/opt/decman/data` (`noise.key`, database); passphrase off the server.
- Never expose the UI port; use an SSH tunnel.
- After a reboot check `decman-fw.service` and the `decman` container (`docker ps`) and `api GET /participants-status`.
- Upgrade DecMan **together** with the other operators, one agreed version for all.
- After any Splice upgrade, re-check that **ledger API auth is still on** (a request without a token must answer 401). An upgrade once reset it to open on our testnet.

## 7. When something goes wrong

- **Node suspected compromised:** stop the `decman` container, tell the other operators **immediately** over a verified channel, approve nothing. They will remove your node from the party ("kick") and reset the threshold. Reinstall on a clean host; do not "clean" the old one.
- **Key or node lost:** tell the others; replacing a node means adding the new member, then removing the old one. The encrypted backup is what makes this quick.
- **Leaving:** coordinate with the others; you are removed with "kick" and the `GovernanceRules` list is updated.

## Checklist

- [ ] Image digest matches; same DecMan version as the other operators
- [ ] Port 9000 open only to the other nodes; UI not exposed
- [ ] Peer data verified on a separate channel; status `Connected`
- [ ] Encrypted backup made; passphrase stored off the server
- [ ] Ledger API auth on (no token = 401)
- [ ] I can read a proposal's **content**, and I know `YapGovernorMint` needs a written decision
