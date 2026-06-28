const ApiError = require('../utils/ApiError');

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
  return { alreadyPaid: false };
}

module.exports = { getPaymentVerificationDecision };
