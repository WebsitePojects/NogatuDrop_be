const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { isMlmBridgeConfigured, verifyMlmMemberCredentials } = require('./mlmBridge');

// Nogatu Alliance member discount on store products (not shipping). A member proves who they are with their
// nogatualliance.com username AND password; nogatualliance.com checks them and we hand the browser a short-lived
// signed member pass. The order applies the discount only for a valid pass, so typing someone else's
// username gets nothing (2026-11-23; it used to trust a bare username).
const MEMBER_DISCOUNT_PCT = 30;
const MEMBER_PASS_TTL = '30m';
const MEMBER_PASS_AUDIENCE = 'nogatu-store-member-discount';

// A key of its own, derived from JWT_SECRET, so a staff login token can never pass as a member pass (and the
// reverse) and no extra secret has to be configured on each server.
let passKey;
function memberPassKey() {
  if (!passKey) {
    passKey = Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'nogatu-store', MEMBER_PASS_AUDIENCE, 32));
  }
  return passKey;
}

/** Whether checkout offers the member sign-in at all (off until the MLM bridge is configured). */
function isMemberDiscountEnabled() {
  return isMlmBridgeConfigured();
}

function signMemberPass(member) {
  return jwt.sign({ uid: member.uid, username: member.username }, memberPassKey(), {
    algorithm: 'HS256',
    audience: MEMBER_PASS_AUDIENCE,
    expiresIn: MEMBER_PASS_TTL,
    subject: `mlm:${member.uid}`,
  });
}

/**
 * Checks the member's nogatualliance.com credentials and returns { member_pass, username, discount_pct,
 * expires_in_seconds }. Wrong credentials and inactive accounts get the same answer, so the check cannot be
 * used to find out which usernames exist.
 */
async function verifyMemberForDiscount(username, password) {
  if (!isMemberDiscountEnabled()) {
    throw ApiError.serviceUnavailable('The member discount is not available yet.');
  }
  const result = await verifyMlmMemberCredentials(username, password);
  if (result.status === 'unavailable') {
    throw ApiError.serviceUnavailable('We could not reach Nogatu Alliance to check your membership. Try again, or order without the discount.');
  }
  if (result.status !== 'verified' || result.member.account_status.toLowerCase() !== 'active') {
    throw ApiError.unauthorized('That username and password did not match an active Nogatu Alliance member.');
  }
  return {
    member_pass: signMemberPass(result.member),
    username: result.member.username,
    discount_pct: MEMBER_DISCOUNT_PCT,
    expires_in_seconds: 30 * 60,
  };
}

/** The member a pass belongs to, or a 400 telling the buyer to sign in again. Never trusts an unsigned name. */
function readMemberPass(memberPass) {
  try {
    const claims = jwt.verify(String(memberPass), memberPassKey(), {
      algorithms: ['HS256'],
      audience: MEMBER_PASS_AUDIENCE,
    });
    return { uid: String(claims.uid), username: String(claims.username) };
  } catch {
    throw ApiError.badRequest('Your member sign-in has expired. Sign in again for the member discount, or remove it to order at the regular price.');
  }
}

module.exports = {
  MEMBER_DISCOUNT_PCT,
  isMemberDiscountEnabled,
  verifyMemberForDiscount,
  readMemberPass,
  signMemberPass,
};
