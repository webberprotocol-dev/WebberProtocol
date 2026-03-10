# Reputation Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the reputation engine that turns marketplace transactions into on-chain trust scores, completing Phase 2 Build 2.

**Architecture:** New `webber-reputation` Anchor program with ReputationLedger PDA per agent. Single-direction CPI chain: marketplace -> reputation -> registry. webber-registry gets a new `update_agent_reputation` instruction for the reputation program to write scores back. Score formula: base (tx*10, cap 5000) + volume bonus (vol/1M, cap 3000) - dispute penalty (disputes*150) + recovery (clean*75). Tier thresholds: 0-999 T1, 1000-3999 T2, 4000-7999 T3, 8000+ T4.

**Tech Stack:** Anchor 0.31.1, Solana CLI 3.1.9, Rust 1.94, TypeScript/Mocha/Chai tests

**Toolchain:** Every shell command MUST be prefixed with: `export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"`

---

### Task 1: Git Setup + Program Scaffold

**Files:**
- Create: `programs/webber-reputation/src/lib.rs`
- Create: `programs/webber-reputation/Cargo.toml`
- Create: `programs/webber-reputation/Xargo.toml`
- Modify: `Anchor.toml`
- Create: `tests/webber-reputation.ts`

**Step 1: Create build/reputation branch from develop**

```bash
git checkout develop
git checkout -b build/reputation
```

**Step 2: Generate program keypair and scaffold**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
mkdir -p programs/webber-reputation/src
solana-keygen new --no-bip39-passphrase -o programs/webber-reputation/src/webber_reputation-keypair.json
solana address -k programs/webber-reputation/src/webber_reputation-keypair.json
```

Note the program ID from the output and use it below.

**Step 3: Create `programs/webber-reputation/Xargo.toml`**

```toml
[target.bpfel-unknown-unknown.dependencies.std]
features = []
```

**Step 4: Create `programs/webber-reputation/Cargo.toml`**

```toml
[package]
name = "webber-reputation"
version = "0.1.0"
description = "Webber Protocol Reputation Engine — trust scores from real economic activity"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "webber_reputation"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = { version = "0.31.1", features = ["init-if-needed"] }
anchor-spl = { version = "0.31.1", features = ["token"] }
webber-registry = { path = "../webber-registry", features = ["cpi"] }
```

Note: webber-marketplace dependency added later in Task 6 when wiring the CPI.

**Step 5: Create minimal `programs/webber-reputation/src/lib.rs`**

```rust
use anchor_lang::prelude::*;

declare_id!("PASTE_PROGRAM_ID_HERE");

#[program]
pub mod webber_reputation {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        msg!("webber-reputation scaffold");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
```

**Step 6: Update `Anchor.toml`** — add webber_reputation under `[programs.devnet]`:

```toml
webber_reputation = "PASTE_PROGRAM_ID_HERE"
```

**Step 7: Create empty test file `tests/webber-reputation.ts`**

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberReputation } from "../target/types/webber_reputation";
import { assert } from "chai";

describe("webber-reputation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const reputationProgram = anchor.workspace.WebberReputation as Program<WebberReputation>;

  it("Scaffold compiles", () => {
    assert.ok(reputationProgram.programId);
    console.log("Reputation program ID:", reputationProgram.programId.toBase58());
  });
});
```

**Step 8: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

Expected: All existing 23 tests pass + 1 new scaffold test = 24 passing.

**Step 9: Commit**

```bash
git add programs/webber-reputation/ Anchor.toml tests/webber-reputation.ts
git commit -m "feat(reputation): scaffold webber-reputation program"
```

---

### Task 2: Modify webber-registry — Add tier field + update_agent_reputation instruction

**Files:**
- Modify: `programs/webber-registry/src/lib.rs`
- Modify: `tests/webber-registry.ts`

**Step 1: Add `tier` field to AgentAccount in `programs/webber-registry/src/lib.rs`**

In the `AgentAccount` struct, add after `reputation_score`:
```rust
/// Reputation tier (1-4), derived from score thresholds
pub tier: u8,
```

Update `MAX_SIZE` to add 1 byte for the tier field.

In `register_agent` instruction, initialize:
```rust
agent.tier = 1; // Default tier
```

**Step 2: Add `update_agent_reputation` instruction to webber-registry**

Add inside `pub mod webber_registry`:
```rust
/// Update an agent's reputation score and tier.
/// Only callable by the reputation program's PDA.
pub fn update_agent_reputation(
    ctx: Context<UpdateAgentReputation>,
    score: u64,
    tier: u8,
) -> Result<()> {
    require!(tier >= 1 && tier <= 4, RegistryError::InvalidTier);

    let agent = &mut ctx.accounts.agent_account;
    let old_score = agent.reputation_score;
    agent.reputation_score = score;
    agent.tier = tier;

    msg!(
        "Agent reputation updated: {} -> {}, tier {}",
        old_score,
        score,
        tier
    );
    Ok(())
}
```

**Step 3: Add the `UpdateAgentReputation` accounts struct**

```rust
#[derive(Accounts)]
pub struct UpdateAgentReputation<'info> {
    /// The reputation program's authority PDA
    /// Validated by checking it's the expected PDA from the reputation program
    pub reputation_authority: Signer<'info>,

    /// The agent account to update
    #[account(
        mut,
        seeds = [b"agent", agent_account.owner.as_ref()],
        bump = agent_account.bump,
    )]
    pub agent_account: Account<'info, AgentAccount>,
}
```

**Step 4: Add `InvalidTier` error variant to `RegistryError`**

```rust
#[msg("Invalid tier value: must be 1-4")]
InvalidTier,
```

**Step 5: Update existing registry tests to handle new `tier` field**

Add tier assertion to the "Registers an agent" test:
```typescript
assert.equal(agent.tier, 1); // Default tier
```

**Step 6: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

Expected: All tests pass (existing registry tests still work with new field).

**Step 7: Commit**

```bash
git add programs/webber-registry/src/lib.rs tests/webber-registry.ts
git commit -m "feat(registry): add tier field and update_agent_reputation instruction"
```

---

### Task 3: Implement ReputationLedger Account + Constants + Errors + Events

**Files:**
- Modify: `programs/webber-reputation/src/lib.rs`

**Step 1: Replace scaffold with full account structs, enums, errors, events**

```rust
use anchor_lang::prelude::*;

declare_id!("PROGRAM_ID");

/// Score formula constants
pub const BASE_SCORE_PER_TX: u64 = 10;
pub const BASE_SCORE_CAP: u64 = 5000;
pub const VOLUME_DIVISOR: u64 = 1_000_000; // 1M raw tokens (with 9 decimals, this is 0.001 $WEB)
pub const VOLUME_BONUS_CAP: u64 = 3000;
pub const DISPUTE_PENALTY: u64 = 150;
pub const DISPUTE_RECOVERY: u64 = 75;
pub const MAX_SCORE: u32 = 10000;

/// Tier thresholds
pub const TIER_2_THRESHOLD: u32 = 1000;
pub const TIER_3_THRESHOLD: u32 = 4000;
pub const TIER_4_THRESHOLD: u32 = 8000;

#[program]
pub mod webber_reputation {
    use super::*;
    // Instructions added in subsequent tasks
}

/// Reputation ledger for a single agent. PDA seeds: ["reputation", agent.key]
#[account]
pub struct ReputationLedger {
    /// The agent this ledger belongs to
    pub agent: Pubkey,
    /// Lifetime successful transactions as provider
    pub total_transactions: u64,
    /// Lifetime $WEB transacted
    pub total_volume: u64,
    /// Disputes raised by buyers against this agent
    pub disputes_opened_against: u16,
    /// Disputes that resolved in this agent's favour
    pub disputes_resolved_clean: u16,
    /// Computed reputation score 0-10000
    pub score: u32,
    /// Tier 1-4, derived from score
    pub tier: u8,
    /// Timestamp of last score recalculation
    pub last_updated: i64,
    /// PDA bump
    pub bump: u8,
}

impl ReputationLedger {
    /// 8 (disc) + 32 + 8 + 8 + 2 + 2 + 4 + 1 + 8 + 1 = 74
    pub const MAX_SIZE: usize = 8 + 32 + 8 + 8 + 2 + 2 + 4 + 1 + 8 + 1;
}

/// Helper: calculate reputation score from ledger fields
pub fn calculate_score(
    total_transactions: u64,
    total_volume: u64,
    disputes_opened: u16,
    disputes_clean: u16,
) -> Result<(u32, u8)> {
    // Base score: tx * 10, capped at 5000
    let base_raw = total_transactions
        .checked_mul(BASE_SCORE_PER_TX)
        .ok_or(ReputationError::ArithmeticOverflow)?;
    let base = std::cmp::min(base_raw, BASE_SCORE_CAP);

    // Volume bonus: volume / 1M, capped at 3000
    let volume_raw = total_volume
        .checked_div(VOLUME_DIVISOR)
        .ok_or(ReputationError::ArithmeticOverflow)?;
    let volume_bonus = std::cmp::min(volume_raw, VOLUME_BONUS_CAP);

    // Positive subtotal
    let positive = base
        .checked_add(volume_bonus)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Dispute penalty
    let penalty = (disputes_opened as u64)
        .checked_mul(DISPUTE_PENALTY)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Dispute recovery
    let recovery = (disputes_clean as u64)
        .checked_mul(DISPUTE_RECOVERY)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Final score: positive - penalty + recovery, clamped to [0, MAX_SCORE]
    let after_penalty = positive.saturating_sub(penalty);
    let final_score_u64 = after_penalty
        .checked_add(recovery)
        .ok_or(ReputationError::ArithmeticOverflow)?;
    let score = std::cmp::min(final_score_u64, MAX_SCORE as u64) as u32;

    // Derive tier from score
    let tier = if score >= TIER_4_THRESHOLD {
        4u8
    } else if score >= TIER_3_THRESHOLD {
        3u8
    } else if score >= TIER_2_THRESHOLD {
        2u8
    } else {
        1u8
    };

    Ok((score, tier))
}

#[error_code]
pub enum ReputationError {
    #[msg("Agent not registered in webber-registry")]
    AgentNotRegistered,
    #[msg("Reputation ledger already initialized for this agent")]
    LedgerAlreadyInitialized,
    #[msg("Unauthorized caller - only marketplace can update reputation")]
    UnauthorizedCaller,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid tier value")]
    InvalidTier,
    #[msg("Agent has requested deregistration")]
    AgentDeregistering,
}

// -- Events --

#[event]
pub struct ReputationInitializedEvent {
    pub agent: Pubkey,
    pub tier: u8,
}

#[event]
pub struct ReputationUpdatedEvent {
    pub agent: Pubkey,
    pub old_score: u32,
    pub new_score: u32,
    pub new_tier: u8,
}

#[event]
pub struct DisputeRecordedEvent {
    pub agent: Pubkey,
    pub disputes_count: u16,
    pub new_score: u32,
}

#[event]
pub struct DisputeResolvedEvent {
    pub agent: Pubkey,
    pub in_favour: bool,
    pub new_score: u32,
}
```

**Step 2: Build to verify structs compile**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
```

Expected: Clean compile.

**Step 3: Commit**

```bash
git add programs/webber-reputation/src/lib.rs
git commit -m "feat(reputation): define ReputationLedger, score formula, errors, events"
```

---

### Task 4: Implement init_reputation_ledger instruction

**Files:**
- Modify: `programs/webber-reputation/src/lib.rs`
- Modify: `tests/webber-reputation.ts`

**Step 1: Add `init_reputation_ledger` instruction inside `pub mod webber_reputation`**

```rust
pub fn init_reputation_ledger(ctx: Context<InitReputationLedger>) -> Result<()> {
    // Validate agent is active (not deregistering)
    let agent = &ctx.accounts.agent_account;
    require!(
        agent.unstake_requested_at.is_none(),
        ReputationError::AgentDeregistering
    );

    let ledger = &mut ctx.accounts.reputation_ledger;
    ledger.agent = ctx.accounts.agent_account.owner;
    ledger.total_transactions = 0;
    ledger.total_volume = 0;
    ledger.disputes_opened_against = 0;
    ledger.disputes_resolved_clean = 0;
    ledger.score = 0;
    ledger.tier = 1;
    ledger.last_updated = Clock::get()?.unix_timestamp;
    ledger.bump = ctx.bumps.reputation_ledger;

    emit!(ReputationInitializedEvent {
        agent: ledger.agent,
        tier: 1,
    });

    msg!("Reputation ledger initialized for agent: {}", ledger.agent);
    Ok(())
}
```

**Step 2: Add the `InitReputationLedger` accounts struct**

```rust
#[derive(Accounts)]
pub struct InitReputationLedger<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The agent's AgentAccount in webber-registry (validates registration)
    #[account(
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent_account.bump,
        seeds::program = webber_registry::ID,
        constraint = agent_account.owner == owner.key() @ ReputationError::AgentNotRegistered,
    )]
    pub agent_account: Account<'info, webber_registry::AgentAccount>,

    #[account(
        init,
        payer = owner,
        space = ReputationLedger::MAX_SIZE,
        seeds = [b"reputation", owner.key().as_ref()],
        bump,
    )]
    pub reputation_ledger: Account<'info, ReputationLedger>,

    pub system_program: Program<'info, System>,
}
```

**Step 3: Write tests for init_reputation_ledger**

Update `tests/webber-reputation.ts` with full test setup (token init, funded agent, registration, then ledger init). Tests to include:
- Successfully initializes reputation ledger for registered agent
- Rejects initialization for non-registered agent
- Sets all fields to defaults (score=0, tier=1, counters=0)

**Step 4: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add programs/webber-reputation/src/lib.rs tests/webber-reputation.ts
git commit -m "feat(reputation): implement init_reputation_ledger with registry validation"
```

---

### Task 5: Implement update_reputation instruction + score formula

**Files:**
- Modify: `programs/webber-reputation/src/lib.rs`
- Modify: `tests/webber-reputation.ts`

**Step 1: Add `update_reputation` instruction**

This is the core instruction called by marketplace via CPI. It increments counters, recalculates score, derives tier, and CPIs to registry.

```rust
pub fn update_reputation(ctx: Context<UpdateReputation>, amount: u64) -> Result<()> {
    let ledger = &mut ctx.accounts.reputation_ledger;
    let old_score = ledger.score;

    // Increment counters
    ledger.total_transactions = ledger
        .total_transactions
        .checked_add(1)
        .ok_or(ReputationError::ArithmeticOverflow)?;
    ledger.total_volume = ledger
        .total_volume
        .checked_add(amount)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Recalculate score
    let (new_score, new_tier) = calculate_score(
        ledger.total_transactions,
        ledger.total_volume,
        ledger.disputes_opened_against,
        ledger.disputes_resolved_clean,
    )?;

    ledger.score = new_score;
    ledger.tier = new_tier;
    ledger.last_updated = Clock::get()?.unix_timestamp;

    // CPI to webber-registry to update agent's score and tier
    let agent_key = ledger.agent;
    let seeds = &[b"reputation_authority".as_ref(), &[ctx.bumps.reputation_authority]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = webber_registry::cpi::accounts::UpdateAgentReputation {
        reputation_authority: ctx.accounts.reputation_authority.to_account_info(),
        agent_account: ctx.accounts.agent_account.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.registry_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    webber_registry::cpi::update_agent_reputation(cpi_ctx, new_score as u64, new_tier)?;

    emit!(ReputationUpdatedEvent {
        agent: agent_key,
        old_score,
        new_score,
        new_tier,
    });

    msg!(
        "Reputation updated: agent={}, score {} -> {}, tier {}",
        agent_key,
        old_score,
        new_score,
        new_tier
    );
    Ok(())
}
```

**Step 2: Add `UpdateReputation` accounts struct**

```rust
#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    /// The marketplace state PDA (validates the caller is the marketplace program)
    #[account(
        seeds = [b"marketplace_state"],
        bump,
        seeds::program = webber_marketplace::ID,
    )]
    pub marketplace_state: AccountInfo<'info>,

    /// The signer — in CPI this is the buyer who signed the outer transaction
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"reputation", reputation_ledger.agent.as_ref()],
        bump = reputation_ledger.bump,
    )]
    pub reputation_ledger: Account<'info, ReputationLedger>,

    /// Agent account in registry (for CPI update)
    #[account(
        mut,
        seeds = [b"agent", reputation_ledger.agent.as_ref()],
        bump = agent_account.bump,
        seeds::program = webber_registry::ID,
    )]
    pub agent_account: Account<'info, webber_registry::AgentAccount>,

    /// Reputation authority PDA (signs CPI to registry)
    /// CHECK: PDA validated by seeds
    #[account(
        seeds = [b"reputation_authority"],
        bump,
    )]
    pub reputation_authority: UncheckedAccount<'info>,

    /// The webber-registry program for CPI
    /// CHECK: Validated by address
    #[account(address = webber_registry::ID)]
    pub registry_program: AccountInfo<'info>,
}
```

Note: This requires adding `webber-marketplace` as a dependency to `webber-reputation/Cargo.toml` for `webber_marketplace::ID`. Add:
```toml
webber-marketplace = { path = "../webber-marketplace", features = ["cpi"] }
```

**IMPORTANT:** This creates a circular dependency (marketplace depends on reputation for CPI, reputation depends on marketplace for ID validation). To resolve: use the marketplace program ID as a raw Pubkey constant instead of importing it. Remove the marketplace dependency and hardcode:
```rust
/// Marketplace program ID (validated at compile time)
pub const MARKETPLACE_PROGRAM_ID: Pubkey = pubkey!("Fzm6CBQXa1vDDXXCp89T15pec82nRmEXe1rt8kXtPbDn");
```
Then use `MARKETPLACE_PROGRAM_ID` in the seeds::program constraint.

**Step 3: Write tests for update_reputation**

Tests to include:
- Update reputation with a transaction amount, verify score = 10 (1 tx * 10)
- Multiple updates, verify score accumulates correctly
- Verify tier transitions at boundaries (100 tx = 1000 score = Tier 2)
- Verify volume bonus contributes to score
- Verify AgentAccount.reputation_score gets updated via CPI

Since we can't easily simulate CPI from marketplace in tests, these tests call `update_reputation` directly using the test signer. The marketplace CPI integration test comes in Task 6.

**Step 4: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

**Step 5: Commit**

```bash
git add programs/webber-reputation/ tests/webber-reputation.ts
git commit -m "feat(reputation): implement update_reputation with score formula and registry CPI"
```

---

### Task 6: Wire CPI from marketplace execute_payment to reputation

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Modify: `programs/webber-marketplace/Cargo.toml`
- Modify: `tests/webber-marketplace.ts`

**Step 1: Add webber-reputation dependency to marketplace Cargo.toml**

```toml
webber-reputation = { path = "../webber-reputation", features = ["cpi"] }
```

**Step 2: Modify `execute_payment` in marketplace**

After the existing CPI to webber-token (transfer_with_burn), add CPI to webber-reputation:

```rust
// --- CPI to webber-reputation for score update ---
let cpi_reputation_accounts = webber_reputation::cpi::accounts::UpdateReputation {
    marketplace_state: ctx.accounts.marketplace_state.to_account_info(),
    caller: ctx.accounts.buyer.to_account_info(),
    reputation_ledger: ctx.accounts.reputation_ledger.to_account_info(),
    agent_account: ctx.accounts.provider_agent.to_account_info(),
    reputation_authority: ctx.accounts.reputation_authority.to_account_info(),
    registry_program: ctx.accounts.registry_program.to_account_info(),
};
let cpi_reputation_ctx = CpiContext::new(
    ctx.accounts.webber_reputation_program.to_account_info(),
    cpi_reputation_accounts,
);
webber_reputation::cpi::update_reputation(cpi_reputation_ctx, amount)?;
```

**Step 3: Add new accounts to ExecutePayment struct**

```rust
/// Provider's reputation ledger
#[account(
    mut,
    seeds = [b"reputation", listing.provider.as_ref()],
    bump = reputation_ledger.bump,
    seeds::program = webber_reputation::ID,
)]
pub reputation_ledger: Account<'info, webber_reputation::ReputationLedger>,

/// Reputation authority PDA (for reputation's CPI to registry)
/// CHECK: PDA from reputation program
#[account(
    seeds = [b"reputation_authority"],
    bump,
    seeds::program = webber_reputation::ID,
)]
pub reputation_authority: AccountInfo<'info>,

/// The webber-reputation program
/// CHECK: Validated by address
#[account(address = webber_reputation::ID)]
pub webber_reputation_program: AccountInfo<'info>,

/// The webber-registry program (for reputation's CPI chain)
/// CHECK: Validated by address
#[account(address = webber_registry::ID)]
pub registry_program: AccountInfo<'info>,
```

**Step 4: Update marketplace test helpers**

Update `execute_payment` test calls to include the new accounts:
- `reputation_ledger`: derived from `["reputation", provider_pubkey]` via reputation program
- `reputation_authority`: derived from `["reputation_authority"]` via reputation program
- `webber_reputation_program`: reputation program ID
- `registry_program`: registry program ID

**Step 5: Update existing marketplace tests**

All tests that call `execute_payment` must pass the new accounts. Tests that only test listing/close/update are unaffected.

For the payment test: before calling `execute_payment`, the provider must have an initialized ReputationLedger (call `init_reputation_ledger` first).

**Step 6: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

Expected: All tests pass including the full CPI chain: marketplace -> token (burn) + marketplace -> reputation -> registry.

**Step 7: Commit**

```bash
git add programs/webber-marketplace/ tests/webber-marketplace.ts
git commit -m "feat(marketplace): wire CPI to reputation engine on execute_payment"
```

---

### Task 7: Implement record_dispute and resolve_dispute instructions

**Files:**
- Modify: `programs/webber-reputation/src/lib.rs`
- Modify: `tests/webber-reputation.ts`

**Step 1: Add `record_dispute` instruction**

```rust
pub fn record_dispute(ctx: Context<RecordDispute>) -> Result<()> {
    let ledger = &mut ctx.accounts.reputation_ledger;

    ledger.disputes_opened_against = ledger
        .disputes_opened_against
        .checked_add(1)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    let (new_score, new_tier) = calculate_score(
        ledger.total_transactions,
        ledger.total_volume,
        ledger.disputes_opened_against,
        ledger.disputes_resolved_clean,
    )?;

    ledger.score = new_score;
    ledger.tier = new_tier;
    ledger.last_updated = Clock::get()?.unix_timestamp;

    // CPI to registry to update score
    let seeds = &[b"reputation_authority".as_ref(), &[ctx.bumps.reputation_authority]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = webber_registry::cpi::accounts::UpdateAgentReputation {
        reputation_authority: ctx.accounts.reputation_authority.to_account_info(),
        agent_account: ctx.accounts.agent_account.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.registry_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    webber_registry::cpi::update_agent_reputation(cpi_ctx, new_score as u64, new_tier)?;

    emit!(DisputeRecordedEvent {
        agent: ledger.agent,
        disputes_count: ledger.disputes_opened_against,
        new_score,
    });

    Ok(())
}

pub fn resolve_dispute(ctx: Context<ResolveDispute>, in_agent_favour: bool) -> Result<()> {
    let ledger = &mut ctx.accounts.reputation_ledger;

    if in_agent_favour {
        ledger.disputes_resolved_clean = ledger
            .disputes_resolved_clean
            .checked_add(1)
            .ok_or(ReputationError::ArithmeticOverflow)?;
    }

    let (new_score, new_tier) = calculate_score(
        ledger.total_transactions,
        ledger.total_volume,
        ledger.disputes_opened_against,
        ledger.disputes_resolved_clean,
    )?;

    ledger.score = new_score;
    ledger.tier = new_tier;
    ledger.last_updated = Clock::get()?.unix_timestamp;

    // CPI to registry to update score
    let seeds = &[b"reputation_authority".as_ref(), &[ctx.bumps.reputation_authority]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = webber_registry::cpi::accounts::UpdateAgentReputation {
        reputation_authority: ctx.accounts.reputation_authority.to_account_info(),
        agent_account: ctx.accounts.agent_account.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.registry_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    webber_registry::cpi::update_agent_reputation(cpi_ctx, new_score as u64, new_tier)?;

    emit!(DisputeResolvedEvent {
        agent: ledger.agent,
        in_favour: in_agent_favour,
        new_score,
    });

    Ok(())
}
```

**Step 2: Add account structs for both instructions**

Both need: reputation_ledger (mut), agent_account (mut, from registry), reputation_authority (PDA signer), registry_program, plus a signer/authority for authorization.

**Step 3: Write tests**

- Record dispute: score decreases by 150 per dispute
- Resolve dispute in favour: score recovers by 75
- Resolve dispute not in favour: score unchanged
- Score cannot go below 0
- Tier downgrades correctly after disputes

**Step 4: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

**Step 5: Commit**

```bash
git add programs/webber-reputation/src/lib.rs tests/webber-reputation.ts
git commit -m "feat(reputation): implement record_dispute and resolve_dispute"
```

---

### Task 8: Comprehensive integration tests + boundary tests

**Files:**
- Modify: `tests/webber-reputation.ts`
- Modify: `tests/webber-marketplace.ts`

**Step 1: Add score formula boundary tests to webber-reputation.ts**

- Test base score cap: 500 transactions = min(5000, 5000) = 5000 (not 5010)
- Test volume bonus cap: huge volume = min(volume/1M, 3000) = 3000
- Test tier boundaries:
  - Score 999 -> Tier 1
  - Score 1000 -> Tier 2
  - Score 3999 -> Tier 2
  - Score 4000 -> Tier 3
  - Score 7999 -> Tier 3
  - Score 8000 -> Tier 4
- Test dispute penalty brings score to 0 (not negative)
- Test max score 10000 (not above)

**Step 2: Add full integration test to marketplace tests**

Full flow: register agent -> init reputation -> create listing -> execute payment -> verify reputation updated -> open dispute -> record dispute -> verify score decreased -> resolve dispute -> verify recovery

**Step 3: Build and test**

```bash
export PATH="$HOME/.local/node_modules/.bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
anchor build
anchor test
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/
git commit -m "test(reputation): add boundary value and full integration tests"
```

---

### Task 9: Vet Checklist + Docs + Push

**Vet checklist (manual verification):**
- [ ] `anchor build` passes with zero errors/warnings
- [ ] `anchor test` all tests passing
- [ ] Score formula matches spec: base (tx*10, cap 5000) + volume (vol/1M, cap 3000) - penalty (disputes*150) + recovery (clean*75)
- [ ] CPI chain direction: marketplace -> reputation -> registry, never reverse
- [ ] All arithmetic uses checked operations (no unchecked math on any u64/u32/u16)
- [ ] All account owner/PDA checks present
- [ ] State updates before CPI in update_reputation
- [ ] Tier thresholds correct: 0-999 T1, 1000-3999 T2, 4000-7999 T3, 8000+ T4
- [ ] Every error case has named error code
- [ ] Every state-changing instruction emits typed event

**Update docs:**
- Update `tasks/todo.md` with Build 2 completion summary
- Update `tasks/lessons.md` with new patterns from Build 2

**Push and merge:**
```bash
git push -u origin build/reputation
git checkout develop
git merge build/reputation
git push origin develop
```
