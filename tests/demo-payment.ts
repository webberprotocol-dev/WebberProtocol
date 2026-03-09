/**
 * Webber Protocol — Integration Test: Full Payment Demo
 *
 * This test runs the complete protocol flow as a Mocha test:
 * 1. Initialize $WEB token
 * 2. Create and fund two agents (Alice and Bob)
 * 3. Register both on the registry with 100 $WEB stake
 * 4. Alice pays Bob 10 $WEB through transfer_with_burn
 * 5. Verify 0.5% burn and correct balances
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberToken } from "../target/types/webber_token";
import { WebberRegistry } from "../target/types/webber_registry";
import {
  Keypair,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("demo-payment (integration)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const payer = provider.wallet as anchor.Wallet;

  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  let aliceAta: PublicKey;
  let bobAta: PublicKey;

  it("Full protocol flow: init → register → pay → burn verified", async () => {
    // 1. Initialize $WEB token
    await tokenProgram.methods
      .initializeMint()
      .accounts({
        payer: payer.publicKey,
        mint: mintKeypair.publicKey,
        mintAuthority,
        treasury: treasuryKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair, treasuryKeypair])
      .rpc();

    console.log("  → $WEB token initialized (1B supply, 9 decimals)");

    // 2. Create and fund agents
    for (const wallet of [alice, bob]) {
      const sig = await provider.connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    aliceAta = await createAssociatedTokenAccount(provider.connection, payer.payer, mintKeypair.publicKey, alice.publicKey);
    bobAta = await createAssociatedTokenAccount(provider.connection, payer.payer, mintKeypair.publicKey, bob.publicKey);

    // Fund Alice with 300 $WEB, Bob with 200 $WEB
    await tokenProgram.methods.transferWithBurn(new anchor.BN("300000000000")).accounts({
      authority: payer.publicKey, mint: mintKeypair.publicKey, from: treasuryKeypair.publicKey, to: aliceAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

    await tokenProgram.methods.transferWithBurn(new anchor.BN("200000000000")).accounts({
      authority: payer.publicKey, mint: mintKeypair.publicKey, from: treasuryKeypair.publicKey, to: bobAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

    console.log("  → Agents funded (Alice: ~298.5 $WEB, Bob: ~199 $WEB after burn)");

    // 3. Register both agents
    const stakeAmount = new anchor.BN("100000000000");

    const [aliceAgent] = PublicKey.findProgramAddressSync([Buffer.from("agent"), alice.publicKey.toBuffer()], registryProgram.programId);
    const [aliceVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), alice.publicKey.toBuffer()], registryProgram.programId);
    const [bobAgent] = PublicKey.findProgramAddressSync([Buffer.from("agent"), bob.publicKey.toBuffer()], registryProgram.programId);
    const [bobVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), bob.publicKey.toBuffer()], registryProgram.programId);

    await registryProgram.methods.registerAgent(stakeAmount, ["data_retrieval", "computation"]).accounts({
      owner: alice.publicKey, agentAccount: aliceAgent, agentTokenAccount: aliceAta, vault: aliceVault,
      mint: mintKeypair.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).signers([alice]).rpc();

    await registryProgram.methods.registerAgent(stakeAmount, ["execution", "analysis"]).accounts({
      owner: bob.publicKey, agentAccount: bobAgent, agentTokenAccount: bobAta, vault: bobVault,
      mint: mintKeypair.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).signers([bob]).rpc();

    console.log("  → Both agents registered (100 $WEB stake each)");

    // 4. Alice pays Bob 10 $WEB
    const paymentAmount = new anchor.BN("10000000000"); // 10 $WEB
    const supplyBefore = (await getMint(provider.connection, mintKeypair.publicKey)).supply;
    const bobBalBefore = (await getAccount(provider.connection, bobAta)).amount;

    await tokenProgram.methods.transferWithBurn(paymentAmount).accounts({
      authority: alice.publicKey, mint: mintKeypair.publicKey, from: aliceAta, to: bobAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([alice]).rpc();

    const supplyAfter = (await getMint(provider.connection, mintKeypair.publicKey)).supply;
    const bobBalAfter = (await getAccount(provider.connection, bobAta)).amount;

    const burned = supplyBefore - supplyAfter;
    const bobReceived = bobBalAfter - bobBalBefore;

    // 5. Verify
    assert.equal(bobReceived.toString(), "9950000000", "Bob should receive 9.95 $WEB");
    assert.equal(burned.toString(), "50000000", "0.05 $WEB should be burned");

    console.log(`  → Payment: Alice sent 10 $WEB, Bob received ${Number(bobReceived) / 1e9} $WEB, ${Number(burned) / 1e9} $WEB burned`);
    console.log("  ✅ Full demo passed: agents registered, payment executed, burn confirmed");
  });
});
