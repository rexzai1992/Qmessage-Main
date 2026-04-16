# Testing

## Test Framework

- Jest + ts-jest ESM preset (`jest.config.ts`)
- Test roots: `src` and `WAProto`

## Commands

```bash
# Unit/integration tests
npm test

# End-to-end tests (repo-specific E2E test files)
npm run test:e2e

# Lint
npm run lint

# TypeScript compile/build
npm run build

# Frontend build check
npm run build --prefix dashboard
```

## Current Test Coverage Footprint

Current repository test files (count from `src/__tests__`):

- `13` unit-style `.test.ts`
- `2` e2e-style `.test-e2e.ts`

Main covered areas:

- Signal and crypto/transport utility behavior
- message processing and media helpers
- sync action and history utility logic
- selected e2e send/receive and WA-web version flows

## Gaps

- No dedicated frontend component/unit test suite for `dashboard/src`.
- No API integration contract test suite for Express routes.
- No snapshot/visual regression tests.
- No dedicated migration validation tests.

## Recommended Test Additions

1. API route tests for auth guards and tenant scope enforcement.
2. Socket event contract tests (happy path + permission failures).
3. Frontend tests for login/session/subdomain guard behavior.
4. Scheduled broadcast worker behavior tests (claiming, retries, idempotency).
5. R2 upload path tests (size and MIME validation).
