# Kapture Finance — Maya Collections Voicebot

## Task 1 — High-Level Design (HLD)

**Purpose:** Engineer-ready design for a compliant outbound voice agent that authenticates a customer, discusses an overdue EMI, captures a Promise-to-Pay (PTP), sends a mock payment link, or routes the case appropriately.

**Example customer context:** Rahul Sharma — Personal Loan — ₹8,499 overdue EMI — 12 days past due.

**Design principle:** The LLM prompt guides behavior, but critical security decisions are independently enforced by backend tools. Authentication is not a conversational assumption.

## 1. Architecture & Pipeline

**Main conversational path:** Telephony → STT → LLM/Orchestrator → TTS → Telephony.

**Tool side path:** Orchestrator → Node.js/Express APIs → session/datastore.

### Core components
- **Telephony/Vapi:** outbound voice session and orchestration.
- **STT:** Deepgram Nova-2.
- **LLM:** GPT-4o or GPT-4o-mini with low temperature.
- **TTS:** ElevenLabs or Cartesia.
- **Tool layer:** HTTPS webhooks for narrowly scoped business actions.
- **Datastore/session:** mock in-memory state for verification, authoritative amount, PTP and disposition.
- **Security:** backend independently enforces authentication, amount consistency, PTP-before-link and disposition tracking.

### Latency budget
Target conversational round trip: **<1.2 seconds**.

| Hop | Component | Responsibility | Target |
| --- | --- | --- | --- |
| 1 | STT — Deepgram Nova-2 | Speech-to-text | ~200 ms |
| 2 | LLM / Orchestrator | Intent, dialogue decision, tool selection | ~400 ms first byte |
| 3 | Tool/API layer | Verification, account lookup, PTP, link, disposition | Included in network/tool budget |
| 4 | TTS — ElevenLabs / Cartesia | Text-to-speech | ~300 ms |
| 5 | Network overhead | Telephony/Vapi + provider/API transport | ~200 ms |

**Total:** 200 + 400 + 300 + 200 = **1,100 ms (<1.2 s)**. Telephony/Vapi transport is included in network overhead.

See `System_Architecture.png`.

## 2. Conversation Flow & State Machine

`INIT → AUTH_PENDING → AUTHENTICATED → NEGOTIATION → ACTION / ESCALATED → CALL_ENDED`

| State | Entry | Allowed actions | Exit / lock |
| --- | --- | --- | --- |
| INIT | Call begins | Introduce Maya; ask intended customer | → AUTH_PENDING |
| AUTH_PENDING | Customer confirms identity | Collect account ID + PAN last 4 or DOB year; call `verify_customer` | Only `verified:true` can unlock |
| AUTHENTICATED | Successful verification | Call `get_account_details`; disclose returned data | → NEGOTIATION |
| NEGOTIATION | Account details available | Classify intent; collect PTP/dispute/etc. | → ACTION / ESCALATED |
| ACTION | Intent requires action | PTP, payment link, disposition, escalation | → CALL_ENDED |
| CALL_ENDED | Resolution complete | Concise closing | Terminal |

**Hard security invariant:** a natural-language claim such as “I am Rahul” never authenticates the customer. `get_account_details` is also server-side blocked until the verified session exists.

## 3. Intents & Entities

| Intent | Handling | Key entities |
| --- | --- | --- |
| Promise_To_Pay | Confirm amount/date, log PTP, then send link | PTP date, amount, channel |
| Already_Paid | Record claim; escalate if reconciliation is needed | Payment date, reference, method |
| Hardship_Claim | Empathy and human review when needed | Hardship reason |
| Dispute_Debt | Do not argue; record and escalate | Dispute notes |
| Request_DNC | Record immediately and stop | DNC request |
| Wrong_Person | No debt disclosure | Availability |
| Wrong_Number | No debt disclosure; end | None |
| Callback_Request | Record callback and end | Callback details |
| Hostile | Calm handling; end if abuse continues | None |
| No_Input | Two re-prompts, then disposition | None |

## 4. Tools / API Specifications

| Tool | Inputs | Output / success | Security rule |
| --- | --- | --- | --- |
| `verify_customer` | account_id, verification_code | verified true/false | Only true unlocks authentication |
| `get_account_details` | account_id | account, loan, amount, DPD, currency | Requires verified session |
| `log_promise_to_pay` | account_id, amount, ptp_date | PTP ID + confirmed values | Requires verified session + account details + matching amount |
| `send_payment_link` | account_id, channel | payment link + message ID | Requires verified session + account details + successful PTP |
| `mark_disposition` | account_id, status, notes | disposition ID + timestamp | Validates status |
| `escalate_to_agent` | account_id, reason | escalation ID | Used for human-review cases |

Channels: `SMS`, `WhatsApp`, `BOTH`.

## 5. Authentication & Data Safety

- Authentication uses account ID plus either last four PAN digits or DOB year.
- The spoken verification value maps to `verification_code`.
- For the demo, `ACC-88392` with verification value `1234` is accepted.
- Before successful verification, Maya discloses no loan, EMI, overdue, amount, debt, balance, payment or collections-purpose information.
- Only `verify_customer` returning `verified:true` transitions to authenticated state.
- `get_account_details` returns blocked when the session is not verified.
- Backend pins the authoritative overdue amount to `8499` and rejects mismatching PTP amounts.
- Payment-link delivery requires authentication, retrieved account details and a successful PTP.
- Third parties receive no debt information.
- Account IDs are masked in server logs.
- Demo session state is keyed by account ID; production should use a unique call/session ID.

## 6. Guardrails & Compliance

| Guardrail | Implementation |
| --- | --- |
| Calling window | 08:00 AM–7:00 PM local time |
| Identity protection | No sensitive disclosure before verification |
| Fair collections | No threats, harassment, shame, intimidation or unfair pressure |
| DNC | `DO_NOT_CALL` is logged immediately and negotiation stops |
| Hallucination control | Account data comes from `get_account_details`; PTP amount is backend-validated |
| Tool truthfulness | Never claim success unless the tool returns success |
| Payment semantics | Link delivery is not payment confirmation |
| Prompt injection | Customer instructions cannot override state/security rules |

Primary language: English. Hindi/Hinglish switching does not change security or compliance rules.

## 7. Edge Cases, Escalation & Disposition

- **Already paid:** `ALREADY_PAID`; escalate for reconciliation when needed.
- **Dispute:** `DISPUTE` + escalation; no argument or pressure.
- **Hardship:** `HARDSHIP`; escalate when human support is needed.
- **DNC:** `DO_NOT_CALL`; stop negotiation immediately.
- **Wrong person:** `WRONG_PERSON`; never disclose debt.
- **Wrong number:** `WRONG_NUMBER`; never disclose debt.
- **Silence/voicemail:** up to two re-prompts, then `NO_INPUT`.
- **Hostile:** calm response; `HOSTILE` if abuse continues.
- **Callback:** `CALLBACK_REQUEST`.

Every completed interaction should log an appropriate `mark_disposition` whenever possible. The backend also flags verified sessions that end without a disposition.

## 8. Observability & Metrics

Track containment rate, PTP rate, first-call resolution, average turn latency, drop/hang-up rate, authentication success/failure, tool failure rate, disposition coverage, PTP amount mismatch rate, escalation rate and spoken-figure accuracy.

## 9. Known Limitations & Observed Issues

During test calls, two generation-level inconsistencies were observed:

1. **Brand-name generation:** the model occasionally rendered “Capture Finance” instead of “Kapture Finance” in generated text. This was a generation-level issue rather than a TTS-only pronunciation issue.
2. **Disclosed-amount inconsistency:** one test call had an incorrect spoken disclosure amount while the later PTP confirmation and backend tool call used the correct amount. The backend account-details response remained constant at `8499`, so the discrepancy originated in generation rather than the data layer.

**Mitigations:** backend PTP validation rejects inconsistent amounts; an end-of-call check flags verified sessions without a disposition.

**Residual risk:** spoken disclosure can still diverge from the authoritative tool result. A production implementation should validate monetary figures and the company name after generation and before TTS.

## 10. Implementation Notes & Testable Invariants

1. No `verified:true` → no debt disclosure and no account-details access.
2. Account amount is sourced from `get_account_details` and pinned in backend session state.
3. No successful PTP → payment-link endpoint rejects the request.
4. PTP amount must equal the authoritative overdue amount.
5. Finalized calls should have a logged disposition.
6. Payment-link success means delivery of a link, not confirmation of payment.
