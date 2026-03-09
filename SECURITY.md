# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: security@webberprotocol.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Bug Bounty

The bug bounty program is active on testnet. Scope includes:

### In Scope
- Smart contract vulnerabilities in `webber-registry` and `webber-token`
- Account substitution attacks
- Integer overflow/underflow
- Reentrancy
- Authority bypass
- Stake drain attacks
- Any vulnerability that could lead to loss of funds

### Out of Scope
- Frontend/UI bugs (no frontend yet)
- Social engineering
- Denial of service without economic impact
- Issues in third-party dependencies (report upstream)

## Development Standards

- All Solana programs written in Rust using the Anchor framework
- Anchor enforces account validation, ownership checks, and instruction discriminators
- No unchecked arithmetic — `checked_add`, `checked_mul`, `checked_div` throughout
- Reentrancy protection on all state-modifying instructions
- Authority checks on every privileged instruction
- PDAs for all program-owned accounts

## Audit Process

1. **Internal review** — All PRs reviewed by at least two community members
2. **Automated scanning** — Cargo Audit and Soteria on every commit via CI/CD
3. **Community audit** — Open bug bounty from day one on testnet
4. **External audit** — Formal third-party audit before mainnet, funded from community treasury
5. **Post-audit** — All findings published publicly regardless of severity

## Disclosure Policy

- We practice responsible disclosure
- Reporters will be credited (unless they prefer anonymity)
- We aim to fix critical issues within 72 hours
- All security findings are published after resolution
