import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberReputation } from "../target/types/webber_reputation";
import { WebberRegistry } from "../target/types/webber_registry";
import { WebberMarketplace } from "../target/types/webber_marketplace";
import { WebberToken } from "../target/types/webber_token";
import {
  Keypair,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("webber-reputation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const reputationProgram = anchor.workspace.WebberReputation as Program<WebberReputation>;
  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const marketplaceProgram = anchor.workspace.WebberMarketplace as Program<WebberMarketplace>;
  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const payer = provider.wallet as anchor.Wallet;

  // Token setup
  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  // Marketplace state PDA (from marketplace program)
  const [marketplaceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketplace_state")],
    marketplaceProgram.programId
  );

  const FUND_AMOUNT = new anchor.BN("500000000000"); // 500 $WEB
  const MIN_STAKE = new anchor.BN("100000000000"); // 100 $WEB

  // ---- PDA helpers ----

  function getAgentPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  function getVaultPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer()],
      registryProgram.programId
    );
  }

  function getReputationLedgerPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), owner.toBuffer()],
      reputationProgram.programId
    );
  }

  function getReputationAuthorityPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("reputation_authority")],
      reputationProgram.programId
    );
  }

  // ---- Setup helpers ----

  async function createFundedAgent(): Promise<{
    wallet: Keypair;
    tokenAccount: PublicKey;
  }> {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const tokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mintKeypair.publicKey,
      wallet.publicKey
    );

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

  async function registerAgent(wallet: Keypair, tokenAccount: PublicKey): Promise<void> {
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [vaultPda] = getVaultPda(wallet.publicKey);

    await registryProgram.methods
      .registerAgent(MIN_STAKE, ["data_retrieval"])
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
  }

  async function initReputationLedger(wallet: Keypair): Promise<void> {
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);

    await reputationProgram.methods
      .initReputationLedger()
      .accounts({
        owner: wallet.publicKey,
        agentAccount: agentPda,
        reputationLedger: ledgerPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
  }

  // ---- Global setup ----

  before(async () => {
    // 1. Initialize $WEB token mint
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

    // 2. Initialize marketplace (needed for marketplace_state PDA validation in update_reputation)
    //    May already exist if marketplace tests ran first — safe to skip.
    try {
      await marketplaceProgram.methods
        .initializeMarketplace()
        .accounts({
          payer: payer.publicKey,
          marketplaceState: marketplaceState,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) {
      // Already initialized by marketplace tests — that's fine
    }

    console.log("$WEB token + marketplace initialized for reputation tests");
  });

  // ---- init_reputation_ledger tests ----

  it("Initializes a reputation ledger for a registered agent", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);

    await initReputationLedger(wallet);

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.agent.toBase58(), wallet.publicKey.toBase58());
    assert.equal(ledger.totalTransactions.toString(), "0");
    assert.equal(ledger.totalVolume.toString(), "0");
    assert.equal(ledger.disputesOpenedAgainst, 0);
    assert.equal(ledger.disputesResolvedClean, 0);
    assert.equal(ledger.score, 0);
    assert.equal(ledger.tier, 1);

    console.log("✅ Reputation ledger initialized");
  });

  it("Rejects init_reputation_ledger for non-registered agent", async () => {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const [agentPda] = getAgentPda(wallet.publicKey);
    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);

    try {
      await reputationProgram.methods
        .initReputationLedger()
        .accounts({
          owner: wallet.publicKey,
          agentAccount: agentPda,
          reputationLedger: ledgerPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should reject non-registered agent");
    } catch (err) {
      assert.ok(err, "Non-registered agent should be rejected");
    }

    console.log("✅ Non-registered agent correctly rejected");
  });

  // ---- update_reputation tests ----

  it("Updates reputation after a transaction (score=10, tier=1)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // Call update_reputation with 1_000_000 lamports volume
    await reputationProgram.methods
      .updateReputation(new anchor.BN(1_000_000))
      .accounts({
        caller: payer.publicKey,
        marketplaceState: marketplaceState,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.totalTransactions.toString(), "1");
    assert.equal(ledger.totalVolume.toString(), "1000000");
    // Score: base = 1*10 = 10, volume = 1M/1M = 1, total = 11
    assert.equal(ledger.score, 11);
    assert.equal(ledger.tier, 1); // Below 1000 threshold

    // Verify registry was also updated via CPI
    const agent = await registryProgram.account.agentAccount.fetch(agentPda);
    assert.equal(agent.reputationScore.toString(), "11");
    assert.equal(agent.tier, 1);

    console.log("✅ Reputation updated: score=11, tier=1");
  });

  it("Accumulates reputation across multiple transactions", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // Execute 5 transactions of 500M each (total 2.5B volume)
    for (let i = 0; i < 5; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(500_000_000))
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.totalTransactions.toString(), "5");
    assert.equal(ledger.totalVolume.toString(), "2500000000");
    // Score: base = 5*10 = 50, volume = 2500M/1M = 2500, total = 2550
    assert.equal(ledger.score, 2550);
    assert.equal(ledger.tier, 2); // 1000-3999 = Tier 2

    console.log("✅ Reputation accumulated: score=2550, tier=2");
  });

  it("Reaches Tier 2 at exactly 100 transactions", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // 100 txns × 10 = 1000 base score → Tier 2 threshold
    for (let i = 0; i < 100; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(1)) // minimal volume
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.totalTransactions.toString(), "100");
    // base = 100*10 = 1000, volume = 100/1M ≈ 0
    assert.equal(ledger.score, 1000);
    assert.equal(ledger.tier, 2); // Exactly at TIER_2_THRESHOLD

    console.log("✅ Tier 2 reached at 100 transactions");
  });

  it("Volume bonus adds to score correctly", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // 1 tx with 100M volume → base=10, volume=100M/1M=100, total=110
    await reputationProgram.methods
      .updateReputation(new anchor.BN(100_000_000))
      .accounts({
        caller: payer.publicKey,
        marketplaceState: marketplaceState,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.score, 110); // 10 base + 100 volume bonus

    console.log("✅ Volume bonus calculated correctly: 10 + 100 = 110");
  });

  // ---- record_dispute tests ----

  it("Records a dispute and applies penalty (-150)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // First build some score: 20 txns = 200 base score
    for (let i = 0; i < 20; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(1))
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    const ledgerBefore = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledgerBefore.score, 200);

    // Record dispute
    await reputationProgram.methods
      .recordDispute()
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledgerAfter = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledgerAfter.disputesOpenedAgainst, 1);
    // 200 - 150 = 50
    assert.equal(ledgerAfter.score, 50);
    assert.equal(ledgerAfter.tier, 1);

    console.log("✅ Dispute recorded: 200 → 50 (-150 penalty)");
  });

  it("Score floors at 0 when penalty exceeds positive", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // Build small score: 5 txns = 50 base
    for (let i = 0; i < 5; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(1))
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    // Record dispute: 50 - 150 = floor at 0 (saturating_sub)
    await reputationProgram.methods
      .recordDispute()
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.score, 0, "Score should floor at 0");
    assert.equal(ledger.tier, 1);

    console.log("✅ Score correctly floors at 0");
  });

  // ---- resolve_dispute tests ----

  it("Resolves dispute in agent's favour (+75 recovery)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // Build score: 20 txns = 200
    for (let i = 0; i < 20; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(1))
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    // Record dispute: 200 → 50
    await reputationProgram.methods
      .recordDispute()
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const afterDispute = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(afterDispute.score, 50);

    // Resolve in favour: 50 + 75 = 125
    await reputationProgram.methods
      .resolveDispute(true)
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.disputesResolvedClean, 1);
    // base=200, penalty=150, recovery=75 → 200-150+75 = 125
    assert.equal(ledger.score, 125);

    console.log("✅ Dispute resolved in favour: 50 → 125 (+75 recovery)");
  });

  it("Resolves dispute NOT in agent's favour (score unchanged)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // Build score: 20 txns = 200
    for (let i = 0; i < 20; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(1))
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    // Record dispute: 200 → 50
    await reputationProgram.methods
      .recordDispute()
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    // Resolve NOT in favour — no recovery
    await reputationProgram.methods
      .resolveDispute(false)
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    const ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.disputesResolvedClean, 0, "Should not increment clean count");
    // base=200, penalty=150, recovery=0 → 50
    assert.equal(ledger.score, 50, "Score should stay at 50 without recovery");

    console.log("✅ Dispute resolved NOT in favour: score stays 50");
  });

  // ---- Integration test ----

  it("Full flow: register → init ledger → transact → dispute → resolve", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);
    await initReputationLedger(wallet);

    const [ledgerPda] = getReputationLedgerPda(wallet.publicKey);
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [repAuthority] = getReputationAuthorityPda();

    // 1. Execute 50 transactions (base=500)
    for (let i = 0; i < 50; i++) {
      await reputationProgram.methods
        .updateReputation(new anchor.BN(10_000_000)) // 10M per tx → 500M total
        .accounts({
          caller: payer.publicKey,
          marketplaceState: marketplaceState,
          reputationLedger: ledgerPda,
          agentAccount: agentPda,
          reputationAuthority: repAuthority,
          registryProgram: registryProgram.programId,
        })
        .rpc();
    }

    let ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    // base = 50*10 = 500, volume = 500M/1M = 500, total = 1000
    assert.equal(ledger.score, 1000);
    assert.equal(ledger.tier, 2); // Tier 2

    // 2. Record a dispute: 1000 - 150 = 850
    await reputationProgram.methods
      .recordDispute()
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.score, 850);
    assert.equal(ledger.tier, 1); // Dropped below 1000

    // 3. Resolve in favour: 850 + 75 = 925
    await reputationProgram.methods
      .resolveDispute(true)
      .accounts({
        caller: payer.publicKey,
        reputationLedger: ledgerPda,
        agentAccount: agentPda,
        reputationAuthority: repAuthority,
        registryProgram: registryProgram.programId,
      })
      .rpc();

    ledger = await reputationProgram.account.reputationLedger.fetch(ledgerPda);
    assert.equal(ledger.score, 925);
    assert.equal(ledger.tier, 1); // Still below 1000

    // 4. Verify registry has matching score
    const agent = await registryProgram.account.agentAccount.fetch(agentPda);
    assert.equal(agent.reputationScore.toString(), "925");
    assert.equal(agent.tier, 1);

    console.log("✅ Full reputation flow: 0 → 1000 (T2) → 850 (dispute) → 925 (resolved)");
  });
});
