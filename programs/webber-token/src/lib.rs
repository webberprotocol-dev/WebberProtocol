use anchor_lang::prelude::*;

declare_id!("HWQmKMXyhr2mbtE5zG1iyHnPReBpm7xSiWaaujfdWoyq");

#[program]
pub mod webber_token {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
