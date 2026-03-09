use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use webber_token::{BURN_NUMERATOR, BURN_DENOMINATOR};

declare_id!("Fzm6CBQXa1vDDXXCp89T15pec82nRmEXe1rt8kXtPbDn");

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

/// Max title length
pub const MAX_TITLE_LEN: usize = 64;
/// Max description URI length
pub const MAX_DESC_URI_LEN: usize = 128;
/// 24-hour dispute window in seconds
pub const DISPUTE_WINDOW: i64 = 24 * 60 * 60;

#[program]
pub mod webber_marketplace {
    use super::*;

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

    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        let listing = &mut ctx.accounts.listing;
        listing.is_active = false;

        emit!(CloseListingEvent {
            listing_id: listing.listing_id,
        });

        msg!("Listing {} closed", listing.listing_id);
        Ok(())
    }

    /// Execute a payment from buyer to provider through the protocol.
    /// Burns 0.5% via CPI to webber-token. State updates before CPI for reentrancy protection.
    pub fn execute_payment(ctx: Context<ExecutePayment>, amount: u64) -> Result<()> {
        let listing = &ctx.accounts.listing;
        require!(listing.is_active, MarketplaceError::ListingNotActive);

        // Validate provider agent is still active
        let provider_agent = &ctx.accounts.provider_agent;
        require!(
            provider_agent.unstake_requested_at.is_none(),
            MarketplaceError::AgentDeregistering
        );

        // Calculate burn amount using webber-token constants (checked arithmetic)
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
        transaction.tx_id = tx_id;
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

    /// Open a dispute on a completed transaction within the 24-hour window.
    /// Only the buyer can open a dispute.
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
            tx_id: transaction.tx_id,
            buyer: transaction.buyer,
            provider: transaction.provider,
        });

        msg!("Dispute opened on tx_id={} by {}", transaction.tx_id, ctx.accounts.buyer.key());
        Ok(())
    }
}

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
    pub tx_id: u64,
    pub bump: u8,
}

impl ServiceTransaction {
    /// 8 (disc) + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1 = 138
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1;
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
