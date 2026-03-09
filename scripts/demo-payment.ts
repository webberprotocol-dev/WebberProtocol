/**
 * Webber Protocol — Payment Demo
 *
 * Demonstrates the core protocol flow:
 * 1. Initialize $WEB token with 1B supply
 * 2. Create two agent wallets (Alice and Bob)
 * 3. Register both agents on the registry (100 $WEB stake each)
 * 4. Alice sends 10 $WEB to Bob through the protocol
 * 5. Confirm 0.5% burn (Bob receives 9.95 $WEB)
 * 6. Log all transaction signatures and account states
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

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  WEBBER PROTOCOL — Agent Payment Demo");
  console.log("═══════════════════════════════════════════════════════\n");

  // Setup provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const payer = provider.wallet as anchor.Wallet;

  // ─── Step 1: Initialize $WEB Token ─────────────────────────────
  console.log("Step 1: Initializing $WEB Token...");

  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  const initTx = await tokenProgram.methods
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

  const mintInfo = await getMint(provider.connection, mintKeypair.publicKey);
  console.log(`  ✓ Mint: ${mintKeypair.publicKey.toBase58()}`);
  console.log(`  ✓ Supply: ${Number(mintInfo.supply) / 1e9} $WEB`);
  console.log(`  ✓ Decimals: ${mintInfo.decimals}`);
  console.log(`  ✓ Tx: ${initTx}\n`);

  // ─── Step 2: Create Agent Wallets ──────────────────────────────
  console.log("Step 2: Creating agent wallets (Alice & Bob)...");

  const alice = Keypair.generate();
  const bob = Keypair.generate();

  // Fund with SOL for tx fees
  for (const [name, wallet] of [["Alice", alice], ["Bob", bob]] as const) {
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
    console.log(`  ✓ ${name}: ${wallet.publicKey.toBase58()}`);
  }

  // Create ATAs
  const aliceAta = await createAssociatedTokenAccount(
    provider.connection,
    payer.payer,
    mintKeypair.publicKey,
    alice.publicKey
  );
  const bobAta = await createAssociatedTokenAccount(
    provider.connection,
    payer.payer,
    mintKeypair.publicKey,
    bob.publicKey
  );

  // Fund Alice with 300 $WEB from treasury (enough for staking + transfer)
  const fundAmount = new anchor.BN("300000000000"); // 300 $WEB
  await tokenProgram.methods
    .transferWithBurn(fundAmount)
    .accounts({
      authority: payer.publicKey,
      mint: mintKeypair.publicKey,
      from: treasuryKeypair.publicKey,
      to: aliceAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // Fund Bob with 200 $WEB for staking
  const bobFund = new anchor.BN("200000000000"); // 200 $WEB
  await tokenProgram.methods
    .transferWithBurn(bobFund)
    .accounts({
      authority: payer.publicKey,
      mint: mintKeypair.publicKey,
      from: treasuryKeypair.publicKey,
      to: bobAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const aliceBalance = (await getAccount(provider.connection, aliceAta)).amount;
  const bobBalance = (await getAccount(provider.connection, bobAta)).amount;
  console.log(`  ✓ Alice balance: ${Number(aliceBalance) / 1e9} $WEB`);
  console.log(`  ✓ Bob balance: ${Number(bobBalance) / 1e9} $WEB\n`);

  // ─── Step 3: Register Both Agents ─────────────────────────────
  console.log("Step 3: Registering agents on Webber registry...");

  const stakeAmount = new anchor.BN("100000000000"); // 100 $WEB

  // Register Alice
  const [aliceAgent] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), alice.publicKey.toBuffer()],
    registryProgram.programId
  );
  const [aliceVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), alice.publicKey.toBuffer()],
    registryProgram.programId
  );

  const aliceRegTx = await registryProgram.methods
    .registerAgent(stakeAmount, ["data_retrieval", "computation"])
    .accounts({
      owner: alice.publicKey,
      agentAccount: aliceAgent,
      agentTokenAccount: aliceAta,
      vault: aliceVault,
      mint: mintKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([alice])
    .rpc();

  // Register Bob
  const [bobAgent] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), bob.publicKey.toBuffer()],
    registryProgram.programId
  );
  const [bobVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), bob.publicKey.toBuffer()],
    registryProgram.programId
  );

  const bobRegTx = await registryProgram.methods
    .registerAgent(stakeAmount, ["execution", "analysis"])
    .accounts({
      owner: bob.publicKey,
      agentAccount: bobAgent,
      agentTokenAccount: bobAta,
      vault: bobVault,
      mint: mintKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([bob])
    .rpc();

  const aliceAgentData = await registryProgram.account.agentAccount.fetch(aliceAgent);
  const bobAgentData = await registryProgram.account.agentAccount.fetch(bobAgent);

  console.log(`  ✓ Alice registered — stake: ${Number(aliceAgentData.stakeAmount) / 1e9} $WEB, capabilities: [${aliceAgentData.capabilities.join(", ")}]`);
  console.log(`  ✓ Bob registered — stake: ${Number(bobAgentData.stakeAmount) / 1e9} $WEB, capabilities: [${bobAgentData.capabilities.join(", ")}]`);
  console.log(`  ✓ Alice reg tx: ${aliceRegTx}`);
  console.log(`  ✓ Bob reg tx: ${bobRegTx}\n`);

  // ─── Step 4: Alice Pays Bob 10 $WEB ───────────────────────────
  console.log("Step 4: Alice sends 10 $WEB to Bob...");

  const paymentAmount = new anchor.BN("10000000000"); // 10 $WEB
  const expectedBurn = new anchor.BN("50000000"); // 0.05 $WEB
  const expectedReceived = new anchor.BN("9950000000"); // 9.95 $WEB

  const supplyBefore = (await getMint(provider.connection, mintKeypair.publicKey)).supply;
  const aliceBalBefore = (await getAccount(provider.connection, aliceAta)).amount;
  const bobBalBefore = (await getAccount(provider.connection, bobAta)).amount;

  const paymentTx = await tokenProgram.methods
    .transferWithBurn(paymentAmount)
    .accounts({
      authority: alice.publicKey,
      mint: mintKeypair.publicKey,
      from: aliceAta,
      to: bobAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([alice])
    .rpc();

  const supplyAfter = (await getMint(provider.connection, mintKeypair.publicKey)).supply;
  const aliceBalAfter = (await getAccount(provider.connection, aliceAta)).amount;
  const bobBalAfter = (await getAccount(provider.connection, bobAta)).amount;

  const burned = supplyBefore - supplyAfter;
  const bobReceived = bobBalAfter - bobBalBefore;
  const aliceSent = aliceBalBefore - aliceBalAfter;

  console.log(`  ✓ Alice sent: ${Number(aliceSent) / 1e9} $WEB`);
  console.log(`  ✓ Bob received: ${Number(bobReceived) / 1e9} $WEB`);
  console.log(`  ✓ Burned: ${Number(burned) / 1e9} $WEB (0.5%)`);
  console.log(`  ✓ Payment tx: ${paymentTx}\n`);

  // ─── Step 5: Final State ──────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Final Account States");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Alice balance: ${Number(aliceBalAfter) / 1e9} $WEB`);
  console.log(`  Bob balance: ${Number(bobBalAfter) / 1e9} $WEB`);
  console.log(`  Total supply: ${Number(supplyAfter) / 1e9} $WEB`);
  console.log(`  Total burned: ${Number(BigInt("1000000000000000000") - supplyAfter) / 1e9} $WEB`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ─── Assertions ───────────────────────────────────────────────
  if (bobReceived.toString() !== expectedReceived.toString()) {
    throw new Error(`Bob should have received ${expectedReceived.toString()} but got ${bobReceived.toString()}`);
  }
  if (burned.toString() !== expectedBurn.toString()) {
    throw new Error(`Burn should be ${expectedBurn.toString()} but was ${burned.toString()}`);
  }

  console.log("✅ Demo complete! All assertions passed.");
  console.log("   The Webber Protocol is working: agents registered, payment executed, burn confirmed.\n");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
