use anchor_lang::prelude::*;

declare_id!("ADyVkB2FPJmPyh4vzYksH22r6XTyKJbBbiXWGvjrzBxF");

/// Score formula constants
pub const BASE_SCORE_PER_TX: u64 = 10;
pub const BASE_SCORE_CAP: u64 = 5000;
pub const VOLUME_DIVISOR: u64 = 1_000_000;
pub const VOLUME_BONUS_CAP: u64 = 3000;
pub const DISPUTE_PENALTY: u64 = 150;
pub const DISPUTE_RECOVERY: u64 = 75;
pub const MAX_SCORE: u32 = 10000;

/// Tier thresholds
pub const TIER_2_THRESHOLD: u32 = 1000;
pub const TIER_3_THRESHOLD: u32 = 4000;
pub const TIER_4_THRESHOLD: u32 = 8000;

/// Marketplace program ID (hardcoded to avoid circular dep)
pub const MARKETPLACE_PROGRAM_ID: Pubkey = pubkey!("Fzm6CBQXa1vDDXXCp89T15pec82nRmEXe1rt8kXtPbDn");

#[program]
pub mod webber_reputation {
    use super::*;

    /// Placeholder — instructions added in subsequent tasks
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        msg!("webber-reputation scaffold");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

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

/// Calculate reputation score from ledger fields.
/// Returns (score, tier).
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
    // Note: VOLUME_DIVISOR is 1_000_000 in raw token units
    let volume_raw = total_volume / VOLUME_DIVISOR;
    let volume_bonus = std::cmp::min(volume_raw, VOLUME_BONUS_CAP);

    // Positive subtotal
    let positive = base
        .checked_add(volume_bonus)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Dispute penalty: disputes * 150
    let penalty = (disputes_opened as u64)
        .checked_mul(DISPUTE_PENALTY)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Dispute recovery: clean * 75
    let recovery = (disputes_clean as u64)
        .checked_mul(DISPUTE_RECOVERY)
        .ok_or(ReputationError::ArithmeticOverflow)?;

    // Final: positive - penalty + recovery, clamped to [0, MAX_SCORE]
    let after_penalty = positive.saturating_sub(penalty);
    let final_u64 = after_penalty
        .checked_add(recovery)
        .ok_or(ReputationError::ArithmeticOverflow)?;
    let score = std::cmp::min(final_u64, MAX_SCORE as u64) as u32;

    // Derive tier
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
