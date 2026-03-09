import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberToken } from "../target/types/webber_token";
import {
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("webber-token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.WebberToken as Program<WebberToken>;
  const payer = provider.wallet as anchor.Wallet;

  // Keypairs for mint and treasury
  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();

  // Derived PDA for mint authority
  const [mintAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    program.programId
  );

  const TOTAL_SUPPLY = new anchor.BN("1000000000000000000"); // 1B * 10^9
  const DECIMALS = 9;

  it("Initializes the $WEB token with 1B supply", async () => {
    const tx = await program.methods
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

    console.log("Initialize mint tx:", tx);

    // Verify mint
    const mintAccount = await getMint(provider.connection, mintKeypair.publicKey);
    assert.equal(mintAccount.decimals, DECIMALS, "Decimals should be 9");
    assert.equal(
      mintAccount.supply.toString(),
      TOTAL_SUPPLY.toString(),
      "Total supply should be 1B * 10^9"
    );

    // Verify mint authority is the PDA
    assert.equal(
      mintAccount.mintAuthority.toBase58(),
      mintAuthority.toBase58(),
      "Mint authority should be the PDA"
    );

    // Verify treasury balance
    const treasuryAccount = await getAccount(
      provider.connection,
      treasuryKeypair.publicKey
    );
    assert.equal(
      treasuryAccount.amount.toString(),
      TOTAL_SUPPLY.toString(),
      "Treasury should hold entire supply"
    );

    console.log("✅ $WEB token initialized: 1B supply, 9 decimals");
  });

  it("Burns 0.5% on transfer (10 WEB → 9.95 WEB received, 0.05 burned)", async () => {
    // Create recipient wallet
    const recipient = Keypair.generate();

    // Create associated token account for recipient
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      recipient.publicKey
    );

    // Transfer 10 $WEB (10 * 10^9 = 10_000_000_000) from treasury (payer) to recipient
    const transferAmount = new anchor.BN(10_000_000_000); // 10 $WEB
    const expectedBurn = new anchor.BN(50_000_000); // 0.05 $WEB (0.5%)
    const expectedReceived = new anchor.BN(9_950_000_000); // 9.95 $WEB

    // Get supply before transfer
    const mintBefore = await getMint(provider.connection, mintKeypair.publicKey);
    const supplyBefore = mintBefore.supply;

    const tx = await program.methods
      .transferWithBurn(transferAmount)
      .accounts({
        authority: payer.publicKey,
        mint: mintKeypair.publicKey,
        from: treasuryKeypair.publicKey,
        to: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Transfer with burn tx:", tx);

    // Verify recipient received 9.95 $WEB
    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(
      recipientAccount.amount.toString(),
      expectedReceived.toString(),
      "Recipient should receive 9.95 $WEB"
    );

    // Verify total supply decreased by burn amount
    const mintAfter = await getMint(provider.connection, mintKeypair.publicKey);
    const supplyDecrease = supplyBefore - mintAfter.supply;
    assert.equal(
      supplyDecrease.toString(),
      expectedBurn.toString(),
      "Total supply should decrease by 0.05 $WEB"
    );

    console.log("✅ Burn verified: 0.05 $WEB burned, 9.95 $WEB received");
  });

  it("Rejects zero transfer amount", async () => {
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      recipient.publicKey
    );

    try {
      await program.methods
        .transferWithBurn(new anchor.BN(0))
        .accounts({
          authority: payer.publicKey,
          mint: mintKeypair.publicKey,
          from: treasuryKeypair.publicKey,
          to: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have thrown ZeroTransferAmount error");
    } catch (err) {
      assert.include(
        err.toString(),
        "ZeroTransferAmount",
        "Error should be ZeroTransferAmount"
      );
    }

    console.log("✅ Zero transfer correctly rejected");
  });

  it("Handles transfer of 1 token (minimum — burn rounds to 0)", async () => {
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      recipient.publicKey
    );

    // Transfer 1 raw token — burn = 1 * 5 / 1000 = 0 (integer division)
    const tx = await program.methods
      .transferWithBurn(new anchor.BN(1))
      .accounts({
        authority: payer.publicKey,
        mint: mintKeypair.publicKey,
        from: treasuryKeypair.publicKey,
        to: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(
      recipientAccount.amount.toString(),
      "1",
      "Recipient should receive 1 token (no burn for tiny amount)"
    );

    console.log("✅ Minimum transfer handled correctly (burn rounds to 0)");
  });

  it("Handles large transfer without overflow", async () => {
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      recipient.publicKey
    );

    // Transfer 500M $WEB (500_000_000 * 10^9)
    const largeAmount = new anchor.BN("500000000000000000");
    const expectedBurn = new anchor.BN("2500000000000000"); // 0.5% of 500M
    const expectedReceived = new anchor.BN("497500000000000000");

    const tx = await program.methods
      .transferWithBurn(largeAmount)
      .accounts({
        authority: payer.publicKey,
        mint: mintKeypair.publicKey,
        from: treasuryKeypair.publicKey,
        to: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    assert.equal(
      recipientAccount.amount.toString(),
      expectedReceived.toString(),
      "Recipient should receive 497.5M $WEB"
    );

    console.log("✅ Large transfer (500M $WEB) handled without overflow");
  });
});
