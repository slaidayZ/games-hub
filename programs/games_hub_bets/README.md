# Games Hub SOL wager program

This Anchor program escrows native SOL for two-player matches. Each player stakes exactly 1 SOL (1,000,000,000 lamports); settlement transfers 2 SOL to one of the two players.

## Match flow

1. `create_sol_match(match_id, 1_000_000_000)` creates a match and escrows player one's stake. The creator selects a referee public key.
2. `join_sol_match(match_id)` escrows the second player's 1 SOL and starts a one-hour timeout.
3. `settle_sol_match(winner)` pays both stakes to the selected player. Only the referee selected at creation can sign this instruction.

The creator can call `cancel_sol_match` while the match is still waiting. After the one-hour timeout, anyone can call `refund_sol_match`; it returns 1 SOL to each player and returns the escrow and match-account rent to the creator.

The referee reports the game result. The on-chain program cannot independently verify an off-chain Tetris result, so players must trust the referee. The match ID should be unique for every wager.

## Build and deploy on devnet

From this folder in WSL with Rust, Solana CLI, and Anchor 0.31.1 installed:

```bash
anchor keys sync
anchor build
solana config set --url devnet
solana balance
anchor deploy --provider.cluster devnet
```

`anchor keys sync` synchronizes the program ID in `src/lib.rs` and `Anchor.toml` with the generated keypair in `target/deploy/`. Fund the configured deployer wallet with devnet SOL before deployment. Never deploy or test this program with real funds until it has been independently reviewed.

The local website can submit these instructions on Devnet through Phantom. Each bet remains a trusted-referee wager: the program does not independently verify game outcomes, and the browser-based Tetris result is not server-verified. Use Devnet only while developing.
