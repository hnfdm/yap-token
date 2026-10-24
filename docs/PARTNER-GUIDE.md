# Partner guide: co-signing the YAP governor

This guide is for an independent party who will run **one node** and hold **one key** of the YAP governor on Canton. You do not need to know Daml. You need to understand three things: what you hold, what to check before you approve anything, and how to keep your node safe.

> Status: everything in sections 3 to 5 and 7 has been run on testnet with two nodes (both operated by one person). Section 6 (joining an existing party) has **not been rehearsed yet** and will be practised together before it is used for real. Not for mainnet before an audit.

---

## 1. Your role

YAP has a single issuing authority, called the **governor**. The governor is a *decentralized party*: not one account owned by one person, but one identity owned jointly by several nodes. Each node holds one key. A decision only takes effect when **at least the threshold number of nodes approve it**.

- A single node **cannot** act alone on behalf of the governor. This was tested: a direct command from one node is refused, and an execution with fewer than the threshold confirmations is refused by the ledger.
- You do **not** hold anyone's tokens. Token owners (pools, vesting beneficiaries, users) keep control of their own holdings.
- What goes through the governor is rare: appointing or revoking the day-to-day operator, revoking vestings that are revocable, burning tokens owned by the treasury, rescuing a holding (archiving it), minting directly, and large allocations out of the treasury.
- Minting new tokens through the governor (`GovernorMint`) contradicts the fixed supply of 100,000,000 YAP. Treat it as a **red flag**, see section 7.

What keeps working without you: transfers, vesting claims by beneficiaries, burns by owners. What stops if you are unavailable (in a 2-of-2 setup): every governor decision listed above.

## 2. What you put at stake

- **Availability.** If your node or key is lost and the setup is 2-of-2, governor decisions are stuck. A 2-of-3 setup avoids this.
- **Security.** If your node is compromised, an attacker holds one key. That is not enough to act, but it lowers the bar to one more key.
- **Responsibility.** You approve decisions on behalf of the group. Do not approve what you have not read.

## 3. Requirements

- A **Splice validator** on the same network and the same Canton version (**3.6.1**, Splice bundle 0.9.x) as the other nodes. You hold root access yourself; nobody else, including the other operators, may have access to that node.
- Docker and Docker Compose. 8 GB of RAM is enough for the validator plus DecMan.
- SSH with keys only, no passwords. A firewall that is on.
- One public port for DecMan (**9000/TCP, the Noise protocol**), open **only to the other nodes' IP addresses**, not to everyone.
- A trusted communication channel with the other operators (a video call or an encrypted messenger) to exchange peer data and verify it.

## 4. Installing DecMan on your node

Software: the **Decentralization Manager** (DLC-Link/BitSafe), open source. We use an image pinned to one version and one digest:

```
public.ecr.aws/dlc-link/decentralization-manager:v1.13.0-nonroot
sha256:5a00d8b57e3c8187e9d1e4e604a78dc4607bead7eda7c166ca0128e3ddc7d9a9
```

Check the digest yourself after `docker pull` (`docker image inspect`). The software gets access to your participant's Admin API and Ledger API, so treat it like any other privileged software.

Ready-made scripts are in this repository (`deploy/templates/decman-*.sh.in`; `node deploy/generate.mjs` writes them to `deploy/out/`). Run them on your node, in this order:

1. `decman-discover-on-vps.sh`: a read-only survey (Docker network name, participant container, ports in use). It changes nothing.
2. `decman-install-on-vps.sh <your-public-IP> <other-node-IP>`: installs the DecMan container next to the validator. The UI is bound to `127.0.0.1:18080` only. Port 9000 accepts only the other node's IP. It does **not** touch the validator stack and does **not** restart anything that belongs to the validator.
3. `decman-api-on-vps.sh`: makes DecMan trust your own validator's Keycloak client, so every operation can be done with `curl` from the server, without opening the UI.
4. `decman-harden-on-vps.sh <other-node-IP>`: a firewall rule that survives a reboot, plus an **encrypted backup** of `/opt/decman` (the database encryption key and the Noise key live there).

Note: the scripts assume the same validator layout as our nodes (Docker network `splice-validator_splice_validator`, container `splice-validator-participant-1`). If yours differs, run step 1 first and send us the result before going further.

## 5. Exchanging peer data (important for security)

Each node only accepts connections from peers in its own list, and the peer's Noise public key is used for the handshake. A wrong key means the connection fails; a forged key means you are connected to the wrong party.

1. Get your own data: `source /opt/decman/api.sh; api GET /node-config` (participant ID) and `api GET /keys/status` (Noise public key).
2. Send your **participant ID, public IP address, port and Noise public key** to the other operators over a verified channel. Read **the last few characters of the key** aloud over a call so you know it was not swapped on the way.
3. Add their peer with `decman-peers-on-vps.sh` (one line of peer data per node), then check `api GET /participants-status`. The status must be `Connected`.

## 6. Joining the governor party (not yet rehearsed)

The flow uses DecMan's "add member" feature: an existing operator starts the procedure, you accept the invitation, and every node signs the topology change. Afterwards the member list of `GovernanceRules` (which decides who may approve decisions) is updated through an ordinary governance decision.

Before accepting any invitation, check the **party prefix**, the **list of participants** and the **new threshold**. Compare them with what was agreed outside the system. We will rehearse this flow on testnet with you before it is used for real.

## 7. Approving decisions: what to check

Every decision is a *proposal*. DecMan only shows a **title and a short description**; the real content (who, how much, when) lives in the contract on the ledger. **Do not approve from the description alone.** Read the proposal from the ledger with `node scripts/show-allocation-proposal.mjs` (for allocations), or ask the operator to send you the content, and compare it with the decision that was agreed.

| Label in DecMan | Meaning | Check |
|---|---|---|
| `YapAllocate` | A large allocation from the treasury to several pools, including vesting schedules | Every item: pool, amount, start, end. The total must equal the agreed figure. The supply stays at 100,000,000 |
| `YapGrantVestingFromTreasury` | One vesting grant out of the treasury | Beneficiary, amount, schedule, revocable or not |
| `YapTreasuryTransfer` | Send from the treasury to one recipient | Recipient and amount |
| `YapAppointOperator`, `YapSetOperatorAllowance` | Appoint or change the limits of the day-to-day operator | Who the operator is, the limit, until when |
| `YapRevokeOperator` | Revoke an operator | It was agreed |
| `YapRevokeVesting` | Cancel a grant (only grants marked revocable) | The beneficiary and the reason |
| `YapBurnTreasury` | Burn tokens owned by the treasury | Amount, reason |
| `YapRescueHolding` | Archive someone's holding | **Only** with a clear written reason (for example tokens reported stolen) |
| `YapGovernorMint` | Mint new tokens | **Refuse**, unless there is a written decision to change the fixed supply |

General rules:

- Confirmations **expire after 30 minutes**. Do not let that rush you.
- Several proposals can be open at the same time. Always give the **label** when confirming (`bash decman-vote-on-vps.sh confirm <label>`); never confirm "the first one". The `confirm-all` command lists the open proposals and pauses for 15 seconds; use it only when you have already checked every open proposal.
- After execution, check the result: the total supply must still be 100,000,000 YAP, and the pool balances must match what was agreed.
- If in doubt, **do not confirm**. Not confirming harms nobody; the proposal simply expires.

## 8. Keeping your node safe

- Back up `/opt/decman/env` and `/opt/decman/data` (these contain `noise.key` and the database) in encrypted form, and **keep the passphrase off the server**. Without the same Noise key, your peers have to update your entry.
- Never expose the UI (`18080`) to a network. Reach it through an SSH tunnel if you need it.
- After a reboot, check that `decman-fw.service` is active and the `decman` container is running (`docker ps`). Peer status: `api GET /participants-status`.
- Upgrade DecMan **together** with the other operators, one version for all (the protocol version must match), and only to a version you agreed on.
- When the Splice validator is upgraded, re-check that **ledger API authentication is still on**. A bundle upgrade once reset the configuration to no authentication (a real incident on our testnet). Test with a request without a token: it must answer 401.

## 9. When something goes wrong

- **Your node is suspected to be compromised:** stop the `decman` container, tell the other operators **immediately** over a verified channel, and do not approve anything until it is resolved. The other operators will remove your node from the party (the "kick" procedure) and reset the threshold. You will need to reinstall from a clean host, not "clean up" the compromised one.
- **You lose your key or node:** tell the other operators. Replacing a node is a procedure of its own (add the new member, then remove the old one). This is why the encrypted backup matters.
- **You want to leave:** coordinate with the other operators. The member is removed with the "kick" procedure, and the `GovernanceRules` member list is updated.

## 10. Short checklist

- [ ] The DecMan image digest matches, and the version is the same as the other operators'
- [ ] Port 9000 is open only to the other nodes' IPs; the UI is not exposed to any network
- [ ] Peer data was verified over a separate channel; `participants-status` = Connected
- [ ] An encrypted backup exists, and the passphrase is stored off the server
- [ ] Ledger API authentication is on (a request without a token = 401)
- [ ] I know how to check the **content** of a proposal, not just its description
- [ ] I know that `YapGovernorMint` must not be approved without a written decision
