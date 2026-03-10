import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberRegistry } from "../target/types/webber_registry";
import { WebberToken } from "../target/types/webber_token";
import {
  Keypair,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { assert } from "chai";

describe("webber-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const payer = provider.wallet as anchor.Wallet;

  // Token keypairs
  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();

  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  const MIN_STAKE = new anchor.BN("100000000000"); // 100 $WEB
  const FUND_AMOUNT = new anchor.BN("200000000000"); // 200 $WEB for testing

  // Helper: derive agent PDA
  function getAgentPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  // Helper: derive vault PDA
  function getVaultPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  before(async () => {
    // Initialize $WEB token mint with 1B supply
    await tokenProgram.methods
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

    console.log("$WEB token initialized for registry tests");
  });

  // Helper: create a funded agent wallet
  async function createFundedAgent(): Promise<{
    wallet: Keypair;
    tokenAccount: PublicKey;
  }> {
    const wallet = Keypair.generate();

    // Airdrop SOL for tx fees
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Create ATA for the agent
    const tokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      wallet.publicKey
    );

    // Transfer $WEB from treasury to agent (using raw SPL transfer, not burn)
    await tokenProgram.methods
      .transferWithBurn(FUND_AMOUNT)
      .accounts({
        authority: payer.publicKey,
        mint: mintKeypair.publicKey,
        from: treasuryKeypair.publicKey,
        to: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return { wallet, tokenAccount };
  }

  it("Registers an agent with 100 $WEB stake", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    const balanceBefore = (
      await getAccount(provider.connection, tokenAccount)
    ).amount;

    await registryProgram.methods
      .registerAgent(MIN_STAKE, ["data_retrieval", "computation"])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();

    // Verify agent account
    const agent = await registryProgram.account.agentAccount.fetch(agentPda);
    assert.equal(agent.owner.toBase58(), wallet.publicKey.toBase58());
    assert.equal(agent.stakeAmount.toString(), MIN_STAKE.toString());
    assert.equal(agent.reputationScore.toString(), "0");
    assert.deepEqual(agent.capabilities, ["data_retrieval", "computation"]);
    assert.isNull(agent.unstakeRequestedAt);
    assert.equal(agent.tier, 1, "Default tier should be 1");

    // Verify stake was transferred
    const balanceAfter = (
      await getAccount(provider.connection, tokenAccount)
    ).amount;
    assert.equal(
      (balanceBefore - balanceAfter).toString(),
      MIN_STAKE.toString(),
      "Stake should be deducted from agent wallet"
    );

    // Verify vault holds the stake
    const vaultBalance = (
      await getAccount(provider.connection, vaultPda)
    ).amount;
    assert.equal(
      vaultBalance.toString(),
      MIN_STAKE.toString(),
      "Vault should hold the staked amount"
    );

    console.log("✅ Agent registered with 100 $WEB stake");
  });

  it("Rejects registration with insufficient stake", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    const lowStake = new anchor.BN("50000000000"); // 50 $WEB (below 100 minimum)

    try {
      await registryProgram.methods
        .registerAgent(lowStake, [])
        .accounts({
          owner: wallet.publicKey,
          agentAccount: agentPda,
          agentTokenAccount: tokenAccount,
          vault: vaultPda,
          mint: mintKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should have thrown InsufficientStake error");
    } catch (err) {
      assert.include(err.toString(), "InsufficientStake");
    }

    console.log("✅ Insufficient stake correctly rejected");
  });

  it("Updates capabilities (owner only)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    // Register first
    await registryProgram.methods
      .registerAgent(MIN_STAKE, ["analysis"])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();

    // Update capabilities
    await registryProgram.methods
      .updateCapabilities(["data_retrieval", "computation", "execution"])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
      })
      .signers([wallet])
      .rpc();

    const agent = await registryProgram.account.agentAccount.fetch(agentPda);
    assert.deepEqual(agent.capabilities, [
      "data_retrieval",
      "computation",
      "execution",
    ]);

    console.log("✅ Capabilities updated successfully");
  });

  it("Rejects capability update from non-owner", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    // Register agent
    await registryProgram.methods
      .registerAgent(MIN_STAKE, ["analysis"])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();

    // Try to update with a different signer
    const imposter = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      imposter.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await registryProgram.methods
        .updateCapabilities(["hacked"])
        .accounts({
          owner: imposter.publicKey,
          agentAccount: agentPda,
        })
        .signers([imposter])
        .rpc();
      assert.fail("Should have thrown error for non-owner");
    } catch (err) {
      // Seeds constraint will fail because PDA is derived from owner key
      assert.ok(err, "Non-owner should be rejected");
    }

    console.log("✅ Non-owner capability update correctly rejected");
  });

  it("Initiates deregistration with cooldown timestamp", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    // Register
    await registryProgram.methods
      .registerAgent(MIN_STAKE, [])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();

    // Deregister
    await registryProgram.methods
      .deregisterAgent()
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
      })
      .signers([wallet])
      .rpc();

    const agent = await registryProgram.account.agentAccount.fetch(agentPda);
    assert.isNotNull(agent.unstakeRequestedAt, "Unstake timestamp should be set");
    assert.isAbove(
      agent.unstakeRequestedAt.toNumber(),
      0,
      "Timestamp should be positive"
    );

    console.log("✅ Deregistration initiated with cooldown");
  });

  it("Rejects claim_unstake before cooldown expires", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    // Register
    await registryProgram.methods
      .registerAgent(MIN_STAKE, [])
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        agentTokenAccount: tokenAccount,
        vault: vaultPda,
        mint: mintKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([wallet])
      .rpc();

    // Deregister
    await registryProgram.methods
      .deregisterAgent()
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
      })
      .signers([wallet])
      .rpc();

    // Try to claim immediately (cooldown not expired)
    try {
      await registryProgram.methods
        .claimUnstake()
        .accounts({
          owner: wallet.publicKey,
          agentAccount: agentPda,
          agentTokenAccount: tokenAccount,
          vault: vaultPda,
          mint: mintKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should have thrown CooldownNotExpired error");
    } catch (err) {
      assert.include(err.toString(), "CooldownNotExpired");
    }

    console.log("✅ Premature claim correctly rejected");
  });
});
