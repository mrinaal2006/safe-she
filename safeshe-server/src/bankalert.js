'use strict';
/**
 * Reads an Indian bank / UPI "money received" SMS or notification and returns { amount, utr, vpa }.
 * Used to confirm riders' UPI payments to the admin automatically: a payment is confirmed only when
 * the admin's bank alert has the same UPI reference (UTR) and the same amount the rider submitted.
 *
 * Examples it understands:
 *   "Dear UPI user A/C X1234 credited by Rs.90.00 on 06Nov26 by sender@ybl (Ref no 512345678901) -SBI"
 *   "Rs. 90.00 credited to HDFC Bank A/c XX1234 on 06-11-26 from VPA sender@ybl (UPI 512345678901)"
 *   "ICICI Bank Acct XX123 credited with Rs 90.00 on 06-Nov-26; SENDER credited. UPI:512345678901"
 *   "INR 90.00 credited to A/c no. XX1234 on 06-11-26 at 10:15:01 IST. Info- UPI/P2A/512345678901/SENDER - Axis Bank"
 *   "Received Rs.90.00 in your Kotak Bank a/c X1234 from sender@ybl on 06-11-26. UPI Ref:512345678901"
 *   "You've received ₹90 from Sender. UPI Ref No. 512345678901" (UPI app notification)
 */
const CREDIT = /\b(credited|received|deposited|credit(?:ed)? alert|has been added|added to)\b/i;
// "debited ... credited to <someone else>" is a payment the admin made, not one received.
const DEBIT_FIRST = /\b(debited|sent|paid|withdrawn|spent)\b/i;
const AMOUNT = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const UTR_LABELLED = /(?:upi\s*ref(?:erence)?\.?\s*(?:no\.?|number|id)?|ref(?:erence)?\.?\s*(?:no\.?|number|id)?|rrn|utr(?:\s*no\.?)?|txn\s*id|upi)\s*[:.\-#]?\s*([0-9]{12})\b/i;
const UTR_IN_PATH = /\bupi\/[a-z0-9]+\/([0-9]{12})\b/i;
const ANY_12 = /(?<![0-9])([0-9]{12})(?![0-9])/;
const VPA = /\b([a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64})\b/i;

function parseBankSms(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 1000 || !CREDIT.test(t)) return null;
  const c = t.search(CREDIT), d = t.search(DEBIT_FIRST);
  if (d >= 0 && d < c) return null;
  const a = t.match(AMOUNT); if (!a) return null;
  const amount = Math.round(parseFloat(a[1].replace(/,/g, '')) * 100) / 100;
  if (!(amount > 0)) return null;
  const u = t.match(UTR_LABELLED) || t.match(UTR_IN_PATH) || t.match(ANY_12);
  if (!u) return null;
  const v = t.match(VPA);
  return { amount, utr: u[1], vpa: v ? v[1].toLowerCase() : null };
}

module.exports = { parseBankSms };
