# Phase 2 Acceptance Package — AML/CDD/KYC + Conflict Check Engine
**Lawcaspro** · Completed 2026-04-03

---

## 1. Scope

Phase 2 adds a full AML/CDD/KYC compliance intake layer and a conflict check engine on top of the existing Phase 1 case management platform.

| Area | Deliverable |
|---|---|
| Data model | 16 new tables, all tenant-isolated (RLS ON) |
| Backend | `routes/parties.ts`, `routes/compliance.ts`, `routes/conflict.ts` |
| Frontend | `CaseComplianceTab`, `PartyForm`, `BeneficialOwnerForm`, `CaseConflictPanel` |
| Tests | 102 tests across 8 test files — all passing |
| Hardening | tsx hot-reload dev mode, stale-dist guard on `start` |

---

## 2. Database Evidence

### 2.1 All 16 Phase 2 Tables Present with RLS

```
beneficial_owners            RLS ON
case_parties                 RLS ON
cdd_checks                   RLS ON
cdd_documents                RLS ON
compliance_profiles          RLS ON
compliance_retention_records RLS ON
conflict_checks              RLS ON
conflict_matches             RLS ON
conflict_overrides           RLS ON
parties                      RLS ON
pep_flags                    RLS ON
risk_assessments             RLS ON
sanctions_screenings         RLS ON
source_of_funds_records      RLS ON
source_of_wealth_records     RLS ON
suspicious_review_notes      RLS ON
```
(57 total tables; 16 are Phase 2 additions)

### 2.2 Foreign-Key Integrity
All FK relationships are enforced at the application layer (Drizzle ORM + firmId scoping on every query) rather than with DB-level FK constraints, consistent with the multi-tenant RLS pattern used throughout Phase 1.

---

## 3. Test Suite Results

```
Test Files  8 passed (8)
     Tests  102 passed (102)
  Duration  ~19 s (tsx, singleFork)
```

| File | Tests | Subject |
|---|---|---|
| `auth.test.ts` | 14 | Login, session, TOTP, reauth |
| `cases.test.ts` | 12 | Case CRUD, status transitions |
| `compliance.test.ts` | 32 | Full CDD/AML workflow |
| `conflict.test.ts` | 18 | Match detection, partner override |
| `ledger.test.ts` | 8 | Financial ledger |
| `payment-vouchers.test.ts` | 8 | Payment vouchers |
| `parties.test.ts` | 6 | Party CRUD + case linking |
| `misc.test.ts` | 4 | Misc routes |

---

## 4. API Evidence — Compliance Workflow (live DB)

### 4.1 Compliance Profile
Auto-created when a party is created; profile ID = party ID.

```
GET /api/compliance/profiles/38
→ partyId=38  cddStatus=enhanced_due_diligence_required
```

### 4.2 Risk Assessment
Risk factors, scoring, and EDD trigger:

| Factor | Points |
|---|---|
| `factorIsPep` | 30 |
| `factorHighRiskJurisdiction` | 25 |
| `factorComplexOwnership` | 20 |
| `factorNomineeArrangement` | 20 |
| `factorMissingSourceOfFunds` | 15 |
| `factorSuspiciousInconsistencies` | 25 |

Thresholds: ≥ 45 → `high`; ≥ 70 → `very_high`; EDD triggered if PEP OR highRiskJurisdiction OR score ≥ 45.

```
POST /api/compliance/profiles/38/risk-assessment
Body: { factorIsPep:true, factorHighRiskJurisdiction:true, factorMissingSourceOfFunds:true, … }
→ riskScore=70  riskLevel=very_high  eddTriggered=true
```

### 4.3 Sanctions Screening
```
POST /api/compliance/profiles/38/sanctions-screening
Body: { screeningSource:"UN", result:"clear", notes:"…" }
→ id=29  source=UN  result=clear
```
Supported sources: `OFAC | UN | INTERPOL | Malaysia_BNM | manual`

### 4.4 PEP Flag
```
POST /api/compliance/profiles/38/pep-flags
Body: { position:"Member of Selangor State Legislative Assembly (ADUN)", pepCategory:"domestic", startDate:"2018-05-15" }
→ id=14  pepCategory=domestic  position=Member of Selangor State Legislative Assembly (ADUN)
```
Categories: `domestic | foreign | international_organization`

### 4.5 Source of Funds
```
POST /api/compliance/profiles/38/source-of-funds
Body: { sourceType:"employment", description:"Monthly salary…", estimatedAmount:"15000", currency:"MYR" }
→ id=17  sourceType=employment  amount=15000 MYR
```
Source types: `employment | business_income | investment | inheritance | gift | loan | sale_of_asset | other`

---

## 5. API Evidence — Conflict Check Engine (live DB)

Full five-step flow executed against live data:

### Step A — NRIC Conflict Detected
```
POST /api/conflict/check
Body: { caseId:6, parties:[{ name:"Razif bin Hamzah", identifier:"700101-55-4321", identifierType:"nric", role:"purchaser" }] }
→ check.id=44  overallResult=blocked_pending_partner_override
→ match.id=32  matchType=nric
```

### Step B — Partner Issues Re-Auth Token
```
POST /api/auth/reauth-token
Body: { password:"lawyer123" }
→ reAuthToken=6f02946ad9bc7a083a82… (64 chars)
```

### Step C — Override Rejected Without Re-Auth (security gate)
```
POST /api/conflict/checks/44/override  (no x-reauth-token header)
→ HTTP 403
```

### Step D — Partner Override Accepted (with x-reauth-token)
```
POST /api/conflict/checks/44/override
Headers: x-reauth-token: <token>
Body: { conflictMatchId:32, overrideReason:"Verified by partner — opposing party in different transaction…" }
→ override.id=6  overriddenBy=2
```

### Step E — Check Resolves to no_match
```
GET /api/conflict/checks/44
→ overallResult=no_match  (1 override record present)
```

### 5.1 Security Controls Verified
| Rule | Result |
|---|---|
| Non-partner cannot override (regular lawyer) | HTTP 403 |
| Override without re-auth header | HTTP 403 |
| Override with valid re-auth from partner | HTTP 201 |
| Check auto-resolves after all blocked matches overridden | `no_match` |

### 5.2 Match Detection Methods
| Method | Identifier type | Priority score |
|---|---|---|
| NRIC/passport/company_reg exact | `nric \| passport \| company_reg` | 5 |
| Name exact (normalised) | `name_exact` | 3 |
| Name fuzzy (trigram-style) | `name_fuzzy` | 1 |

Dedup key: `partyName|matchedCaseId`; higher-priority match wins when same key exists.

---

## 6. Build / Release Hardening

### Problem Solved
Previously `dev` ran `pnpm build && start` — one-time build. Source changes during development required a manual workflow restart to take effect, risking stale-dist mismatches.

### Solution

| Script | Command | When |
|---|---|---|
| `dev` | `tsx watch src/index.ts` | Replit development; hot-reloads on every source save |
| `build` | `node build.mjs` | Production bundle (esbuild, ~1.5 s) |
| `start` | `node scripts/check-dist.mjs && node --enable-source-maps ./dist/index.mjs` | Production / Replit Deploy |
| `preview` | `pnpm build && pnpm start` | Test the compiled bundle locally |
| `test` | `vitest run` | Reads source directly via tsx — no build needed |

### Stale-Dist Guard (`scripts/check-dist.mjs`)
Called automatically before every `start`. Compares `dist/index.mjs` mtime against newest `.ts` source file. Exits 1 with a clear error if dist is older, preventing deployment of stale code.

---

## 7. Seed Credentials

| Role | Email | Password |
|---|---|---|
| Partner | partner@tan-associates.my | lawyer123 |
| Lawyer | lawyer@tan-associates.my | lawyer123 |
| Clerk | clerk@tan-associates.my | clerk123 |
| Founder | lun.6923@hotmail.com | founder123 |

---

## 8. Known Bugs Fixed During Phase 2

| # | Bug | Fix |
|---|---|---|
| 1 | `createTestCase` format mismatch in conflict tests | Changed to `assignedLawyerId` + `purchasers:[{name,ic}]` |
| 2 | Missing `.returning()` on conflict match insert → `blockedMatchId=undefined` | Added `.returning()` to all `db.insert().values()` calls in conflict engine |
| 3 | Dedup key `(partyName, matchedCaseId, matchType)` produced double-blocked-matches | Changed dedup key to `(partyName, matchedCaseId)` with identifier-type priority |
