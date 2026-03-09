use anchor_lang::prelude::*;

declare_id!("ADyVkB2FPJmPyh4vzYksH22r6XTyKJbBbiXWGvjrzBxF");

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
