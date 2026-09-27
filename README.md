# Arc Rep

**Arc Rep** is Arc-native wallet reputation and verification infrastructure.

It allows a wallet to establish verifiable evidence of meaningful participation in the Arc ecosystem. Arc Rep exposes this information through a JSON API to both users and third-party Arc projects.

---

## Architecture Overview

Arc Rep is organized into five layers with strict boundaries:

```
┌─────────────────────────────────────────────────────────┐
│  FRONTEND  src/                                         │
│  React + Vite. Consumes /api/* only. No RPC calls.      │
├─────────────────────────────────────────────────────────┤
│  API LAYER  server/routes/                              │
│  GET /profile/:address                                  │
│  GET /signals/:address                                  │
│  GET /credentials/:address                              │
│  POST /verify  (stub, 501)                              │
│  GET /health                                            │
├─────────────────────────────────────────────────────────┤
│  PROFILE SERVICE  server/domain/profile/                │
│  Assembles WalletProfile from all lower layers.         │
├───────────────────────┬─────────────────────────────────┤
│  SIGNAL ENGINE        │  CREDENTIAL SERVICE             │
│  server/domain/       │  server/domain/credentials/     │
│  signals/             │  System-derived credentials     │
│  Receives normalized  │  only (Phase 1)                 │
│  activity + registry. ├─────────────────────────────────┤
│  Returns signals.     │  VERIFICATION SERVICE (stub)    │
│                       │  server/domain/verification/    │
├───────────────────────┴─────────────────────────────────┤
│  APPLICATION REGISTRY  server/domain/applications/      │
│  Maps contract addresses → Application + Category       │
│  Distinguishes recognized from unknown contracts        │
├─────────────────────────────────────────────────────────┤
│  ACTIVITY PROVIDER  server/data/                        │
│  IActivityProvider interface + ArcRpcProvider impl      │
│  Sole responsibility: fetch + normalize wallet activity │
└─────────────────────────────────────────────────────────┘
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full layer diagram, data flow, and extension points.

---

## Data Flow

```
GET /profile/:address
        │
        ▼
ArcRpcProvider.getActivity(address)
        │  returns NormalizedActivity
        ▼
ApplicationRegistry.resolveContracts(addresses)
        │  returns Map<address, ResolutionResult>
        ▼
SignalEngine.calculate(activity, registry)
        │  returns ActivitySignal[]
        ▼
CredentialService.evaluate(signals)
        │  returns Credential[]
        ▼
ProfileService.assemble(...)
        │  returns WalletProfile
        ▼
JSON response → frontend
```

---

## Getting Started

```bash
# Install dependencies
bun install

# Start the backend API server (port 3001)
bun run start

# Start the Vite frontend (port 5173, proxies /api → 3001)
bun run dev

# Run tests
bun test tests/
```

---

## Project Structure

```
server/
├── data/                       # Data access layer
│   ├── IActivityProvider.ts    # Provider interface
│   ├── ArcRpcProvider.ts       # Arc RPC implementation
│   └── types.ts                # RawTransaction, NormalizedActivity
├── domain/
│   ├── types.ts                # All canonical entity types
│   ├── applications/           # Application registry layer
│   ├── signals/                # Signal engine + calculators
│   ├── credentials/            # Credential service
│   ├── profile/                # Profile assembly
│   └── verification/           # Stub (Phase 2)
├── routes/                     # Express route handlers
├── middleware/                 # Address validation
└── index.ts                    # Express entry point

src/
├── components/                 # React components
├── hooks/                      # Data-fetching hooks
├── types/api.ts                # Frontend API types (no server internals)
└── App.tsx                     # Router + shell

tests/
├── domain/                     # Unit tests for domain layers
└── data/                       # Provider tests
```

---

## Design Principles

1. A wallet is not necessarily a person.
2. Observable wallet behavior is never automatically treated as proof of trustworthiness.
3. Raw transaction count is never used as a standalone reputation score.
4. Every derived signal carries its source, formula, observation period, and confidence.
5. The frontend makes no direct RPC calls — all data flows through the server API.
6. The provider abstraction (`IActivityProvider`) isolates blockchain data access from domain logic.
7. Derived signals never masquerade as raw blockchain facts.
8. No reputation score or ranking is produced in Phase 1.

---

## What Is Intentionally Not Implemented

| Feature | Reason |
|---|---|
| Reputation score / composite score | Principle 9: no scoring formula in Phase 1 |
| Wallet ranking / leaderboard | Principle 3: raw activity is not standing |
| Smart contract for storing scores | Principle 8: read-oriented in Phase 1 |
| Project-issued credentials | Phase 2 (model is typed and ready) |
| Contract-attested credentials | Phase 2 |
| Privacy-preserving verification (ZK) | Phase 2 / long-term |
| Admin interface | Architecture prepared; no routes/UI yet |
| Sybil detection | Out of scope for Phase 1 |
| Goldsky / subgraph provider | `IActivityProvider` makes this a swap |
| Database persistence | In-memory registry; Postgres extension noted |

---

## Known Data Limitations

- **Snapshot completeness**: The Arc RPC returns transactions via `eth_getTransactionByHash` per-block scan, which is paginated. Snapshots may be truncated (`mayBeTruncated: true`) for high-activity wallets. Signals on truncated snapshots are marked `partial`.
- **Application registry**: The registry is seeded with known Arc ecosystem contracts only. Unknown contracts are never silently treated as recognized applications.
- **Economic activity**: Reported as raw `valueWei` sum of outgoing succeeded transactions. This is a measurement of value transferred in the native gas token (USDC on Arc), not an assessment of its significance.
- **Consistency signal**: Requires at least 2 outgoing transactions. Fewer than 5 are marked `partial` due to low statistical confidence.

---

## Running Tests

```bash
bun test tests/
```

Tests cover:
- Address validation (valid + 6 invalid forms)
- Application registry (recognized vs unknown, case-insensitivity, bulk resolution)
- All implemented signal calculators (including edge cases)
- Credential evaluation per credential type
- ProfileService assembly and no-score guarantee
- Provider interface contract
