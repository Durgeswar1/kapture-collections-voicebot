# MAYA — Kapture Finance Collections Agent

An outbound Voice AI Collections Agent built on Vapi.ai for Kapture Finance. Maya authenticates customers before disclosing any debt information, negotiates a Promise-to-Pay, sends payment links, and logs a call disposition for every completed interaction.

## Architecture

Customer (phone/web) → Vapi (Deepgram STT → GPT-4o → ElevenLabs/Cartesia TTS) → Mock Webhook Server (Node.js/Express) → Response back to caller.

The system follows a strict state machine:
`INIT → AUTH_PENDING → AUTHENTICATED → NEGOTIATION → ACTION → CALL_ENDED`

Authentication is enforced in two places, not just the prompt:
- The system prompt instructs the model never to disclose debt information before `verify_customer` returns `verified: true`.
- The backend independently enforces this: `get_account_details` checks that the session was actually verified, not just that the account ID is correct — so debt details can't leak even if the model mishandles a turn.

## Key design decision: LLM vs. backend responsibility

The LLM (Maya) handles natural conversation — greeting, intent recognition, empathy, negotiation. The backend server is the source of truth for anything compliance-critical: authentication state, the real overdue amount, and disposition logging. This split exists because testing showed prompt instructions alone are not fully reliable — see Known Limitations below.

## Tools

| Tool | Purpose |
|---|---|
| `verify_customer` | Authenticates the caller via account ID + PAN/DOB |
| `get_account_details` | Returns account info — only if the session is verified |
| `log_promise_to_pay` | Records a PTP — validated server-side against the real overdue amount before accepting |
| `send_payment_link` | Sends a mock payment link via SMS/WhatsApp |
| `mark_disposition` | Logs the final call outcome |
| `escalate_to_agent` | Routes disputes, hardship, and already-paid cases to a human |

## Test scenarios covered (see demo video)

1. **Happy path** — Greeting → Auth → Debt disclosure → PTP confirmed → Payment link sent (SMS + WhatsApp)
2. **Wrong person** — Caller is not the target customer → no debt disclosed → disposition logged as `WRONG_PERSON`
3. **Already paid** — Authenticated customer claims prior payment → no new PTP created → disposition logged as `ALREADY_PAID`
4. **Failed verification** — Incorrect account ID → access blocked, no account details returned

## Known limitations

During testing, the model occasionally mis-stated the company name ("Capture" instead of "Kapture") and, in one instance, the disclosed overdue amount — despite the backend tool returning the correct value. Because prompt-only fixes did not fully eliminate this, backend validation was added specifically to prevent it from reaching compliance-critical actions:

- `log_promise_to_pay` rejects any PTP amount that doesn't match the account's actual overdue amount, so a hallucinated figure can never be logged as a real payment commitment.
- An end-of-call check flags any completed, authenticated call where `mark_disposition` was never called, so a call can't silently close without an outcome on record.

The remaining risk is narrow: what Maya *says out loud* to the customer during disclosure can still occasionally be wrong even though the underlying data and logged records stay correct. A production version would add a post-generation check that validates spoken figures against the tool result before the response is sent to TTS.

## Tech stack

Vapi.ai (orchestration), Deepgram Nova-2 (STT), GPT-4o (LLM), ElevenLabs/Cartesia (TTS), Node.js/Express (mock backend), ngrok (tunneling).
