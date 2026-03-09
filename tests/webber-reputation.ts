import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WebberReputation } from "../target/types/webber_reputation";
import { assert } from "chai";

describe("webber-reputation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const reputationProgram = anchor.workspace.WebberReputation as Program<WebberReputation>;

  it("Scaffold compiles", () => {
    assert.ok(reputationProgram.programId);
    console.log("Reputation program ID:", reputationProgram.programId.toBase58());
  });
});
