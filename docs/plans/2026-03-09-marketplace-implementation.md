# Capability Marketplace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the `webber-marketplace` Anchor program — agents post services priced in $WEB, buyers pay atomically with 0.5% burn via CPI to webber-token.

**Architecture:** New program `webber-marketplace` with 3 account types (MarketplaceState, ServiceListing, ServiceTransaction) and 6 instructions. Cross-program reads of `webber-registry::AgentAccount` to validate providers. CPI to `webber-token::transfer_with_burn` for atomic payments. All state updates before CPI for reentrancy protection.

**Tech Stack:** Anchor 0.31.1, Solana CLI 3.1.9, Rust, TypeScript/Mocha/Chai for tests

**Environment:** Always run `source /Users/mahomedayob/WEBBER/.env.sh` before any shell command.

---

### Task 1: Git Setup + Program Scaffold

**Files:**
- Create: `programs/webber-marketplace/Cargo.toml`
- Create: `programs/webber-marketplace/Xargo.toml`
- Create: `programs/webber-marketplace/src/lib.rs`
- Modify: `Anchor.toml`
- Modify: `.gitignore`

**Step 1: Create develop and build/marketplace branches**

```bash
source /Users/mahomedayob/WEBBER/.env.sh
cd /Users/mahomedayob/WEBBER/webber-protocol
git checkout -b develop
git push -u origin develop
git checkout -b build/marketplace
```

**Step 2: Update .gitignore for Phase 2**

Add to `.gitignore`:
```
.env
*.key
*.secret
```

**Step 3: Create program directory and Cargo.toml**

Create `programs/webber-marketplace/Cargo.toml`:
```toml
[package]
name = "webber-marketplace"
version = "0.1.0"
description = "Webber Protocol Capability Marketplace — service listings and atomic payments"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "webber_marketplace"

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
webber-token = { path = "../webber-token", features = ["cpi"] }
webber-registry = { path = "../webber-registry", features = ["cpi"] }
```

Create `programs/webber-marketplace/Xargo.toml`:
```toml
[target.bpfel-unknown-unknown.dependencies.std]
features = []
```

**Step 4: Create minimal lib.rs skeleton**

Create `programs/webber-marketplace/src/lib.rs`:
```rust
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod webber_marketplace {
    use super::*;
}
```

**Step 5: Update Anchor.toml with new program**

Add to `[programs.devnet]` section:
```toml
webber_marketplace = "<will be replaced after first build>"
```

**Step 6: Build to generate program ID and verify compilation**

```bash
source /Users/mahomedayob/WEBBER/.env.sh
cd /Users/mahomedayob/WEBBER/webber-protocol
anchor keys list  # Note the generated marketplace program ID
anchor build
```

Update `lib.rs` `declare_id!()` and `Anchor.toml` `[programs.devnet]` with the generated ID.

**Step 7: Verify build passes**

```bash
anchor build
```
Expected: Clean compilation of all 3 programs.

**Step 8: Commit**

```bash
git add programs/webber-marketplace/ Anchor.toml .gitignore
git commit -m "feat(marketplace): scaffold webber-marketplace program"
```

---

### Task 2: Account Structs, Enums, Errors, Events

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`

**Step 1: Define enums, account structs, errors, and events**

Add to `lib.rs` after the `#[program]` module:

```rust
use anchor_spl::token::{Token, TokenAccount, Mint};
use webber_token::{BURN_NUMERATOR, BURN_DENOMINATOR};

/// Capability types for service listings
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CapabilityType {
    DataRetrieval = 0,
    Computation = 1,
    Execution = 2,
    Analysis = 3,
    Routing = 4,
    Custom = 5,
}

/// Transaction status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TransactionStatus {
    Pending = 0,
    Completed = 1,
    Disputed = 2,
    Resolved = 3,
}

/// Global marketplace state. Seeds: ["marketplace_state"]
#[account]
pub struct MarketplaceState {
    pub listing_id_counter: u64,
    pub total_volume: u64,
    pub total_burned: u64,
    pub total_transactions: u64,
    pub bump: u8,
}

impl MarketplaceState {
    /// 8 (disc) + 8 + 8 + 8 + 8 + 1 = 41
    pub const MAX_SIZE: usize = 8 + 8 + 8 + 8 + 8 + 1;
}

/// Max title length
pub const MAX_TITLE_LEN: usize = 64;
/// Max description URI length
pub const MAX_DESC_URI_LEN: usize = 128;
/// 24-hour dispute window in seconds
pub const DISPUTE_WINDOW: i64 = 24 * 60 * 60;

/// Service listing posted by an agent. Seeds: ["listing", provider, listing_id_bytes]
#[account]
pub struct ServiceListing {
    pub provider: Pubkey,
    pub listing_id: u64,
    pub capability_type: CapabilityType,
    pub price_per_call: u64,
    pub price_subscription: u64,
    pub title: String,
    pub description_uri: String,
    pub is_active: bool,
    pub total_calls: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl ServiceListing {
    /// 8 (disc) + 32 + 8 + 1 + 8 + 8 + (4+64) + (4+128) + 1 + 8 + 8 + 1 = 283
    pub const MAX_SIZE: usize = 8 + 32 + 8 + 1 + 8 + 8 + (4 + MAX_TITLE_LEN) + (4 + MAX_DESC_URI_LEN) + 1 + 8 + 8 + 1;
}

/// Record of a service transaction. Seeds: ["transaction", listing, buyer, tx_id_bytes]
#[account]
pub struct ServiceTransaction {
    pub listing: Pubkey,
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub amount_paid: u64,
    pub amount_burned: u64,
    pub status: TransactionStatus,
    pub timestamp: i64,
    pub bump: u8,
}

impl ServiceTransaction {
    /// 8 (disc) + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1 = 130
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1;
}

// -- Error Codes --

#[error_code]
pub enum MarketplaceError {
    #[msg("Provider is not a registered agent in webber-registry")]
    NotRegisteredAgent,
    #[msg("Agent has requested deregistration and is no longer active")]
    AgentDeregistering,
    #[msg("Listing is not active")]
    ListingNotActive,
    #[msg("Price must be greater than zero for at least one pricing type")]
    InvalidPrice,
    #[msg("Title exceeds maximum length of 64 characters")]
    TitleTooLong,
    #[msg("Description URI exceeds maximum length of 128 characters")]
    DescriptionUriTooLong,
    #[msg("24-hour dispute window has expired")]
    DisputeWindowClosed,
    #[msg("Only the buyer can open a dispute")]
    NotTransactionBuyer,
    #[msg("Transaction is not in Completed status")]
    InvalidTransactionStatus,
    #[msg("Only the listing provider can perform this action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}

// -- Events --

#[event]
pub struct CreateListingEvent {
    pub provider: Pubkey,
    pub listing_id: u64,
    pub capability_type: u8,
    pub price_per_call: u64,
}

#[event]
pub struct UpdateListingEvent {
    pub listing_id: u64,
    pub price_per_call: u64,
    pub price_subscription: u64,
    pub is_active: bool,
}

#[event]
pub struct CloseListingEvent {
    pub listing_id: u64,
}

#[event]
pub struct PaymentExecutedEvent {
    pub listing_id: u64,
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub amount_paid: u64,
    pub amount_burned: u64,
    pub tx_id: u64,
}

#[event]
pub struct DisputeOpenedEvent {
    pub tx_id: u64,
    pub buyer: Pubkey,
    pub provider: Pubkey,
}
```

**Step 2: Build to verify all types compile**

```bash
source /Users/mahomedayob/WEBBER/.env.sh
cd /Users/mahomedayob/WEBBER/webber-protocol
anchor build
```
Expected: Clean compilation.

**Step 3: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs
git commit -m "feat(marketplace): define account structs, enums, errors, and events"
```

---

### Task 3: initialize_marketplace Instruction

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Create: `tests/webber-marketplace.ts`

**Step 1: Implement initialize_marketplace**

Add inside `pub mod webber_marketplace`:
```rust
pub fn initialize_marketplace(ctx: Context<InitializeMarketplace>) -> Result<()> {
    let state = &mut ctx.accounts.marketplace_state;
    state.listing_id_counter = 0;
    state.total_volume = 0;
    state.total_burned = 0;
    state.total_transactions = 0;
    state.bump = ctx.bumps.marketplace_state;

    msg!("Marketplace initialized");
    Ok(())
}
```

Add the accounts struct:
```rust
#[derive(Accounts)]
pub struct InitializeMarketplace<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = MarketplaceState::MAX_SIZE,
        seeds = [b"marketplace_state"],
        bump,
    )]
    pub marketplace_state: Account<'info, MarketplaceState>,

    pub system_program: Program<'info, System>,
}
```

**Step 2: Build**

```bash
anchor build
```

**Step 3: Write test for initialization**

Create `tests/webber-marketplace.ts`:
```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberMarketplace } from "../target/types/webber_marketplace";
import { WebberToken } from "../target/types/webber_token";
import { WebberRegistry } from "../target/types/webber_registry";
import {
  Keypair,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("webber-marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marketplaceProgram = anchor.workspace.WebberMarketplace as Program<WebberMarketplace>;
  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const payer = provider.wallet as anchor.Wallet;

  // Token setup
  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  // Marketplace state PDA
  const [marketplaceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketplace_state")],
    marketplaceProgram.programId
  );

  const FUND_AMOUNT = new anchor.BN("500000000000"); // 500 $WEB
  const MIN_STAKE = new anchor.BN("100000000000"); // 100 $WEB

  // Helpers
  function getAgentPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  function getVaultPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  function getListingPda(provider: PublicKey, listingId: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("listing"),
        provider.toBuffer(),
        new anchor.BN(listingId).toArrayLike(Buffer, "le", 8),
      ],
      marketplaceProgram.programId
    );
  }

  function getTransactionPda(listing: PublicKey, buyer: PublicKey, txId: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("transaction"),
        listing.toBuffer(),
        buyer.toBuffer(),
        new anchor.BN(txId).toArrayLike(Buffer, "le", 8),
      ],
      marketplaceProgram.programId
    );
  }

  async function createFundedAgent(): Promise<{
    wallet: Keypair;
    tokenAccount: PublicKey;
  }> {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const tokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      wallet.publicKey
    );

    // Fund with $WEB (transfer_with_burn takes 0.5% so send extra)
    await tokenProgram.methods
      .transferWithBurn(FUND_AMOUNT)
      .accounts({
        authority: payer.publicKey,
        mint: mintKeypair.publicKey,
        from: treasuryKeypair.publicKey,
        to: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return { wallet, tokenAccount };
  }

  async function registerAgent(wallet: Keypair, tokenAccount: PublicKey): Promise<void> {
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    await registryProgram.methods
      .registerAgent(MIN_STAKE, ["data_retrieval"])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();
  }

  before(async () => {
    // Initialize $WEB token
    await tokenProgram.methods
      .initializeMint()
      .accounts({
        payer: payer.publicKey,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthority,
        treasury: treasuryKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair, treasuryKeypair])
      .rpc();

    console.log("$WEB token initialized for marketplace tests");
  });

  it("Initializes the marketplace", async () => {
    await marketplaceProgram.methods
      .initializeMarketplace()
      .accounts({
        payer: payer.publicKey,
        marketplaceState: marketplaceState,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(state.listingIdCounter.toString(), "0");
    assert.equal(state.totalVolume.toString(), "0");
    assert.equal(state.totalBurned.toString(), "0");
    assert.equal(state.totalTransactions.toString(), "0");

    console.log("✅ Marketplace initialized");
  });

  // Remaining tests added in subsequent tasks
});
```

**Step 4: Run test**

```bash
source /Users/mahomedayob/WEBBER/.env.sh
cd /Users/mahomedayob/WEBBER/webber-protocol
anchor test
```
Expected: "Initializes the marketplace" test passes. All prior tests still pass.

**Step 5: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs tests/webber-marketplace.ts
git commit -m "feat(marketplace): implement initialize_marketplace instruction with test"
```

---

### Task 4: create_listing Instruction

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Modify: `tests/webber-marketplace.ts`

**Step 1: Implement create_listing**

Add inside `pub mod webber_marketplace`:
```rust
pub fn create_listing(
    ctx: Context<CreateListing>,
    capability_type: CapabilityType,
    price_per_call: u64,
    price_subscription: u64,
    title: String,
    description_uri: String,
) -> Result<()> {
    require!(
        price_per_call > 0 || price_subscription > 0,
        MarketplaceError::InvalidPrice
    );
    require!(title.len() <= MAX_TITLE_LEN, MarketplaceError::TitleTooLong);
    require!(
        description_uri.len() <= MAX_DESC_URI_LEN,
        MarketplaceError::DescriptionUriTooLong
    );

    // Validate provider is an active registered agent
    let agent = &ctx.accounts.provider_agent;
    require!(
        agent.unstake_requested_at.is_none(),
        MarketplaceError::AgentDeregistering
    );

    let state = &mut ctx.accounts.marketplace_state;
    let listing_id = state.listing_id_counter;

    // Initialize listing
    let listing = &mut ctx.accounts.listing;
    listing.provider = ctx.accounts.provider.key();
    listing.listing_id = listing_id;
    listing.capability_type = capability_type;
    listing.price_per_call = price_per_call;
    listing.price_subscription = price_subscription;
    listing.title = title;
    listing.description_uri = description_uri;
    listing.is_active = true;
    listing.total_calls = 0;
    listing.created_at = Clock::get()?.unix_timestamp;
    listing.bump = ctx.bumps.listing;

    // Increment counter
    state.listing_id_counter = listing_id
        .checked_add(1)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;

    emit!(CreateListingEvent {
        provider: listing.provider,
        listing_id,
        capability_type: capability_type as u8,
        price_per_call,
    });

    msg!("Listing created: id={}, provider={}", listing_id, listing.provider);
    Ok(())
}
```

Add accounts struct:
```rust
#[derive(Accounts)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"marketplace_state"],
        bump = marketplace_state.bump,
    )]
    pub marketplace_state: Account<'info, MarketplaceState>,

    #[account(
        init,
        payer = provider,
        space = ServiceListing::MAX_SIZE,
        seeds = [
            b"listing",
            provider.key().as_ref(),
            &marketplace_state.listing_id_counter.to_le_bytes(),
        ],
        bump,
    )]
    pub listing: Account<'info, ServiceListing>,

    /// Provider's agent account in webber-registry (validates registration)
    #[account(
        seeds = [b"agent", provider.key().as_ref()],
        bump = provider_agent.bump,
        seeds::program = webber_registry::ID,
        has_one = owner @ MarketplaceError::NotRegisteredAgent,
    )]
    pub provider_agent: Account<'info, webber_registry::AgentAccount>,

    /// CHECK: Validated via has_one on provider_agent. Must equal provider.
    pub owner: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}
```

**Important note:** The `has_one = owner` on `provider_agent` checks that `provider_agent.owner == owner.key()`. We also need `owner.key() == provider.key()`. We can enforce this with a constraint:

Actually, simpler approach — remove the `owner` field and use a constraint instead:

```rust
#[derive(Accounts)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [b"marketplace_state"],
        bump = marketplace_state.bump,
    )]
    pub marketplace_state: Account<'info, MarketplaceState>,

    #[account(
        init,
        payer = provider,
        space = ServiceListing::MAX_SIZE,
        seeds = [
            b"listing",
            provider.key().as_ref(),
            &marketplace_state.listing_id_counter.to_le_bytes(),
        ],
        bump,
    )]
    pub listing: Account<'info, ServiceListing>,

    /// Provider's agent account in webber-registry (validates registration)
    #[account(
        seeds = [b"agent", provider.key().as_ref()],
        bump = provider_agent.bump,
        seeds::program = webber_registry::ID,
        constraint = provider_agent.owner == provider.key() @ MarketplaceError::NotRegisteredAgent,
    )]
    pub provider_agent: Account<'info, webber_registry::AgentAccount>,

    pub system_program: Program<'info, System>,
}
```

The PDA seed `[b"agent", provider.key()]` already ensures the agent account belongs to this provider. The constraint double-checks the owner field.

**Step 2: Build**

```bash
anchor build
```

**Step 3: Add tests for create_listing**

Append to the describe block in `tests/webber-marketplace.ts`:

```typescript
it("Creates a listing for a registered agent", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, 0);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },  // CapabilityType enum
        new anchor.BN(5_000_000_000),  // 5 $WEB per call
        new anchor.BN(0),  // no subscription
        "Web Search Service",
        "ipfs://Qm..."
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listing.provider.toBase58(), wallet.publicKey.toBase58());
    assert.equal(listing.listingId.toString(), "0");
    assert.equal(listing.pricePerCall.toString(), "5000000000");
    assert.equal(listing.title, "Web Search Service");
    assert.isTrue(listing.isActive);
    assert.equal(listing.totalCalls.toString(), "0");

    // Verify counter incremented
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(state.listingIdCounter.toString(), "1");

    console.log("✅ Listing created successfully");
});

it("Rejects listing from non-registered agent", async () => {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Get current counter for listing PDA derivation
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const [listingPda] = getListingPda(wallet.publicKey, state.listingIdCounter.toNumber());
    const [agentPda] = getAgentPda(wallet.publicKey);

    try {
      await marketplaceProgram.methods
        .createListing(
          { computation: {} },
          new anchor.BN(10_000_000_000),
          new anchor.BN(0),
          "Compute Service",
          "ipfs://Qm..."
        )
        .accounts({
          provider: wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should reject non-registered agent");
    } catch (err) {
      assert.ok(err, "Non-registered agent should be rejected");
    }

    console.log("✅ Non-registered agent correctly rejected");
});

it("Rejects listing with zero price", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const currentId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, currentId);

    try {
      await marketplaceProgram.methods
        .createListing(
          { custom: {} },
          new anchor.BN(0),  // zero per-call
          new anchor.BN(0),  // zero subscription
          "Free Service",
          "ipfs://Qm..."
        )
        .accounts({
          provider: wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should reject zero price");
    } catch (err) {
      assert.include(err.toString(), "InvalidPrice");
    }

    console.log("✅ Zero price correctly rejected");
});
```

**Step 4: Run tests**

```bash
anchor test
```
Expected: All marketplace tests pass. All prior tests still pass.

**Step 5: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs tests/webber-marketplace.ts
git commit -m "feat(marketplace): implement create_listing with agent registration validation"
```

---

### Task 5: update_listing + close_listing Instructions

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Modify: `tests/webber-marketplace.ts`

**Step 1: Implement update_listing**

Add inside `pub mod webber_marketplace`:
```rust
pub fn update_listing(
    ctx: Context<UpdateListing>,
    price_per_call: Option<u64>,
    price_subscription: Option<u64>,
    description_uri: Option<String>,
    is_active: Option<bool>,
) -> Result<()> {
    let listing = &mut ctx.accounts.listing;

    if let Some(price) = price_per_call {
        listing.price_per_call = price;
    }
    if let Some(price) = price_subscription {
        listing.price_subscription = price;
    }
    if let Some(uri) = description_uri {
        require!(uri.len() <= MAX_DESC_URI_LEN, MarketplaceError::DescriptionUriTooLong);
        listing.description_uri = uri;
    }
    if let Some(active) = is_active {
        listing.is_active = active;
    }

    // Validate at least one price remains > 0
    require!(
        listing.price_per_call > 0 || listing.price_subscription > 0,
        MarketplaceError::InvalidPrice
    );

    emit!(UpdateListingEvent {
        listing_id: listing.listing_id,
        price_per_call: listing.price_per_call,
        price_subscription: listing.price_subscription,
        is_active: listing.is_active,
    });

    msg!("Listing {} updated", listing.listing_id);
    Ok(())
}
```

**Step 2: Implement close_listing**

```rust
pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
    let listing = &mut ctx.accounts.listing;
    listing.is_active = false;

    emit!(CloseListingEvent {
        listing_id: listing.listing_id,
    });

    msg!("Listing {} closed", listing.listing_id);
    Ok(())
}
```

**Step 3: Add accounts structs**

```rust
#[derive(Accounts)]
pub struct UpdateListing<'info> {
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"listing",
            provider.key().as_ref(),
            &listing.listing_id.to_le_bytes(),
        ],
        bump = listing.bump,
        constraint = listing.provider == provider.key() @ MarketplaceError::Unauthorized,
    )]
    pub listing: Account<'info, ServiceListing>,
}

#[derive(Accounts)]
pub struct CloseListing<'info> {
    pub provider: Signer<'info>,

    #[account(
        mut,
        seeds = [
            b"listing",
            provider.key().as_ref(),
            &listing.listing_id.to_le_bytes(),
        ],
        bump = listing.bump,
        constraint = listing.provider == provider.key() @ MarketplaceError::Unauthorized,
    )]
    pub listing: Account<'info, ServiceListing>,
}
```

**Step 4: Build**

```bash
anchor build
```

**Step 5: Add tests**

Append to `tests/webber-marketplace.ts`:

```typescript
it("Updates a listing (owner only)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, listingId);

    // Create listing first
    await marketplaceProgram.methods
      .createListing(
        { analysis: {} },
        new anchor.BN(10_000_000_000),
        new anchor.BN(0),
        "Analysis Service",
        "ipfs://old"
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    // Update price and URI
    await marketplaceProgram.methods
      .updateListing(
        new anchor.BN(15_000_000_000),  // new price
        null,  // keep subscription
        "ipfs://new",  // new URI
        null   // keep active status
      )
      .accounts({
        provider: wallet.publicKey,
        listing: listingPda,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listing.pricePerCall.toString(), "15000000000");
    assert.equal(listing.descriptionUri, "ipfs://new");

    console.log("✅ Listing updated successfully");
});

it("Closes a listing (soft delete)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, listingId);

    // Create listing
    await marketplaceProgram.methods
      .createListing(
        { routing: {} },
        new anchor.BN(3_000_000_000),
        new anchor.BN(0),
        "Routing Service",
        "ipfs://Qm..."
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    // Close it
    await marketplaceProgram.methods
      .closeListing()
      .accounts({
        provider: wallet.publicKey,
        listing: listingPda,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.isFalse(listing.isActive);

    console.log("✅ Listing closed (soft delete)");
});
```

**Step 6: Run tests**

```bash
anchor test
```

**Step 7: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs tests/webber-marketplace.ts
git commit -m "feat(marketplace): implement update_listing and close_listing instructions"
```

---

### Task 6: execute_payment Instruction (CPI to webber-token)

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Modify: `tests/webber-marketplace.ts`

This is the core instruction. It performs state updates BEFORE the CPI for reentrancy protection.

**Step 1: Implement execute_payment**

Add inside `pub mod webber_marketplace`:
```rust
pub fn execute_payment(ctx: Context<ExecutePayment>, amount: u64) -> Result<()> {
    let listing = &ctx.accounts.listing;
    require!(listing.is_active, MarketplaceError::ListingNotActive);

    // Validate provider agent is still active
    let provider_agent = &ctx.accounts.provider_agent;
    require!(
        provider_agent.unstake_requested_at.is_none(),
        MarketplaceError::AgentDeregistering
    );

    // Calculate burn amount using webber-token constants
    let burn_amount = amount
        .checked_mul(BURN_NUMERATOR)
        .ok_or(MarketplaceError::ArithmeticOverflow)?
        .checked_div(BURN_DENOMINATOR)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;

    let state = &mut ctx.accounts.marketplace_state;
    let tx_id = state.total_transactions;

    // --- STATE UPDATES BEFORE CPI (reentrancy protection) ---

    // Record transaction
    let transaction = &mut ctx.accounts.transaction;
    transaction.listing = ctx.accounts.listing.key();
    transaction.buyer = ctx.accounts.buyer.key();
    transaction.provider = listing.provider;
    transaction.amount_paid = amount;
    transaction.amount_burned = burn_amount;
    transaction.status = TransactionStatus::Completed;
    transaction.timestamp = Clock::get()?.unix_timestamp;
    transaction.bump = ctx.bumps.transaction;

    // Update listing stats
    let listing_mut = &mut ctx.accounts.listing;
    listing_mut.total_calls = listing_mut
        .total_calls
        .checked_add(1)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;

    // Update global stats
    state.total_transactions = tx_id
        .checked_add(1)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    state.total_volume = state
        .total_volume
        .checked_add(amount)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    state.total_burned = state
        .total_burned
        .checked_add(burn_amount)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;

    // --- CPI to webber-token for transfer with burn ---

    let cpi_accounts = webber_token::cpi::accounts::TransferWithBurn {
        authority: ctx.accounts.buyer.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.buyer_token_account.to_account_info(),
        to: ctx.accounts.provider_token_account.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.webber_token_program.to_account_info(),
        cpi_accounts,
    );
    webber_token::cpi::transfer_with_burn(cpi_ctx, amount)?;

    emit!(PaymentExecutedEvent {
        listing_id: listing_mut.listing_id,
        buyer: ctx.accounts.buyer.key(),
        provider: listing_mut.provider,
        amount_paid: amount,
        amount_burned: burn_amount,
        tx_id,
    });

    msg!(
        "Payment executed: {} $WEB, {} burned, tx_id={}",
        amount,
        burn_amount,
        tx_id
    );
    Ok(())
}
```

**Step 2: Add accounts struct**

```rust
#[derive(Accounts)]
pub struct ExecutePayment<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"marketplace_state"],
        bump = marketplace_state.bump,
    )]
    pub marketplace_state: Account<'info, MarketplaceState>,

    #[account(
        mut,
        constraint = listing.is_active @ MarketplaceError::ListingNotActive,
    )]
    pub listing: Account<'info, ServiceListing>,

    /// Provider's agent account (validates still registered)
    #[account(
        seeds = [b"agent", listing.provider.as_ref()],
        bump = provider_agent.bump,
        seeds::program = webber_registry::ID,
    )]
    pub provider_agent: Account<'info, webber_registry::AgentAccount>,

    #[account(
        init,
        payer = buyer,
        space = ServiceTransaction::MAX_SIZE,
        seeds = [
            b"transaction",
            listing.key().as_ref(),
            buyer.key().as_ref(),
            &marketplace_state.total_transactions.to_le_bytes(),
        ],
        bump,
    )]
    pub transaction: Account<'info, ServiceTransaction>,

    /// Buyer's $WEB token account
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// Provider's $WEB token account
    #[account(
        mut,
        token::mint = mint,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,

    /// $WEB token mint
    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// The webber-token program for CPI
    /// CHECK: Validated by address constraint
    #[account(address = webber_token::ID)]
    pub webber_token_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

**Step 3: Build**

```bash
anchor build
```

**Step 4: Add tests for execute_payment**

Append to `tests/webber-marketplace.ts`:

```typescript
it("Executes payment with 0.5% burn via CPI", async () => {
    // Create and register provider
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    // Create listing
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [providerAgentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },
        new anchor.BN(10_000_000_000),  // 10 $WEB
        new anchor.BN(0),
        "Search API",
        "ipfs://search"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: providerAgentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Create and fund buyer
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const paymentAmount = new anchor.BN(10_000_000_000);  // 10 $WEB
    const expectedBurn = new anchor.BN(50_000_000);  // 0.05 $WEB (0.5%)
    const expectedReceived = new anchor.BN(9_950_000_000);  // 9.95 $WEB

    // Get balances before
    const providerBalanceBefore = (
      await getAccount(provider.connection, providerAgent.tokenAccount)
    ).amount;
    const mintBefore = await getMint(provider.connection, mintKeypair.publicKey);

    // Get current tx count for transaction PDA
    const stateBeforePayment = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateBeforePayment.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(paymentAmount)
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: providerAgentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Verify provider received amount minus burn
    const providerBalanceAfter = (
      await getAccount(provider.connection, providerAgent.tokenAccount)
    ).amount;
    const providerIncrease = providerBalanceAfter - providerBalanceBefore;
    assert.equal(
      providerIncrease.toString(),
      expectedReceived.toString(),
      "Provider should receive 9.95 $WEB"
    );

    // Verify burn
    const mintAfter = await getMint(provider.connection, mintKeypair.publicKey);
    const supplyDecrease = mintBefore.supply - mintAfter.supply;
    assert.equal(
      supplyDecrease.toString(),
      expectedBurn.toString(),
      "0.05 $WEB should be burned"
    );

    // Verify transaction record
    const txRecord = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.equal(txRecord.amountPaid.toString(), paymentAmount.toString());
    assert.equal(txRecord.amountBurned.toString(), expectedBurn.toString());
    assert.equal(txRecord.buyer.toBase58(), buyer.wallet.publicKey.toBase58());
    assert.equal(txRecord.provider.toBase58(), providerAgent.wallet.publicKey.toBase58());

    // Verify global state updated
    const stateAfter = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(
      stateAfter.totalTransactions.toString(),
      (txId + 1).toString()
    );
    assert.isAbove(
      parseInt(stateAfter.totalVolume.toString()),
      0,
      "Total volume should increase"
    );
    assert.isAbove(
      parseInt(stateAfter.totalBurned.toString()),
      0,
      "Total burned should increase"
    );

    // Verify listing total_calls incremented
    const listingAfter = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listingAfter.totalCalls.toString(), "1");

    console.log("✅ Payment executed with 0.5% burn via CPI");
});

it("Rejects payment on inactive listing", async () => {
    // Create provider with listing, then close it
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { execution: {} },
        new anchor.BN(5_000_000_000),
        new anchor.BN(0),
        "Exec Service",
        "ipfs://exec"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Close it
    await marketplaceProgram.methods
      .closeListing()
      .accounts({
        provider: providerAgent.wallet.publicKey,
        listing: listingPda,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Try to pay
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    try {
      await marketplaceProgram.methods
        .executePayment(new anchor.BN(5_000_000_000))
        .accounts({
          buyer: buyer.wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
          transaction: transactionPda,
          buyerTokenAccount: buyer.tokenAccount,
          providerTokenAccount: providerAgent.tokenAccount,
          mint: mintKeypair.publicKey,
          webberTokenProgram: tokenProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer.wallet])
        .rpc();
      assert.fail("Should reject payment on inactive listing");
    } catch (err) {
      assert.include(err.toString(), "ListingNotActive");
    }

    console.log("✅ Payment on inactive listing correctly rejected");
});
```

**Step 5: Run tests**

```bash
anchor test
```

**Step 6: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs tests/webber-marketplace.ts
git commit -m "feat(marketplace): implement execute_payment with CPI to webber-token burn"
```

---

### Task 7: open_dispute Instruction

**Files:**
- Modify: `programs/webber-marketplace/src/lib.rs`
- Modify: `tests/webber-marketplace.ts`

**Step 1: Implement open_dispute**

Add inside `pub mod webber_marketplace`:
```rust
pub fn open_dispute(ctx: Context<OpenDispute>) -> Result<()> {
    let transaction = &mut ctx.accounts.transaction;

    require!(
        transaction.status == TransactionStatus::Completed,
        MarketplaceError::InvalidTransactionStatus
    );

    // Check 24-hour dispute window
    let current_time = Clock::get()?.unix_timestamp;
    let elapsed = current_time
        .checked_sub(transaction.timestamp)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    require!(elapsed < DISPUTE_WINDOW, MarketplaceError::DisputeWindowClosed);

    transaction.status = TransactionStatus::Disputed;

    emit!(DisputeOpenedEvent {
        tx_id: 0, // We don't store tx_id in transaction, use listing+buyer as identifier
        buyer: transaction.buyer,
        provider: transaction.provider,
    });

    msg!("Dispute opened by {}", ctx.accounts.buyer.key());
    Ok(())
}
```

Note: The `tx_id` in the event could be derived from the PDA seeds but isn't stored directly. For a cleaner approach, we can add a `tx_id` field to `ServiceTransaction`. Let me revise: add `pub tx_id: u64` to `ServiceTransaction`, update MAX_SIZE to 138 (add 8 bytes), set it during execute_payment, and emit it in the dispute event. Update MAX_SIZE:
```rust
/// 8 (disc) + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1 + 8 (tx_id) = 138
pub const MAX_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1 + 8;
```

**Step 2: Add accounts struct**

```rust
#[derive(Accounts)]
pub struct OpenDispute<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint = transaction.buyer == buyer.key() @ MarketplaceError::NotTransactionBuyer,
        constraint = transaction.status == TransactionStatus::Completed @ MarketplaceError::InvalidTransactionStatus,
    )]
    pub transaction: Account<'info, ServiceTransaction>,
}
```

**Step 3: Build**

```bash
anchor build
```

**Step 4: Add tests**

Append to `tests/webber-marketplace.ts`:

```typescript
it("Opens dispute within 24h window", async () => {
    // Setup: create provider, listing, buyer, execute payment
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { computation: {} },
        new anchor.BN(5_000_000_000),
        new anchor.BN(0),
        "Compute for Dispute",
        "ipfs://dispute-test"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(5_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Open dispute (within 24h since we just executed)
    await marketplaceProgram.methods
      .openDispute()
      .accounts({
        buyer: buyer.wallet.publicKey,
        transaction: transactionPda,
      })
      .signers([buyer.wallet])
      .rpc();

    const txRecord = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    // TransactionStatus::Disputed = 2
    assert.equal(JSON.stringify(txRecord.status), JSON.stringify({ disputed: {} }));

    console.log("✅ Dispute opened successfully within 24h window");
});

it("Rejects dispute from non-buyer", async () => {
    // Reuse an existing transaction or create a new one
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { analysis: {} },
        new anchor.BN(8_000_000_000),
        new anchor.BN(0),
        "Analysis Dispute Test",
        "ipfs://dispute2"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(8_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Try to dispute as provider (not buyer)
    try {
      await marketplaceProgram.methods
        .openDispute()
        .accounts({
          buyer: providerAgent.wallet.publicKey,
          transaction: transactionPda,
        })
        .signers([providerAgent.wallet])
        .rpc();
      assert.fail("Should reject dispute from non-buyer");
    } catch (err) {
      assert.include(err.toString(), "NotTransactionBuyer");
    }

    console.log("✅ Non-buyer dispute correctly rejected");
});
```

**Step 5: Run tests**

```bash
anchor test
```

**Step 6: Commit**

```bash
git add programs/webber-marketplace/src/lib.rs tests/webber-marketplace.ts
git commit -m "feat(marketplace): implement open_dispute with 24h window validation"
```

---

### Task 8: Integration Test + Vet Checklist + Final Push

**Files:**
- Modify: `tests/webber-marketplace.ts` (or create `tests/marketplace-integration.ts`)
- Modify: `tasks/todo.md`

**Step 1: Add full-flow integration test**

Add to `tests/webber-marketplace.ts`:

```typescript
it("Full flow: register → list → pay → verify burn → dispute", async () => {
    // 1. Register provider agent
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    // 2. Create listing
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },
        new anchor.BN(20_000_000_000),  // 20 $WEB
        new anchor.BN(0),
        "Integration Test Service",
        "ipfs://integration"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // 3. Register buyer and pay
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);
    const mintBefore = await getMint(provider.connection, mintKeypair.publicKey);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(20_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // 4. Verify burn
    const mintAfter = await getMint(provider.connection, mintKeypair.publicKey);
    const burned = mintBefore.supply - mintAfter.supply;
    assert.equal(burned.toString(), "100000000", "0.1 $WEB should be burned (0.5% of 20)");

    // 5. Verify transaction
    const tx = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.equal(tx.amountPaid.toString(), "20000000000");
    assert.equal(tx.amountBurned.toString(), "100000000");

    // 6. Open dispute
    await marketplaceProgram.methods
      .openDispute()
      .accounts({
        buyer: buyer.wallet.publicKey,
        transaction: transactionPda,
      })
      .signers([buyer.wallet])
      .rpc();

    const txAfterDispute = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.equal(JSON.stringify(txAfterDispute.status), JSON.stringify({ disputed: {} }));

    console.log("✅ Full integration flow: register → list → pay → burn → dispute");
});
```

**Step 2: Run full test suite**

```bash
source /Users/mahomedayob/WEBBER/.env.sh
cd /Users/mahomedayob/WEBBER/webber-protocol
anchor test
```
Expected: ALL tests pass — marketplace + token + registry + demo.

**Step 3: Run vet checklist**

Manually verify each item:
- [ ] `anchor build` passes with zero warnings (deprecation warnings from Anchor 0.31.1 are acceptable)
- [ ] `anchor test` passes 100%
- [ ] State updates happen before CPI in execute_payment
- [ ] All arithmetic uses checked operations
- [ ] All account owner/signer checks present
- [ ] Global state PDA increments correctly
- [ ] Reentrancy protection verified (state before CPI)

**Step 4: Update tasks/todo.md**

Write completion summary for Build 1.

**Step 5: Final commit and push**

```bash
git add -A
git commit -m "feat(marketplace): Phase 2 Build 1 complete — capability marketplace with atomic payments"
git push -u origin build/marketplace
```

**Step 6: Merge to develop**

```bash
git checkout develop
git merge build/marketplace
git push origin develop
```
