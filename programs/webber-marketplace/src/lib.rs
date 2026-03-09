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
