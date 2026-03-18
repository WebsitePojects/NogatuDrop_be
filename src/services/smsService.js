const axios = require('axios');
const env = require('../config/env');

const SMS_TEMPLATES = {
  LOW_STOCK: (product, warehouse, stock) =>
    `[Nogatu NCDMS] LOW STOCK ALERT: ${product} at ${warehouse} is down to ${stock} units. Replenishment recommended.`,
  NO_STOCK: (product, warehouse) =>
    `[Nogatu NCDMS] OUT OF STOCK: ${product} at ${warehouse} has reached 0 units. Immediate action required.`,
  NEW_ORDER: (orderNumber, partnerName) =>
    `[Nogatu NCDMS] New order ${orderNumber} received from ${partnerName}. Please review and approve.`,
  ORDER_APPROVED: (orderNumber) =>
    `[Nogatu NCDMS] Your order ${orderNumber} has been approved. Please proceed with payment.`,
  ORDER_REJECTED: (orderNumber, reason) =>
    `[Nogatu NCDMS] Your order ${orderNumber} has been rejected. Reason: ${reason || 'N/A'}.`,
  ORDER_PAID: (orderNumber) =>
    `[Nogatu NCDMS] Payment for order ${orderNumber} has been confirmed. Your order is being prepared for delivery.`,
  ORDER_DELIVERED: (orderNumber) =>
    `[Nogatu NCDMS] Order ${orderNumber} has been delivered successfully. Thank you!`,
  AUTO_PO: (poNumber, product) =>
    `[Nogatu NCDMS] Auto PO ${poNumber} generated for ${product} due to low stock levels.`,
};

/**
 * Send SMS via Semaphore PH API
 * @param {string} phone - recipient phone number
 * @param {string} message - SMS message text
 * @returns {object|null} API response or null on failure
 */
async function sendSMS(phone, message) {
  // SMS is temporarily disabled by request.
  // Keep this no-op so existing notification flows continue without runtime failures.
  console.log(`[SMS] Disabled (skipped). To: ${phone} | Message: ${message}`);

  // Previous implementation kept for quick re-enable:
  // if (!env.SEMAPHORE_API_KEY || env.SEMAPHORE_API_KEY === 'your_semaphore_api_key') {
  //   console.log(`[SMS] (Dry run) To: ${phone} | Message: ${message}`);
  //   return null;
  // }
  //
  // try {
  //   const response = await axios.post('https://api.semaphore.co/api/v4/messages', {
  //     apikey: env.SEMAPHORE_API_KEY,
  //     number: phone,
  //     message,
  //   });
  //   console.log(`[SMS] Sent to ${phone}`);
  //   return response.data;
  // } catch (err) {
  //   console.error(`[SMS] Failed to send to ${phone}:`, err.message);
  //   return null;
  // }

  return null;
}

module.exports = { sendSMS, SMS_TEMPLATES };
