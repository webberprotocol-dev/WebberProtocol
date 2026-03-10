# Reputation Engine Design — Phase 2 Build 2

**Date:** 2026-03-09
**Status:** Approved (from Phase 2 spec)

## Overview

New `webber-reputation` Anchor program. Turns marketplace transactions into agent trust scores. Reputation is the most valuable asset on Webber — earned through real economic activity, recalculated on every transaction, transparent and on-chain verifiable.

## Approach

Single-direction CPI chain: `marketplace → reputation → registry`. No reverse calls, no circular dependencies.

- `webber-reputation` owns the score calculation logic and the ReputationLedger account
- `webber-registry` gets a new `update_agent_reputation` instruction (callable only by reputation program's PDA)
- `webber-marketplace`'s `execute_payment` CPIs to reputation after its own state changes + token CPI
- `init_reputation_ledger` is called by the client alongside agent registration (not CPI from registry, to avoid circular deps)

## Accounts

### ReputationLedger (new — webber-reputation)
- PDA seeds: `["reputation", agent.key]`
- Fields:
  - `agent`: Pubkey — the agent this ledger belongs to
  - `total_transactions`: u64 — lifetime successful transactions
  - `total_volume`: u64 — lifetime $WEB transacted
  - `disputes_opened_against`: u16 — disputes raised by buyers
  - `disputes_resolved_clean`: u16 — disputes resolved in agent's favour
  - `score`: u32 — computed reputation score 0-10000
  - `tier`: u8 — 1 through 4, derived from score thresholds
  - `last_updated`: i64 — timestamp of last recalculation
  - `bump`: u8 — PDA bump
- Space: 8 (disc) + 32 + 8 + 8 + 2 + 2 + 4 + 1 + 8 + 1 = 74

### AgentAccount (modified — webber-registry)
- Add field: `tier: u8` (defaults to 1)
- Existing `reputation_score: u64` stays, gets updated by CPI from reputation program
- MAX_SIZE increases by 1 byte

## Score Calculation

Recalculated on every completed transaction. All arithmetic uses checked operations.

| Component | Formula | Cap |
|-----------|---------|-----|
| Base score | `total_transactions * 10` | 5000 |
| Volume bonus | `total_volume / 1_000_000` | 3000 |
| Dispute penalty | `disputes_opened_against * 150` | (subtracted) |
| Dispute recovery | `disputes_resolved_clean * 75` | (added back) |

**Score** = min(base, 5000) + min(volume_bonus, 3000) - penalty + recovery
- Maximum: 10000
- Minimum: 0 (cannot go negative, use saturating_sub)

**Tier thresholds:**
- 0–999: Tier 1
- 1000–3999: Tier 2
- 4000–7999: Tier 3
- 8000+: Tier 4

## Instructions

### webber-reputation

#### init_reputation_ledger
- Called by agent owner alongside registration
- Validates: agent has active AgentAccount in webber-registry (cross-program read)
- Creates ReputationLedger PDA with all counters at 0, score 0, tier 1
- Emits ReputationInitialized event

#### update_reputation(amount: u64)
- Called by webber-marketplace via CPI after execute_payment
- Authority: `marketplace_state` PDA from marketplace (verified via `seeds::program`)
- Increments `total_transactions` by 1
- Increments `total_volume` by `amount`
- Recalculates `score` using formula
- Derives `tier` from updated score
- CPIs to webber-registry `update_agent_reputation(score, tier)` using reputation PDA signer
- Emits ReputationUpdated { agent, old_score, new_score, new_tier }

#### record_dispute
- Called by marketplace when dispute is opened (CPI from open_dispute)
- Increments `disputes_opened_against`
- Recalculates score
- CPIs to registry to update
- Emits DisputeRecorded event

#### resolve_dispute(in_agent_favour: bool)
- Called to resolve a dispute
- If in_agent_favour: increments `disputes_resolved_clean`
- Recalculates score
- CPIs to registry to update
- Emits DisputeResolved event

#### get_reputation (view)
- Read-only view function
- Returns full ReputationLedger for a given agent pubkey
- Used by SDK/indexer

### webber-registry (new instruction)

#### update_agent_reputation(score: u64, tier: u8)
- Authority: PDA from webber-reputation program (verified by seeds::program or address)
- Updates `reputation_score` and `tier` on AgentAccount
- No other fields modified
- Emits ReputationScoreUpdated event

## Cross-Program Integration

```
Client                    Marketplace                 Reputation              Registry
  |                           |                           |                      |
  |-- execute_payment ------->|                           |                      |
  |                           |-- state changes --------->|                      |
  |                           |-- CPI transfer_with_burn -|-> webber-token       |
  |                           |-- CPI update_reputation ->|                      |
  |                           |                           |-- recalculate ------->|
  |                           |                           |-- CPI update_agent -->|
  |                           |                           |                      |
```

CPI depth: marketplace (1) → reputation (2) → registry (3). Solana max CPI depth is 4, so this is safe.

## Cargo Dependencies

```
webber-reputation depends on:
  - webber-registry (features = ["cpi"]) — for AgentAccount type + update CPI
  - webber-marketplace (features = ["cpi"]) — for MarketplaceState type validation

webber-marketplace depends on (new):
  - webber-reputation (features = ["cpi"]) — for update_reputation CPI

webber-registry depends on:
  - (no new deps — reputation validates the PDA signer via address check)
```

## Error Codes (webber-reputation)

| Code | Description |
|------|-------------|
| AgentNotRegistered | Agent not found in webber-registry |
| LedgerAlreadyInitialized | ReputationLedger already exists |
| UnauthorizedCaller | CPI caller is not the expected program |
| ArithmeticOverflow | Checked math failed |
| InvalidTier | Computed tier out of range |
| DisputeNotFound | Referenced dispute doesn't exist |

## Events

```rust
ReputationInitialized { agent, tier: 1 }
ReputationUpdated { agent, old_score, new_score, new_tier }
DisputeRecorded { agent, disputes_count }
DisputeResolved { agent, in_favour, new_score }
```

## Security

- All arithmetic: checked operations (no overflow)
- CPI authorization: marketplace_state PDA verified via seeds::program
- Registry update: reputation PDA signer verified by address
- State-first pattern: reputation updates before CPI to registry
- One-direction CPI chain: no circular dependencies
