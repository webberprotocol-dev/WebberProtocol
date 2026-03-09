use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("HWQmKMXyhr2mbtE5zG1iyHnPReBpm7xSiWaaujfdWoyq");

/// Total supply: 1 billion $WEB tokens with 9 decimals
pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000_000; // 1B * 10^9
pub const DECIMALS: u8 = 9;

/// Burn rate: 0.5% = 5 / 1000
pub const BURN_NUMERATOR: u64 = 5;
pub const BURN_DENOMINATOR: u64 = 1000;

#[program]
pub mod webber_token {
    use super::*;

    /// Initialize the $WEB token mint and mint the total supply to a treasury account.
    /// The mint authority is a PDA so only this program can mint.
    pub fn initialize_mint(ctx: Context<InitializeMint>) -> Result<()> {
        // Mint the full supply to the treasury token account
        let seeds = &[b"mint_authority".as_ref(), &[ctx.bumps.mint_authority]];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer_seeds,
            ),
            TOTAL_SUPPLY,
        )?;

        msg!("$WEB token initialized. Supply: {} (raw), Decimals: {}", TOTAL_SUPPLY, DECIMALS);
        Ok(())
    }

    /// Transfer $WEB tokens with a 0.5% burn on every transfer.
    /// burn_amount = transfer_amount * 5 / 1000
    /// recipient receives: transfer_amount - burn_amount
    pub fn transfer_with_burn(ctx: Context<TransferWithBurn>, amount: u64) -> Result<()> {
        require!(amount > 0, WebberTokenError::ZeroTransferAmount);

        // Calculate burn: 0.5% of transfer amount using checked arithmetic
        let burn_amount = amount
            .checked_mul(BURN_NUMERATOR)
            .ok_or(WebberTokenError::ArithmeticOverflow)?
            .checked_div(BURN_DENOMINATOR)
            .ok_or(WebberTokenError::ArithmeticOverflow)?;

        let transfer_amount = amount
            .checked_sub(burn_amount)
            .ok_or(WebberTokenError::ArithmeticOverflow)?;

        // Transfer the net amount to recipient
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            transfer_amount,
        )?;

        // Burn the burn amount from sender's account
        if burn_amount > 0 {
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.from.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                burn_amount,
            )?;
        }

        msg!(
            "Transfer: {} total, {} burned (0.5%), {} received",
            amount,
            burn_amount,
            transfer_amount
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The $WEB token mint. Created externally, authority set to mint_authority PDA.
    #[account(
        init,
        payer = payer,
        mint::decimals = DECIMALS,
        mint::authority = mint_authority,
    )]
    pub mint: Account<'info, Mint>,

    /// PDA that serves as mint authority. Seeds: ["mint_authority"]
    /// CHECK: This is a PDA used as the mint authority, validated by seeds constraint.
    #[account(
        seeds = [b"mint_authority"],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// Treasury token account to receive the initial supply
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = payer,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TransferWithBurn<'info> {
    /// The sender's authority (signer)
    pub authority: Signer<'info>,

    /// The $WEB token mint (needed for burn instruction)
    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// Sender's token account
    #[account(
        mut,
        token::mint = mint,
        token::authority = authority,
    )]
    pub from: Account<'info, TokenAccount>,

    /// Recipient's token account
    #[account(
        mut,
        token::mint = mint,
    )]
    pub to: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum WebberTokenError {
    #[msg("Transfer amount must be greater than zero")]
    ZeroTransferAmount,
    #[msg("Arithmetic overflow during burn calculation")]
    ArithmeticOverflow,
}
