const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
SESSION STATE (in-memory, keyed by account_id)

NOTE: keyed by account_id because Vapi's default tool-call payload does not
reliably include a stable call/session id on every tool invocation in every
config. This is fine for one call at a time (matches the demo), but two
simultaneous calls for the same account would collide. If your Vapi config
confirms a call id is available in message.call.id, switch the key to that
before a real deploy — it's the more correct fix.
*/

const sessions = {};

function getSession(accountId) {
  if (!sessions[accountId]) {
    sessions[accountId] = {
      verified: false,
      overdueAmount: null,
      ptpLogged: false,
      dispositionLogged: false
    };
  }
  return sessions[accountId];
}

function normalizeAccountId(accountId) {
  return String(accountId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* =========================================================
TOOL HANDLERS
Each handler takes the raw `arguments` object Vapi sends for
that tool call and returns a plain JS object result. The
webhook layer below is responsible for the Vapi envelope.
========================================================= */

function verifyCustomer(args) {
  const { account_id, verification_code } = args;

  const normalizedAccountId = normalizeAccountId(account_id);
  const normalizedCode = String(verification_code || "").replace(/\D/g, "");

  const expectedAccountId = "ACC88392";
  const expectedCode = "1234";

  const session = getSession(normalizedAccountId);

  if (normalizedAccountId === expectedAccountId && normalizedCode === expectedCode) {
    session.verified = true;
    return { status: "success", verified: true, message: "Customer identity verified successfully." };
  }

  // Explicitly reset on failure so a prior success can't linger.
  session.verified = false;
  return { status: "failed", verified: false, message: "Customer verification failed." };
}

function getAccountDetails(args) {
  const { account_id } = args;
  const normalizedAccountId = normalizeAccountId(account_id);

  if (normalizedAccountId !== "ACC88392") {
    return { status: "blocked", message: "Authentication required before accessing account details." };
  }

  const session = getSession(normalizedAccountId);

  if (!session.verified) {
    return { status: "blocked", message: "Customer has not been verified for this session." };
  }

  const overdueAmount = 8499;
  session.overdueAmount = overdueAmount;

  return {
    success: true,
    account_id: "ACC-88392",
    customer_name: "Rahul Sharma",
    loan_type: "Personal Loan",
    overdue_amount: overdueAmount,
    overdue_days: 12,
    currency: "INR"
  };
}

function logPromiseToPay(args) {
  const { account_id, amount, ptp_date } = args;
  const normalizedAccountId = normalizeAccountId(account_id);
  const session = getSession(normalizedAccountId);

  if (!session.verified) {
    return { success: false, message: "Cannot log a promise-to-pay for an unverified session." };
  }

  if (session.overdueAmount === null) {
    return { success: false, message: "Account details have not been retrieved for this session yet." };
  }

  if (Number(amount) !== session.overdueAmount) {
    console.warn(`PTP amount mismatch for ${normalizedAccountId}: got ${amount}, expected ${session.overdueAmount}`);
    return {
      success: false,
      message: `Amount does not match the account's recorded overdue amount (${session.overdueAmount}). Please confirm the correct amount with the customer.`
    };
  }

  console.log("PTP REQUEST:", { account_id, amount, ptp_date });

  session.ptpLogged = true;

  return {
    success: true,
    ptp_id: `PTP-${Math.floor(1000 + Math.random() * 9000)}`,
    account_id,
    confirmed_date: ptp_date,
    amount
  };
}

function sendPaymentLink(args) {
  const { account_id, channel } = args;
  console.log("PAYMENT LINK REQUEST:", args);

  const normalizedAccountId = normalizeAccountId(account_id);
  const session = getSession(normalizedAccountId);

  if (!session.verified) {
    return { success: false, message: "Customer must be verified before sending a payment link." };
  }

  if (session.overdueAmount === null) {
    return { success: false, message: "Account details must be retrieved before sending a payment link." };
  }

  if (!session.ptpLogged) {
    return { success: false, message: "A successful Promise-to-Pay must be logged before sending a payment link." };
  }

  const validChannels = ["SMS", "WhatsApp", "BOTH"];
  if (!validChannels.includes(channel)) {
    return { success: false, message: "Invalid channel. Use SMS, WhatsApp, or BOTH." };
  }

  return {
    success: true,
    account_id,
    channel,
    payment_link: "https://kapture-finance.example/pay/PTP-7755",
    message_id: `MSG-${Math.floor(10000 + Math.random() * 90000)}`,
    message: `Payment link sent via ${channel}.`
  };
}

function markDisposition(args) {
  const { account_id, status, notes } = args;
  const normalizedAccountId = normalizeAccountId(account_id);

  const validStatuses = [
    "PTP", "ALREADY_PAID", "DISPUTE", "DO_NOT_CALL", "WRONG_NUMBER",
    "WRONG_PERSON", "HARDSHIP", "CALLBACK_REQUEST", "HOSTILE", "NO_INPUT", "ESCALATED"
  ];

  if (!validStatuses.includes(status)) {
    return { success: false, message: "Invalid disposition status." };
  }

  const session = getSession(normalizedAccountId);
  session.dispositionLogged = true;

  // Mask PII in the log line instead of printing it raw.
  console.log("DISPOSITION:", {
    account_id: normalizedAccountId.replace(/.(?=.{4})/g, "*"),
    status,
    notes: notes ? "[notes recorded]" : ""
  });

  return {
    success: true,
    disposition_id: `DISP-${Math.floor(1000 + Math.random() * 9000)}`,
    account_id,
    status,
    notes: notes || "",
    recorded_at: new Date().toISOString()
  };
}

function escalateToAgent(args) {
  const { account_id, reason } = args;
  console.log("ESCALATION:", { account_id, reason });

  return {
    success: true,
    escalation_id: `ESC-${Math.floor(1000 + Math.random() * 9000)}`,
    account_id,
    reason,
    message: "Case successfully escalated to a human agent."
  };
}

const TOOL_HANDLERS = {
  verify_customer: verifyCustomer,
  get_account_details: getAccountDetails,
  log_promise_to_pay: logPromiseToPay,
  send_payment_link: sendPaymentLink,
  mark_disposition: markDisposition,
  escalate_to_agent: escalateToAgent
};

/* =========================================================
MAIN VAPI WEBHOOK
Vapi POSTs tool calls as:
  { message: { type: "tool-calls", toolCalls: [ { id, function: { name, arguments } } ] } }
and expects the response shaped as:
  { results: [ { toolCallId, result: <string> } ] }
`arguments` may arrive as an object or as a JSON string depending on
config, so we defensively parse it.
========================================================= */

app.post("/webhook", (req, res) => {
  const message = req.body && req.body.message;

  if (!message || message.type !== "tool-calls") {
    // Non-tool-call Vapi event (status updates, transcripts, etc.)
    return res.status(200).json({ status: "acknowledged" });
  }

  const toolCalls = message.toolCalls || [];

  const results = toolCalls.map((toolCall) => {
    const callId = toolCall.id;
    const name = toolCall.function && toolCall.function.name;
    let args = toolCall.function && toolCall.function.arguments;

    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (err) {
        args = {};
      }
    }
    args = args || {};

    console.log(`[Tool Call Received]: ${name}`, args);

    const handler = TOOL_HANDLERS[name];
    const result = handler ? handler(args) : { success: false, message: "Unknown function call" };

    return {
      toolCallId: callId,
      result: JSON.stringify(result)
    };
  });

  return res.status(200).json({ results });
});

/* =========================================================
VAPI END-OF-CALL EVENT
Handled on the same /webhook route via message.type, since Vapi
sends all event types to the single server URL configured for
the assistant. Kept here for clarity / direct testing.
========================================================= */

app.post("/vapi-events", (req, res) => {
  const message = req.body && req.body.message;

  if (message && message.type === "end-of-call-report") {
    Object.entries(sessions).forEach(([accountId, session]) => {
      if (session.verified && !session.dispositionLogged) {
        console.warn(`WARNING: call for ${accountId} ended with no disposition logged.`);
      }
    });
  }

  return res.status(200).json({ status: "acknowledged" });
});

/* =========================================================
DIRECT REST ROUTES (for manual/local testing with curl/Postman only)
These accept flat JSON bodies and are NOT what Vapi calls. They just
reuse the same handlers so you can sanity-check tool logic without
constructing the full Vapi envelope by hand.
========================================================= */

app.post("/test/verify_customer", (req, res) => res.json(verifyCustomer(req.body)));
app.post("/test/get_account_details", (req, res) => res.json(getAccountDetails(req.body)));
app.post("/test/log_promise_to_pay", (req, res) => res.json(logPromiseToPay(req.body)));
app.post("/test/send_payment_link", (req, res) => res.json(sendPaymentLink(req.body)));
app.post("/test/mark_disposition", (req, res) => res.json(markDisposition(req.body)));
app.post("/test/escalate_to_agent", (req, res) => res.json(escalateToAgent(req.body)));

/* =========================================================
HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Kapture Finance Maya Collections API" });
});

/* =========================================================
START SERVER
========================================================= */

app.listen(PORT, () => {
  console.log(`Kapture API server running on port ${PORT}`);
  console.log(`Vapi tool-call webhook: POST /webhook`);
});
