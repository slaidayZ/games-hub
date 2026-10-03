# Games Hub — Block Duel

[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana&logoColor=white)](https://solana.com/developers)
[![Anchor](https://img.shields.io/badge/Anchor-0.31.1-blue)](https://www.anchor-lang.com/)
[![Status](https://img.shields.io/badge/Status-Prototype-orange)](#current-status-and-safety)
[![Hackathon](https://img.shields.io/badge/Colosseum-2026-14F195)](https://colosseum.org)

> A browser-based gaming hub prototype, starting with a two-player Tetris duel and optional SOL escrow on Solana Devnet.

[Program Source](programs/games_hub_bets/src/lib.rs) · [Program Guide](programs/games_hub_bets/README.md) · [Run Locally](#quick-start)

---

![Games Hub Screenshot](assets/project.jpg)

---

## Submission to 2026 Solana National Hackathon

| Name | Role | Contact |
|------|------|---------|
| slaidayZ | Founder | [GitHub](https://github.com/slaidayZ) |

---

## Problem and Solution

### 1. Head-to-head games without shared stakes
- **Problem:** Casual browser games rarely offer a simple way for two players to escrow equal stakes.
- **Games Hub:** Players connect separate wallets and deposit equal amounts into a per-match Solana escrow.

### 2. Trusting the winner and handling payouts
- **Problem:** An off-chain game result cannot directly move SOL from an escrow account.
- **Games Hub:** The Anchor program stores each match and only permits the selected referee to settle it. For new Devnet matches, the local site server acts as referee and submits the payout.

### 3. Recovering from interrupted transactions
- **Problem:** A browser can report a confirmation timeout even after a transaction has landed.
- **Games Hub:** Players can recover a match from its on-chain match ID instead of immediately creating another wager.

---

## Why Solana

- **Native SOL escrow** — the program holds each match's deposits in a program-derived account.
- **Wallet-based deposits** — each player approves their stake through Phantom.
- **Low-cost experimentation** — Devnet lets the project exercise the full wallet and escrow flow without real-value SOL.
- **Rust and Anchor** — the wager rules and match accounts are implemented in an Anchor program.

---

## Summary of Features

- Local two-player Tetris with keyboard controls and versus garbage-line attacks.
- Phantom wallet registration and per-wallet match history stored in the browser.
- Optional 1 SOL per-player wager on Devnet.
- On-chain match creation, joining, settlement, cancellation before joining, and timeout refunds.
- Local server referee wallet for automatic settlement of new matches.
- Match recovery flow for checking submitted or interrupted transactions.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML · CSS · JavaScript |
| Game server | Node.js · HTTP · WebSocket (`ws`) |
| Wallet and Solana client | Phantom · `@solana/web3.js` |
| On-chain program | Rust · Anchor 0.31.1 |
| Network | Solana Devnet |
| Developer tools | npm · Solana CLI · Anchor CLI · Git/GitHub · OpenAI Codex |

## Architecture

```text
 Player 1 + Phantom ── approve 1 SOL ──┐
                                       ├──► Solana Devnet
 Player 2 + Phantom ── approve 1 SOL ──┘     ├─ Match state PDA
                                             └─ SOL escrow PDA
                                                    ▲
 Browser Tetris ── reports winner ──► Node.js site server
                                      └─ signs settlement as referee
```

The browser submits player deposits to the wager program. For a new match, the site's local Devnet wallet is stored on-chain as the referee and signs the winner payout. **The server trusts the winner reported by the browser; it does not independently verify the Tetris result.**

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- Phantom installed in your browser and configured for Devnet
- Two distinct player wallets, each with Devnet SOL for its stake and transaction fees

### Run the website

From the project directory:

```powershell
npm install
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000).

On first start, the Node.js server creates `server-fee-payer.json` and prints its public address. The wager panel also displays the address and provides a copy button. Send a small amount of **Devnet SOL** to this wallet to fund automatic settlement fees. Keep the key file private and back it up securely if funded; deleting it creates a different wallet. The file is ignored by Git.

### Play and wager

1. Set both the site and Phantom to **Devnet**.
2. Register different wallets for Player 1 and Player 2.
3. Create a match. Player 1 approves 1 SOL plus account rent and transaction fees.
4. Switch Phantom to Player 2 and join. Player 2 approves 1 SOL plus transaction fees.
5. Play Tetris. The site server submits a payout when the browser reports a winner.

**Controls:** Player 1 uses `A`/`D` to move, `W` to rotate, `S` to soft drop, and `Space` to hard drop. Player 2 uses the arrow keys, `Down` to soft drop, and `Enter` to hard drop.

## Solana Program

The Anchor program lives in [`programs/games_hub_bets`](programs/games_hub_bets). Its Devnet program ID is:

```text
CGU9v9Zt1PJECyZDcXVJpgzjukxy2ejAXbN1bUbGE8tq
```

It is already deployed to Devnet. To build or deploy after changing the on-chain program, use the configured Solana and Anchor toolchain:

```bash
anchor build
anchor deploy --provider.cluster devnet
```

See the [program guide](programs/games_hub_bets/README.md) for the match instructions, accounts, and refund rules.

## Current Status and Safety

- **Devnet only.** Devnet SOL has no monetary value. This prototype is not for real-value wagers.
- **Winner is not verified.** Tetris runs in the browser. A modified client can report either player as the winner, and the local referee server trusts that report.
- **The referee wallet is custodial.** The server holds `server-fee-payer.json` and can sign settlements for matches that name it as referee.
- **Automatic payout is not yet end-to-end verified against Devnet after the latest changes.** Solana's public Devnet RPC may also rate-limit requests.
- Wallet registration and match history are stored locally in the browser; there is no account backend.
- Matches created before the site referee change retain their original referee.

Before any mainnet use, the game result must be verified independently, key management and server access need production-grade safeguards, and the smart contract needs an independent security review.

## Roadmap

- Verify game results with an authoritative server or a verifiable game protocol.
- Improve transaction recovery and RPC rate-limit handling.
- Add more head-to-head games to the hub.
- Review the contract and key-management model before considering mainnet.

## Resources

- [GitHub repository](https://github.com/slaidayZ/games-hub)
- [Anchor program source](programs/games_hub_bets/src/lib.rs)
- [Anchor program guide](programs/games_hub_bets/README.md)
- Live application and demo video: not published yet.

## License

No license file has been added to the repository yet.
