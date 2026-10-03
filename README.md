# Games Hub

Games Hub is my starting point for building a hub of games on the Solana blockchain. Tetris is the first game in the project: a local two-player duel with Phantom wallet profiles, wallet-specific match history, and versus garbage-line attacks.

## SOL betting contract

An Anchor program for optional two-player SOL wagers lives in `programs/games_hub_bets`. Each player stakes exactly 1 SOL; the configured referee can pay 2 SOL to the winner. A creator can cancel before an opponent joins, and either player can trigger a full refund if an active match is unresolved after one hour.

The game site can create and join wagers on Devnet using Phantom or temporary development wallets. The local Node server creates and persists a Devnet-only site referee wallet in `server-fee-payer.json`; new matches store that public key as referee, and the server signs and pays the settlement fee automatically when the browser reports a winner. The fee sponsor address and balance appear in the wager panel; copy the address and fund it with Devnet SOL to enable automatic payouts. Keep the ignored key file private and backed up if funded. Do not use this local key management for Mainnet. **This is for Devnet testing only:** Tetris runs in the browser, and the server does not verify game outcomes. A modified client can request that the server pay either player, so the automatic referee is not safe for real-value wagers. Existing matches keep the referee stored when they were created. See [`programs/games_hub_bets/README.md`](programs/games_hub_bets/README.md) for program details.

If a transaction reports a confirmation timeout, use **Recover / check match** with its match ID before trying to create another wager. A submitted transaction can still have finalized on-chain.

Wallet registration signs a message, and match history is stored in the local browser.

## Run locally

```sh
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in a browser with Phantom installed.

## Controls

- Player 1: A/D to move, W to rotate, S to soft drop, Space to hard drop.
- Player 2: Arrow keys to move and rotate, Down to soft drop, Enter to hard drop.

Founder: **slaidayZ**
