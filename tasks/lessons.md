# Webber Build — Lessons Learned

## 2026-03-08: System permissions on macOS

**Problem:** `~/.config` and `~/.zshrc` owned by root, blocking Solana CLI installer and PATH configuration.

**Root cause:** Previous system-level tool installations changed ownership of user dotfiles.

**Solution:**
- Solana CLI: Downloaded binary tarball directly to `~/.local/share/solana/install/active_release/` instead of using the installer script.
- PATH: Used `~/.zshenv` (user-owned) instead of `~/.zshrc` (root-owned).
- Yarn: Installed to `~/.local/node_modules/.bin/` via `npm install --prefix ~/.local yarn`.
- Created `.env.sh` helper in project root for consistent PATH setup across all build commands.

**Pattern:** When system paths are permission-locked, install to `~/.local/` hierarchy and use `.zshenv` for PATH.

## 2026-03-08: Anchor/Solana toolchain version matrix

**Problem:** Anchor 0.30.1's IDL build failed with Rust 1.94 (proc-macro2 `source_file()` removed). Anchor 0.31.1 fixed IDL but needed Rust 1.82+ in Solana platform-tools. Solana 2.2.3 only bundled Rust 1.79.

**Root cause:** Three-way version dependency: system Rust (for IDL build), platform-tools Rust (for SBF build), and Anchor's dependency tree.

**Solution:** Anchor 0.31.1 + Solana CLI 3.1.9 (which bundles newer platform-tools). Also pinned `blake3` to 1.5.5 via `cargo update --precise` to avoid `edition2024` requirement.

**Pattern:** When Anchor build fails, check BOTH the IDL build (system Rust) and SBF build (platform-tools Rust). Align versions across all three: Anchor CLI, Anchor crate, and Solana CLI.

## 2026-03-08: anchor-spl idl-build feature required

**Problem:** `anchor build` failed with "no function `create_type` found for struct `anchor_spl::token::Mint`" when using SPL token types in account structs.

**Root cause:** The IDL build phase needs type information for SPL types, which is only available when `anchor-spl` is compiled with the `idl-build` feature.

**Solution:** Add `"anchor-spl/idl-build"` to the program's `idl-build` feature list in Cargo.toml:
```toml
[features]
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

**Pattern:** Any Anchor program using `anchor-spl` types in `#[derive(Accounts)]` structs must include `anchor-spl/idl-build` in the feature flags.

## 2026-03-08: Anchor test cluster configuration

**Problem:** `anchor test` tried to deploy to devnet (configured in Anchor.toml) but wallet had insufficient SOL.

**Root cause:** Anchor.toml `cluster = "Devnet"` causes `anchor test` to deploy to devnet instead of using a local validator.

**Solution:** Use `cluster = "Localnet"` in Anchor.toml. `anchor test` automatically starts and stops a local validator.

**Pattern:** Always use Localnet for tests. Only switch to Devnet for manual deployment.

## 2026-03-09: Cross-program CPI with Anchor (marketplace → token)

**Context:** The marketplace's `execute_payment` needed to CPI to `webber_token::transfer_with_burn`.

**Pattern:**
1. Add the target program as a Cargo dependency with `features = ["cpi"]`
2. Use `webber_token::cpi::accounts::TransferWithBurn` for the accounts struct
3. Use `webber_token::cpi::transfer_with_burn(ctx, amount)` for the call
4. The buyer's signer is forwarded automatically through CPI since they signed the outer transaction
5. Validate the CPI target program with `#[account(address = webber_token::ID)]`

**Anti-pattern:** Duplicating burn math in the marketplace. Instead, import `BURN_NUMERATOR` and `BURN_DENOMINATOR` constants from webber-token for state tracking, and let the token program handle the actual transfer+burn.

## 2026-03-09: Cross-program account reads with seeds::program

**Context:** Marketplace needs to validate a provider is registered in webber-registry without CPI.

**Pattern:** Use `seeds::program` in Anchor to validate a PDA from another program:
```rust
#[account(
    seeds = [b"agent", provider.key().as_ref()],
    bump = provider_agent.bump,
    seeds::program = webber_registry::ID,
    constraint = provider_agent.owner == provider.key() @ MarketplaceError::NotRegisteredAgent,
)]
pub provider_agent: Account<'info, webber_registry::AgentAccount>,
```

This deserializes and validates the account without CPI. Requires the source program as a Cargo dependency with `cpi` feature (for the account type).

## 2026-03-09: Reentrancy protection in Solana programs

**Context:** `execute_payment` must be safe against reentrancy attacks.

**Pattern:** All state updates (transaction record, counter increments, stats) MUST happen BEFORE any CPI call. The CPI to webber-token happens last. This ensures that even if the CPI somehow called back into the marketplace, all state would already be committed.

**Rule:** State first, CPI last. No exceptions for any instruction that does cross-program invocation.
