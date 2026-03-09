# Capability Marketplace Design — Phase 2 Build 1

**Date:** 2026-03-09
**Status:** Approved

## Overview

New `webber-marketplace` Anchor program. Agents post services priced in $WEB, other agents discover and pay atomically. Every payment burns 0.5% via CPI to webber-token.

## Approach

CPI to `webber_token::transfer_with_burn` for all payments. Single source of truth for burn logic. Cross-program reads of `webber_registry::AgentAccount` to validate provider registration.

## Accounts

### MarketplaceState
- PDA seeds: `["marketplace_state"]`
- Fields: listing_id_counter (u64), total_volume (u64), total_burned (u64), total_transactions (u64), bump (u8)
- Space: 41 bytes

### ServiceListing
- PDA seeds: `["listing", provider.key, listing_id.to_le_bytes()]`
- Fields: provider (Pubkey), listing_id (u64), capability_type (u8 enum), price_per_call (u64), price_subscription (u64), title (String 64), description_uri (String 128), is_active (bool), total_calls (u64), created_at (i64), bump (u8)
- Space: 291 bytes

### ServiceTransaction
- PDA seeds: `["transaction", listing.key, buyer.key, tx_id.to_le_bytes()]`
- tx_id from global state total_transactions counter (pre-increment)
- Fields: listing (Pubkey), buyer (Pubkey), provider (Pubkey), amount_paid (u64), amount_burned (u64), status (u8 enum), timestamp (i64), bump (u8)
- Space: 138 bytes

## Enums

```
CapabilityType: DataRetrieval=0, Computation=1, Execution=2, Analysis=3, Routing=4, Custom=5
TransactionStatus: Pending=0, Completed=1, Disputed=2, Resolved=3
```

## Instructions

### initialize_marketplace
- One-time setup. Creates MarketplaceState PDA with all counters at 0.
- Authority: any payer (first caller)

### create_listing
- Signer: provider
- Validates: provider has active AgentAccount in webber-registry (read PDA, check unstake_requested_at is None)
- Reads listing_id_counter from MarketplaceState, increments it
- At least one price > 0
- Creates ServiceListing PDA
- Emits CreateListing event

### update_listing
- Owner-only (provider must match listing.provider)
- Can update: price_per_call, price_subscription, description_uri, is_active
- Cannot change: capability_type, provider, listing_id
- Emits UpdateListing event

### close_listing
- Owner-only. Sets is_active = false (soft delete)
- Emits CloseListing event

### execute_payment
- Buyer signs, pays provider through protocol
- Validates: listing is_active, provider AgentAccount still valid
- State updates BEFORE CPI (reentrancy protection):
  - Create ServiceTransaction
  - Increment listing.total_calls
  - Increment global_state.total_transactions, total_volume
  - Calculate burn amount, store in transaction and increment global_state.total_burned
- CPI to webber_token::transfer_with_burn(amount)
- Emits PaymentExecuted event

### open_dispute
- Buyer-only (must be buyer on transaction)
- Transaction must be Completed status
- Within 24h window: current_time - transaction.timestamp < 86400
- Sets status to Disputed
- Emits DisputeOpened event

## Cross-Program Dependencies

```
webber-marketplace ──reads──> webber-registry::AgentAccount (validate registration)
webber-marketplace ──CPIs──> webber-token::transfer_with_burn (atomic payment)
```

## Error Codes

| Code | Description |
|------|-------------|
| NotRegisteredAgent | Provider not registered in webber-registry |
| InsufficientStake | Agent stake too low |
| ListingNotActive | Listing paused or closed |
| InvalidPrice | Price is zero for both pricing types |
| InsufficientFunds | Buyer doesn't have enough $WEB |
| DisputeWindowClosed | 24h dispute window expired |
| NotTransactionParty | Caller not buyer/provider |
| ArithmeticOverflow | Checked math failed |
| Unauthorized | Not the listing owner |
| InvalidTransactionStatus | Transaction not in expected status |

## Events

```rust
CreateListing { provider, listing_id, capability_type, price_per_call }
UpdateListing { listing_id, price_per_call, is_active }
CloseListing { listing_id }
PaymentExecuted { listing_id, buyer, provider, amount_paid, amount_burned, tx_id }
DisputeOpened { tx_id, buyer, provider }
```
