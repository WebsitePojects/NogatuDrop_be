const { BrevoClient } = require('@getbrevo/brevo');
const env = require('../config/env');

let brevoClient = null;

function hasUsableBrevoKey() {
  const key = String(env.BREVO_API_KEY || '').trim();
  if (!key) return false;

  const lower = key.toLowerCase();
  return !(lower === 'your_brevo_api_key' || lower.startsWith('your_'));
}

function getBrevoClient() {
  if (!brevoClient) {
    brevoClient = new BrevoClient({
      apiKey: env.BREVO_API_KEY,
    });
  }

  return brevoClient;
}

async function sendEmail({ to, toName, subject, html }) {
  if (!hasUsableBrevoKey()) {
    console.log(`[Email] Brevo key is not configured - skipping email to ${to}: ${subject}`);
    return;
  }

  const recipients = Array.isArray(to)
    ? to.map((email) => ({ email }))
    : [{ email: to, name: toName }];

  try {
    const client = getBrevoClient();

    await client.transactionalEmails.sendTransacEmail({
      sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM },
      to: recipients,
      subject,
      htmlContent: html,
    });
  } catch (err) {
    const message = err?.message || String(err);
    if (env.NODE_ENV !== 'production') {
      console.warn('[Email] Failed to send (non-fatal in development):', message);
      return;
    }
    console.error('[Email] Failed to send:', message);
  }
}

const EMAIL = {
  orderPlaced: (orderNumber, stockistName) => ({
    subject: `New Order: #${orderNumber} from ${stockistName}`,
    html: `<p>A new order <strong>#${orderNumber}</strong> has been placed by <strong>${stockistName}</strong>. Please review and approve it in the system.</p>`,
  }),

  orderApproved: (orderNumber, deadlineHours, bankDetails) => ({
    subject: deadlineHours
      ? `Order #${orderNumber} Approved - Pay within ${deadlineHours} hours`
      : `Order #${orderNumber} Approved - Cash on Delivery`,
    html: `
      <p>Your order <strong>#${orderNumber}</strong> has been approved.</p>
      ${deadlineHours
        ? `<p><strong>You have ${deadlineHours} hours to upload payment proof.</strong> The order will be auto-cancelled if payment is not verified in time.</p>`
        : `<p><strong>This order is approved for cash on delivery.</strong> Delivery can proceed without advance payment proof.</p>`}
      ${bankDetails ? `<p><strong>Bank Account:</strong><br/>${bankDetails}</p>` : ''}
      <p>${deadlineHours ? 'Please log in to the system to upload your payment proof.' : 'Please log in to track delivery and settlement updates.'}</p>
    `,
  }),

  paymentProofUploaded: (orderNumber, stockistName) => ({
    subject: `Payment Proof: #${orderNumber} - Verify Now`,
    html: `<p><strong>${stockistName}</strong> has uploaded payment proof for order <strong>#${orderNumber}</strong>. Please log in to verify.</p>`,
  }),

  paymentVerified: (orderNumber) => ({
    subject: `Payment Confirmed: #${orderNumber}`,
    html: `<p>Your payment for order <strong>#${orderNumber}</strong> has been verified. Your order is now being prepared for delivery.</p>`,
  }),

  riderDispatched: (orderNumber, courierName, trackingNumber) => ({
    subject: `Your Order #${orderNumber} is On Its Way`,
    html: `
      <p>Order <strong>#${orderNumber}</strong> has been dispatched via <strong>${courierName}</strong>.</p>
      ${trackingNumber ? `<p>Tracking Number: <strong>${trackingNumber}</strong></p>` : ''}
    `,
  }),

  orderDelivered: (orderNumber) => ({
    subject: `Order #${orderNumber} Delivered`,
    html: `<p>Order <strong>#${orderNumber}</strong> has been successfully delivered. Thank you!</p>`,
  }),

  orderCancelledDeadline: (orderNumber) => ({
    subject: `Order #${orderNumber} Cancelled - Deadline Passed`,
    html: `<p>Order <strong>#${orderNumber}</strong> has been automatically cancelled because payment was not uploaded within the deadline. Please place a new order if you still wish to proceed.</p>`,
  }),

  orderRejected: (orderNumber, reason) => ({
    subject: `Order #${orderNumber} Rejected`,
    html: `<p>Order <strong>#${orderNumber}</strong> has been rejected. Reason: ${reason || 'N/A'}.</p>`,
  }),

  lowStock: (productName, warehouseName, currentStock) => ({
    subject: `Low Stock: ${productName} at ${warehouseName}`,
    html: `<p>Stock level for <strong>${productName}</strong> at <strong>${warehouseName}</strong> has dropped to <strong>${currentStock} units</strong>. An auto purchase order may have been generated.</p>`,
  }),

  autoPO: (poNumber, productName) => ({
    subject: `Auto PO #${poNumber} Generated`,
    html: `<p>An automatic purchase order <strong>#${poNumber}</strong> has been generated for <strong>${productName}</strong> due to low stock.</p>`,
  }),

  grnDiscrepancy: (grnNumber, productName, expected, received) => ({
    subject: `GRN Discrepancy: #${grnNumber}`,
    html: `<p>GRN <strong>#${grnNumber}</strong> has a discrepancy for <strong>${productName}</strong>: expected <strong>${expected}</strong>, received <strong>${received}</strong>.</p>`,
  }),

  batchExpiry: (productName, expiryDate, warehouseName) => ({
    subject: `Expiry Alert: ${productName} expires ${expiryDate}`,
    html: `<p><strong>${productName}</strong> at <strong>${warehouseName}</strong> is expiring on <strong>${expiryDate}</strong>. Please act accordingly.</p>`,
  }),

  dtaReceived: (applicantName, businessName) => ({
    subject: `New Stockist Application: ${applicantName}`,
    html: `<p>A new Distributor-Trader Agreement application has been submitted by <strong>${applicantName}</strong> (${businessName}). Please review it in the system.</p>`,
  }),

  dtaApproved: (applicantName, email, tempPassword) => ({
    subject: 'Welcome to Nogatu - Account Ready',
    html: `
      <p>Dear <strong>${applicantName}</strong>,</p>
      <p>Your Stockist application has been approved! Your account is now active.</p>
      <p><strong>Email:</strong> ${email}<br/>
      <strong>Temporary Password:</strong> ${tempPassword}</p>
      <p>Please log in and change your password immediately.</p>
    `,
  }),

  passwordReset: (otp) => ({
    subject: 'Your Password Reset Code',
    html: `
      <p>Your password reset code is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p>
      <p>This code expires in 15 minutes. If you did not request a password reset, ignore this email.</p>
    `,
  }),
};

module.exports = { sendEmail, EMAIL };
