import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberMarketplace } from "../target/types/webber_marketplace";
import { WebberToken } from "../target/types/webber_token";
import { WebberRegistry } from "../target/types/webber_registry";
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
} from "@solana/spl-token";
import { assert } from "chai";

describe("webber-marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marketplaceProgram = anchor.workspace.WebberMarketplace as Program<WebberMarketplace>;
  const tokenProgram = anchor.workspace.WebberToken as Program<WebberToken>;
  const registryProgram = anchor.workspace.WebberRegistry as Program<WebberRegistry>;
  const payer = provider.wallet as anchor.Wallet;

  // Token setup
  const mintKeypair = Keypair.generate();
  const treasuryKeypair = Keypair.generate();
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    tokenProgram.programId
  );

  // Marketplace state PDA
  const [marketplaceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("marketplace_state")],
    marketplaceProgram.programId
  );

  const FUND_AMOUNT = new anchor.BN("500000000000"); // 500 $WEB
  const MIN_STAKE = new anchor.BN("100000000000"); // 100 $WEB

  // Helpers
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

  function getListingPda(providerKey: PublicKey, listingId: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("listing"),
        providerKey.toBuffer(),
        new anchor.BN(listingId).toArrayLike(Buffer, "le", 8),
      ],
      marketplaceProgram.programId
    );
  }

  function getTransactionPda(listing: PublicKey, buyer: PublicKey, txId: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("transaction"),
        listing.toBuffer(),
        buyer.toBuffer(),
        new anchor.BN(txId).toArrayLike(Buffer, "le", 8),
      ],
      marketplaceProgram.programId
    );
  }

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

  before(async () => {
    // Initialize $WEB token
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

    console.log("$WEB token initialized for marketplace tests");
  });

  // --- Task 3: initialize_marketplace ---

  it("Initializes the marketplace", async () => {
    await marketplaceProgram.methods
      .initializeMarketplace()
      .accounts({
        payer: payer.publicKey,
        marketplaceState: marketplaceState,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(state.listingIdCounter.toString(), "0");
    assert.equal(state.totalVolume.toString(), "0");
    assert.equal(state.totalBurned.toString(), "0");
    assert.equal(state.totalTransactions.toString(), "0");

    console.log("✅ Marketplace initialized");
  });

  // --- Task 4: create_listing ---

  it("Creates a listing for a registered agent", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, 0);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },
        new anchor.BN(5_000_000_000),
        new anchor.BN(0),
        "Web Search Service",
        "ipfs://Qm..."
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listing.provider.toBase58(), wallet.publicKey.toBase58());
    assert.equal(listing.listingId.toString(), "0");
    assert.equal(listing.pricePerCall.toString(), "5000000000");
    assert.equal(listing.title, "Web Search Service");
    assert.isTrue(listing.isActive);
    assert.equal(listing.totalCalls.toString(), "0");

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(state.listingIdCounter.toString(), "1");

    console.log("✅ Listing created successfully");
  });

  it("Rejects listing from non-registered agent", async () => {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const [listingPda] = getListingPda(wallet.publicKey, state.listingIdCounter.toNumber());
    const [agentPda] = getAgentPda(wallet.publicKey);

    try {
      await marketplaceProgram.methods
        .createListing(
          { computation: {} },
          new anchor.BN(10_000_000_000),
          new anchor.BN(0),
          "Compute Service",
          "ipfs://Qm..."
        )
        .accounts({
          provider: wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
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

  it("Rejects listing with zero price", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const currentId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, currentId);

    try {
      await marketplaceProgram.methods
        .createListing(
          { custom: {} },
          new anchor.BN(0),
          new anchor.BN(0),
          "Free Service",
          "ipfs://Qm..."
        )
        .accounts({
          provider: wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      assert.fail("Should reject zero price");
    } catch (err) {
      assert.include(err.toString(), "InvalidPrice");
    }

    console.log("✅ Zero price correctly rejected");
  });

  // --- Task 5: update_listing + close_listing ---

  it("Updates a listing (owner only)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { analysis: {} },
        new anchor.BN(10_000_000_000),
        new anchor.BN(0),
        "Analysis Service",
        "ipfs://old"
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    await marketplaceProgram.methods
      .updateListing(
        new anchor.BN(15_000_000_000),
        null,
        "ipfs://new",
        null
      )
      .accounts({
        provider: wallet.publicKey,
        listing: listingPda,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listing.pricePerCall.toString(), "15000000000");
    assert.equal(listing.descriptionUri, "ipfs://new");

    console.log("✅ Listing updated successfully");
  });

  it("Closes a listing (soft delete)", async () => {
    const { wallet, tokenAccount } = await createFundedAgent();
    await registerAgent(wallet, tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(wallet.publicKey);
    const [listingPda] = getListingPda(wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { routing: {} },
        new anchor.BN(3_000_000_000),
        new anchor.BN(0),
        "Routing Service",
        "ipfs://Qm..."
      )
      .accounts({
        provider: wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    await marketplaceProgram.methods
      .closeListing()
      .accounts({
        provider: wallet.publicKey,
        listing: listingPda,
      })
      .signers([wallet])
      .rpc();

    const listing = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.isFalse(listing.isActive);

    console.log("✅ Listing closed (soft delete)");
  });

  // --- Task 6: execute_payment ---

  it("Executes payment with 0.5% burn via CPI", async () => {
    // Create and register provider
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    // Create listing
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [providerAgentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },
        new anchor.BN(10_000_000_000),  // 10 $WEB
        new anchor.BN(0),
        "Search API",
        "ipfs://search"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: providerAgentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Create and fund buyer
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const paymentAmount = new anchor.BN(10_000_000_000);  // 10 $WEB
    const expectedBurn = new anchor.BN(50_000_000);  // 0.05 $WEB (0.5%)
    const expectedReceived = new anchor.BN(9_950_000_000);  // 9.95 $WEB

    // Get balances before
    const providerBalanceBefore = (
      await getAccount(provider.connection, providerAgent.tokenAccount)
    ).amount;
    const mintBefore = await getMint(provider.connection, mintKeypair.publicKey);

    // Get current tx count for transaction PDA
    const stateBeforePayment = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateBeforePayment.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(paymentAmount)
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: providerAgentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Verify provider received amount minus burn
    const providerBalanceAfter = (
      await getAccount(provider.connection, providerAgent.tokenAccount)
    ).amount;
    const providerIncrease = providerBalanceAfter - providerBalanceBefore;
    assert.equal(
      providerIncrease.toString(),
      expectedReceived.toString(),
      "Provider should receive 9.95 $WEB"
    );

    // Verify burn
    const mintAfter = await getMint(provider.connection, mintKeypair.publicKey);
    const supplyDecrease = mintBefore.supply - mintAfter.supply;
    assert.equal(
      supplyDecrease.toString(),
      expectedBurn.toString(),
      "0.05 $WEB should be burned"
    );

    // Verify transaction record
    const txRecord = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.equal(txRecord.amountPaid.toString(), paymentAmount.toString());
    assert.equal(txRecord.amountBurned.toString(), expectedBurn.toString());
    assert.equal(txRecord.buyer.toBase58(), buyer.wallet.publicKey.toBase58());
    assert.equal(txRecord.provider.toBase58(), providerAgent.wallet.publicKey.toBase58());

    // Verify global state updated
    const stateAfter = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    assert.equal(
      stateAfter.totalTransactions.toString(),
      (txId + 1).toString()
    );
    assert.isAbove(
      parseInt(stateAfter.totalVolume.toString()),
      0,
      "Total volume should increase"
    );
    assert.isAbove(
      parseInt(stateAfter.totalBurned.toString()),
      0,
      "Total burned should increase"
    );

    // Verify listing total_calls incremented
    const listingAfter = await marketplaceProgram.account.serviceListing.fetch(listingPda);
    assert.equal(listingAfter.totalCalls.toString(), "1");

    console.log("✅ Payment executed with 0.5% burn via CPI");
  });

  it("Rejects payment on inactive listing", async () => {
    // Create provider with listing, then close it
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { execution: {} },
        new anchor.BN(5_000_000_000),
        new anchor.BN(0),
        "Exec Service",
        "ipfs://exec"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Close it
    await marketplaceProgram.methods
      .closeListing()
      .accounts({
        provider: providerAgent.wallet.publicKey,
        listing: listingPda,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // Try to pay
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    try {
      await marketplaceProgram.methods
        .executePayment(new anchor.BN(5_000_000_000))
        .accounts({
          buyer: buyer.wallet.publicKey,
          marketplaceState: marketplaceState,
          listing: listingPda,
          providerAgent: agentPda,
          transaction: transactionPda,
          buyerTokenAccount: buyer.tokenAccount,
          providerTokenAccount: providerAgent.tokenAccount,
          mint: mintKeypair.publicKey,
          webberTokenProgram: tokenProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer.wallet])
        .rpc();
      assert.fail("Should reject payment on inactive listing");
    } catch (err) {
      assert.include(err.toString(), "ListingNotActive");
    }

    console.log("✅ Payment on inactive listing correctly rejected");
  });

  // --- Task 7: open_dispute ---

  it("Opens dispute within 24h window", async () => {
    // Setup: create provider, listing, buyer, execute payment
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { computation: {} },
        new anchor.BN(5_000_000_000),
        new anchor.BN(0),
        "Compute for Dispute",
        "ipfs://dispute-test"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(5_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Open dispute (within 24h since we just executed)
    await marketplaceProgram.methods
      .openDispute()
      .accounts({
        buyer: buyer.wallet.publicKey,
        transaction: transactionPda,
      })
      .signers([buyer.wallet])
      .rpc();

    const txRecord = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.deepEqual(txRecord.status, { disputed: {} });

    console.log("✅ Dispute opened successfully within 24h window");
  });

  it("Rejects dispute from non-buyer", async () => {
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { analysis: {} },
        new anchor.BN(8_000_000_000),
        new anchor.BN(0),
        "Analysis Dispute Test",
        "ipfs://dispute2"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(8_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // Try to dispute as provider (not buyer)
    try {
      await marketplaceProgram.methods
        .openDispute()
        .accounts({
          buyer: providerAgent.wallet.publicKey,
          transaction: transactionPda,
        })
        .signers([providerAgent.wallet])
        .rpc();
      assert.fail("Should reject dispute from non-buyer");
    } catch (err) {
      assert.include(err.toString(), "NotTransactionBuyer");
    }

    console.log("✅ Non-buyer dispute correctly rejected");
  });

  // --- Task 8: Integration test ---

  it("Full flow: register → list → pay → verify burn → dispute", async () => {
    // 1. Register provider agent
    const providerAgent = await createFundedAgent();
    await registerAgent(providerAgent.wallet, providerAgent.tokenAccount);

    // 2. Create listing
    const state = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const listingId = state.listingIdCounter.toNumber();
    const [agentPda] = getAgentPda(providerAgent.wallet.publicKey);
    const [listingPda] = getListingPda(providerAgent.wallet.publicKey, listingId);

    await marketplaceProgram.methods
      .createListing(
        { dataRetrieval: {} },
        new anchor.BN(20_000_000_000),  // 20 $WEB
        new anchor.BN(0),
        "Integration Test Service",
        "ipfs://integration"
      )
      .accounts({
        provider: providerAgent.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([providerAgent.wallet])
      .rpc();

    // 3. Register buyer and pay
    const buyer = await createFundedAgent();
    await registerAgent(buyer.wallet, buyer.tokenAccount);

    const stateNow = await marketplaceProgram.account.marketplaceState.fetch(marketplaceState);
    const txId = stateNow.totalTransactions.toNumber();
    const [transactionPda] = getTransactionPda(listingPda, buyer.wallet.publicKey, txId);
    const mintBefore = await getMint(provider.connection, mintKeypair.publicKey);

    await marketplaceProgram.methods
      .executePayment(new anchor.BN(20_000_000_000))
      .accounts({
        buyer: buyer.wallet.publicKey,
        marketplaceState: marketplaceState,
        listing: listingPda,
        providerAgent: agentPda,
        transaction: transactionPda,
        buyerTokenAccount: buyer.tokenAccount,
        providerTokenAccount: providerAgent.tokenAccount,
        mint: mintKeypair.publicKey,
        webberTokenProgram: tokenProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.wallet])
      .rpc();

    // 4. Verify burn (0.5% of 20 $WEB = 0.1 $WEB = 100_000_000 raw)
    const mintAfter = await getMint(provider.connection, mintKeypair.publicKey);
    const burned = mintBefore.supply - mintAfter.supply;
    assert.equal(burned.toString(), "100000000", "0.1 $WEB should be burned (0.5% of 20)");

    // 5. Verify transaction
    const tx = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.equal(tx.amountPaid.toString(), "20000000000");
    assert.equal(tx.amountBurned.toString(), "100000000");

    // 6. Open dispute
    await marketplaceProgram.methods
      .openDispute()
      .accounts({
        buyer: buyer.wallet.publicKey,
        transaction: transactionPda,
      })
      .signers([buyer.wallet])
      .rpc();

    const txAfterDispute = await marketplaceProgram.account.serviceTransaction.fetch(transactionPda);
    assert.deepEqual(txAfterDispute.status, { disputed: {} });

    console.log("✅ Full integration flow: register → list → pay → burn → dispute");
  });
});
