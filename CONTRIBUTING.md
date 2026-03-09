# Contributing to Webber Protocol

Webber is open source and community-driven. Every contribution matters.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `yarn install`
4. Build: `anchor build`
5. Run tests: `anchor test`

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code. Protected. Requires PR + review. |
| `develop` | Integration branch. Features merge here first. |
| `feature/*` | Individual feature branches (e.g., `feature/agent-registry`) |
| `fix/*` | Bug fix branches |
| `audit/*` | Audit-specific branches. Frozen during external audit. |

## Contribution Process

1. Create a `feature/` or `fix/` branch from `develop`
2. Write code with tests. **All programs must have >80% test coverage.**
3. Run `anchor test` — all tests must pass
4. Submit a PR to `develop` with a clear description of what and why
5. At least two community approvals required for merge

## Code Standards

- All Solana instructions must validate all account owners and discriminators
- No `panic!` macros in production code — use proper error handling
- Custom error codes for every failure case — no generic errors
- All public functions must have doc comments
- Use checked arithmetic throughout (`checked_add`, `checked_mul`, `checked_div`)
- Run `anchor test` before every commit

## Commit Messages

Use conventional commits:

```
feat: add agent reputation scoring
fix: correct burn calculation for zero amounts
docs: update registry API documentation
test: add edge case tests for unstaking cooldown
chore: update Anchor to 0.31.1
```

## Testing Requirements

- Every new instruction needs at least 3 tests: happy path, error case, edge case
- Integration tests for cross-program interactions
- Use the local validator (`anchor test` handles this automatically)

## Bug Reports

Use the GitHub issue template. Include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Transaction signatures (if applicable)
- Solana CLI and Anchor versions

## Security

Found a vulnerability? **Do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Incentives

Contributors are rewarded from the Ecosystem Rewards allocation (200M $WEB):
- Bounties for specific features or fixes
- Retroactive rewards for significant contributions
- Hackathon prizes for best agents built on Webber
- On-chain contributor recognition
