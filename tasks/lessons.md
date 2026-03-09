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
