use anchor_lang::prelude::*;

declare_id!("suuVRKXTdyzBbsSJFvdd1io8gXVcUfyUf9Eno4Uzc4G");

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

/// Marketplace program ID (hardcoded to avoid circular Cargo dependency)
pub const MARKETPLACE_PROGRAM_ID: Pubkey = pubkey!("Fzm6CBQXa1vDDXXCp89T15pec82nRmEXe1rt8kXtPbDn");

#[program]
pub mod webber_reputation {
    use super::*;

    /// Initialize a reputation ledger for a registered agent.
    /// Called by the agent owner alongside registration.
    pub fn init_reputation_ledger(ctx: Context<InitReputationLedger>) -> Result<()> {
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

    /// Update an agent's reputation after a completed transaction.
    /// Called by webber-marketplace via CPI after execute_payment,
    /// or directly with valid marketplace_state for testing.
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

        // --- CPI to webber-registry to update agent score and tier ---
        let seeds = &[
            b"reputation_authority".as_ref(),
            &[ctx.bumps.reputation_authority],
        ];
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
            agent: ledger.agent,
            old_score,
            new_score,
            new_tier,
        });

        msg!(
            "Reputation updated: score {} -> {}, tier {}",
            old_score,
            new_score,
            new_tier
        );
        Ok(())
    }

    /// Record a dispute against an agent. Increments dispute counter
    /// and recalculates score (penalty applied).
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

        // CPI to registry
        let seeds = &[
            b"reputation_authority".as_ref(),
            &[ctx.bumps.reputation_authority],
        ];
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

        msg!(
            "Dispute recorded: agent={}, disputes={}, score={}",
            ledger.agent,
            ledger.disputes_opened_against,
            new_score
        );
        Ok(())
    }

    /// Resolve a dispute. If in agent's favour, increments clean counter
    /// and adds recovery points.
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

        // CPI to registry
        let seeds = &[
            b"reputation_authority".as_ref(),
            &[ctx.bumps.reputation_authority],
        ];
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

        msg!(
            "Dispute resolved: in_favour={}, score={}",
            in_agent_favour,
            new_score
        );
        Ok(())
    }
}

// -- Account Contexts --

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

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    /// The caller (buyer in CPI, or test signer)
    pub caller: Signer<'info>,

    /// Validates the marketplace is deployed and initialized
    /// CHECK: Validated by seeds::program constraint
    #[account(
        seeds = [b"marketplace_state"],
        bump,
        seeds::program = MARKETPLACE_PROGRAM_ID,
    )]
    pub marketplace_state: AccountInfo<'info>,

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

    /// CHECK: Validated by address
    #[account(address = webber_registry::ID)]
    pub registry_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RecordDispute<'info> {
    /// The caller initiating the dispute record
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

    /// CHECK: Validated by address
    #[account(address = webber_registry::ID)]
    pub registry_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// The caller resolving the dispute
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

    /// CHECK: Validated by address
    #[account(address = webber_registry::ID)]
    pub registry_program: AccountInfo<'info>,
}

// -- Account Struct --

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

// -- Error Codes --

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
