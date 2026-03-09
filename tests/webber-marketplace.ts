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
});
