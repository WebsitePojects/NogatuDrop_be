const ApiError = require('../utils/ApiError');
const { amountStillOwed } = require('./orderBalance');

function getPaymentVerificationDecision(order) {
  if (order?.payment_status === 'paid') {
    return { alreadyPaid: true };
  }
  if (order?.status !== 'approved') {
    throw ApiError.badRequest('Order must be in approved status');
  }
  if (!order?.payment_proof_url) {
    throw ApiError.badRequest('No payment proof has been uploaded');
  }
  // The delivery fee went up after the buyer's receipt: confirming now would mark the order paid while
  // the difference is still outstanding.
  const owed = amountStillOwed(order);
  if (owed > 0) {
    throw ApiError.conflict(
      `The buyer still owes ₱${owed.toFixed(2)} after the delivery fee change. Wait for their extra receipt.`
    );
  }
  return { alreadyPaid: false };
}

module.exports = { getPaymentVerificationDecision };
