use anchor_lang::prelude::*;

declare_id!("Cv7jws8s9MZ1rFZw8jwLxcezmmb77t4RyybjZovpJ4P");

#[program]
pub mod webber_registry {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
