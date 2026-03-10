use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Cv7jws8s9MZ1rFZw8jwLxcezmmb77t4RyybjZovpJ4P");

/// Minimum stake to register an agent: 100 $WEB (with 9 decimals)
pub const MIN_STAKE: u64 = 100_000_000_000;

/// Unstake cooldown period: 7 days in seconds
pub const UNSTAKE_COOLDOWN: i64 = 7 * 24 * 60 * 60;

/// Maximum number of capabilities an agent can declare
pub const MAX_CAPABILITIES: usize = 10;

/// Maximum length of a single capability string
pub const MAX_CAPABILITY_LEN: usize = 64;

#[program]
pub mod webber_registry {
    use super::*;

    /// Register a new agent on the Webber network.
    /// Requires staking at least 100 $WEB tokens.
    /// Creates a PDA account derived from the owner's public key.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        stake_amount: u64,
        capabilities: Vec<String>,
    ) -> Result<()> {
        require!(stake_amount >= MIN_STAKE, RegistryError::InsufficientStake);
        require!(
            capabilities.len() <= MAX_CAPABILITIES,
            RegistryError::TooManyCapabilities
        );
        for cap in &capabilities {
            require!(
                cap.len() <= MAX_CAPABILITY_LEN,
                RegistryError::CapabilityTooLong
            );
        }

        // Transfer stake from agent to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.agent_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        // Initialize agent account
        let agent = &mut ctx.accounts.agent_account;
        agent.owner = ctx.accounts.owner.key();
        agent.capabilities = capabilities;
        agent.stake_amount = stake_amount;
        agent.reputation_score = 0;
        agent.tier = 1;
        agent.registered_at = Clock::get()?.unix_timestamp;
        agent.unstake_requested_at = None;
        agent.bump = ctx.bumps.agent_account;

        msg!(
            "Agent registered: {}, stake: {} $WEB",
            agent.owner,
            stake_amount
        );
        Ok(())
    }

    /// Update an agent's capability declarations.
    /// Only the owner can update capabilities.
    pub fn update_capabilities(
        ctx: Context<UpdateCapabilities>,
        capabilities: Vec<String>,
    ) -> Result<()> {
        require!(
            capabilities.len() <= MAX_CAPABILITIES,
            RegistryError::TooManyCapabilities
        );
        for cap in &capabilities {
            require!(
                cap.len() <= MAX_CAPABILITY_LEN,
                RegistryError::CapabilityTooLong
            );
        }

        let agent = &mut ctx.accounts.agent_account;
        agent.capabilities = capabilities.clone();

        msg!("Agent capabilities updated: {} capabilities", capabilities.len());
        Ok(())
    }

    /// Initiate agent deregistration with a 7-day cooldown.
    /// Sets the unstake_requested_at timestamp.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        let agent = &mut ctx.accounts.agent_account;
        require!(
            agent.unstake_requested_at.is_none(),
            RegistryError::DeregistrationAlreadyRequested
        );

        agent.unstake_requested_at = Some(Clock::get()?.unix_timestamp);

        msg!(
            "Deregistration initiated for agent: {}. Cooldown: 7 days.",
            agent.owner
        );
        Ok(())
    }

    /// Claim unstaked tokens after the 7-day cooldown expires.
    /// Returns stake to the owner and closes the agent PDA.
    pub fn claim_unstake(ctx: Context<ClaimUnstake>) -> Result<()> {
        let agent = &ctx.accounts.agent_account;

        let unstake_time = agent
            .unstake_requested_at
            .ok_or(RegistryError::DeregistrationNotRequested)?;

        let current_time = Clock::get()?.unix_timestamp;
        let elapsed = current_time
            .checked_sub(unstake_time)
            .ok_or(RegistryError::ArithmeticOverflow)?;

        require!(elapsed >= UNSTAKE_COOLDOWN, RegistryError::CooldownNotExpired);

        // Transfer stake back from vault to owner
        let owner_key = ctx.accounts.owner.key();
        let vault_seeds = &[
            b"vault".as_ref(),
            owner_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.agent_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            agent.stake_amount,
        )?;

        msg!(
            "Stake claimed: {} $WEB returned to {}",
            agent.stake_amount,
            agent.owner
        );
        // Agent account will be closed by the close constraint
        Ok(())
    }

    /// Update an agent's reputation score and tier.
    /// Only callable by the reputation program's PDA signer.
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
}

/// Agent account stored as a PDA. Seeds: ["agent", owner_pubkey]
#[account]
pub struct AgentAccount {
    /// The owner (operator) of this agent
    pub owner: Pubkey,
    /// What this agent can do (e.g., "data_retrieval", "computation")
    pub capabilities: Vec<String>,
    /// Amount of $WEB staked
    pub stake_amount: u64,
    /// Reputation score (incremented by successful transactions)
    pub reputation_score: u64,
    /// Reputation tier (1-4), derived from score thresholds
    pub tier: u8,
    /// Unix timestamp when the agent was registered
    pub registered_at: i64,
    /// Unix timestamp when deregistration was requested (None if active)
    pub unstake_requested_at: Option<i64>,
    /// PDA bump seed
    pub bump: u8,
}

impl AgentAccount {
    /// Calculate space needed for the account.
    /// Fixed fields: 32 (owner) + 8 (stake) + 8 (rep) + 1 (tier) + 8 (registered_at) + 1+8 (option<i64>) + 1 (bump) + 8 (discriminator) = 75
    /// Vec<String>: 4 (vec len) + MAX_CAPABILITIES * (4 + MAX_CAPABILITY_LEN) = 4 + 10 * 68 = 684
    /// Total: 75 + 684 = 759
    pub const MAX_SIZE: usize = 8 + 32 + (4 + MAX_CAPABILITIES * (4 + MAX_CAPABILITY_LEN)) + 8 + 8 + 1 + 8 + (1 + 8) + 1;
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The agent PDA account, derived from owner pubkey
    #[account(
        init,
        payer = owner,
        space = AgentAccount::MAX_SIZE,
        seeds = [b"agent", owner.key().as_ref()],
        bump,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    /// The owner's $WEB token account (source of stake)
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    /// Vault PDA to hold staked tokens. Seeds: ["vault", owner_pubkey]
    #[account(
        init,
        payer = owner,
        token::mint = mint,
        token::authority = vault,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The $WEB token mint
    /// CHECK: We only need the mint address for token account validation
    pub mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateCapabilities<'info> {
    /// Must be the agent's owner
    pub owner: Signer<'info>,

    /// The agent PDA, validated by seeds and owner check
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent_account.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    /// Must be the agent's owner
    pub owner: Signer<'info>,

    /// The agent PDA
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent_account.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

#[derive(Accounts)]
pub struct ClaimUnstake<'info> {
    /// Must be the agent's owner
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The agent PDA — will be closed after claiming
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent_account.bump,
        has_one = owner @ RegistryError::Unauthorized,
        close = owner,
    )]
    pub agent_account: Account<'info, AgentAccount>,

    /// The owner's $WEB token account (destination for returned stake)
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    /// Vault PDA holding the staked tokens
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The $WEB token mint
    /// CHECK: We only need the mint address for token account validation
    pub mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateAgentReputation<'info> {
    /// The reputation program's authority PDA — must be a signer
    pub reputation_authority: Signer<'info>,

    /// The agent account to update
    #[account(
        mut,
        seeds = [b"agent", agent_account.owner.as_ref()],
        bump = agent_account.bump,
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

#[error_code]
pub enum RegistryError {
    #[msg("Insufficient stake: minimum 100 $WEB required")]
    InsufficientStake,
    #[msg("Only the agent owner can perform this action")]
    Unauthorized,
    #[msg("Too many capabilities: maximum 10 allowed")]
    TooManyCapabilities,
    #[msg("Capability string too long: maximum 64 characters")]
    CapabilityTooLong,
    #[msg("Deregistration already requested")]
    DeregistrationAlreadyRequested,
    #[msg("Deregistration not requested — call deregister_agent first")]
    DeregistrationNotRequested,
    #[msg("7-day cooldown period has not expired")]
    CooldownNotExpired,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid tier value: must be 1-4")]
    InvalidTier,
}
