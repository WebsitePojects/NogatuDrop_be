const { renderEmail, siteUrl } = require('./layout');

// Staff and Stockist emails. Signatures are unchanged from the old inline templates, so every caller keeps
// working; the content is now the shared designed layout (escaped, with a plain-text part).

const ORDER_STEPS = ['Placed', 'Approved', 'Paid', 'On the way', 'Delivered'];
const STAFF_FOOTER = 'You received this email because you have a Nogatu NCDMS account.';
const signIn = (label = 'Open Nogatu NCDMS') => ({ actions: [{ label, href: siteUrl('/login') }] });
const orderSteps = (current, cancelled = false) => ({ steps: { labels: ORDER_STEPS, current, cancelled } });

const EMAIL = {
  orderPlaced: (orderNumber, stockistName) => renderEmail({
    subject: `New order #${orderNumber} from ${stockistName}`,
    preheader: `${stockistName} placed an order. Review and approve it.`,
    eyebrow: `Order #${orderNumber}`, heading: 'A new order is waiting',
    blocks: [
      { p: 'Please review the order and approve it so the buyer can pay.' },
      { details: [['Order', `#${orderNumber}`, true], ['From', stockistName]] },
      signIn('Review the order'),
    ],
    footerNote: STAFF_FOOTER,
  }),

  orderApproved: (orderNumber, deadlineHours, bankDetails) => renderEmail({
    subject: `Order #${orderNumber} approved: pay within ${deadlineHours} hours`,
    preheader: `Upload your payment within ${deadlineHours} hours or the order is cancelled.`,
    eyebrow: `Order #${orderNumber}`, heading: 'Your order is approved',
    blocks: [
      orderSteps(1),
      { notice: { tone: 'warn', text: `Pay and upload your receipt within ${deadlineHours} hours, or the order is cancelled automatically.` } },
      ...(bankDetails ? [{ details: [['Pay to', bankDetails]] }] : []),
      signIn('Upload payment'),
    ],
    footerNote: STAFF_FOOTER,
  }),

  paymentProofUploaded: (orderNumber, stockistName) => renderEmail({
    subject: `Receipt to check: order #${orderNumber}`,
    preheader: `${stockistName} uploaded a payment receipt.`,
    eyebrow: `Order #${orderNumber}`, heading: 'A payment receipt is in',
    blocks: [
      { p: 'Check the receipt against the bank, then verify the payment so the order can ship.' },
      { details: [['Order', `#${orderNumber}`, true], ['From', stockistName]] },
      signIn('Check the receipt'),
    ],
    footerNote: STAFF_FOOTER,
  }),

  paymentVerified: (orderNumber) => renderEmail({
    subject: `Payment confirmed: order #${orderNumber}`,
    preheader: 'Your order is being prepared for delivery.',
    eyebrow: `Order #${orderNumber}`, heading: 'Payment confirmed',
    blocks: [orderSteps(2), { p: 'Thank you. Your order is being prepared for delivery.' }, signIn('View the order')],
    footerNote: STAFF_FOOTER,
  }),

  riderDispatched: (orderNumber, courierName, trackingNumber) => renderEmail({
    subject: `Order #${orderNumber} is on its way`,
    preheader: `Shipped with ${courierName}.`,
    eyebrow: `Order #${orderNumber}`, heading: 'Your order is on its way',
    blocks: [
      orderSteps(3),
      { details: [['Delivered by', courierName], ['Tracking number', trackingNumber, true]] },
      signIn('Follow the delivery'),
    ],
    footerNote: STAFF_FOOTER,
  }),

  orderDelivered: (orderNumber) => renderEmail({
    subject: `Order #${orderNumber} delivered`,
    preheader: 'The delivery was confirmed with a photo and signature.',
    eyebrow: `Order #${orderNumber}`, heading: 'Delivered',
    blocks: [orderSteps(4), { p: 'The rider confirmed the delivery with a photo and the receiver\'s signature. Remember to receive the boxes into your stock.' }, signIn('Receive the goods')],
    footerNote: STAFF_FOOTER,
  }),

  orderCancelledDeadline: (orderNumber) => renderEmail({
    subject: `Order #${orderNumber} cancelled: payment deadline passed`,
    preheader: 'No payment was uploaded in time.',
    eyebrow: `Order #${orderNumber}`, heading: 'Order cancelled',
    blocks: [orderSteps(0, true), { notice: { tone: 'bad', text: 'This order was cancelled because no payment was uploaded before the deadline. Place a new order if you still need the stock.' } }, signIn('Place a new order')],
    footerNote: STAFF_FOOTER,
  }),

  orderRejected: (orderNumber, reason) => renderEmail({
    subject: `Order #${orderNumber} was not approved`,
    preheader: reason ? `Reason: ${reason}` : 'The order was not approved.',
    eyebrow: `Order #${orderNumber}`, heading: 'Order not approved',
    blocks: [orderSteps(0, true), { notice: { tone: 'bad', text: reason ? `Reason: ${reason}` : 'No reason was given.' } }, signIn('View your orders')],
    footerNote: STAFF_FOOTER,
  }),

  lowStock: (productName, warehouseName, currentStock) => renderEmail({
    subject: `Low stock: ${productName} at ${warehouseName}`,
    preheader: `${currentStock} units left.`,
    eyebrow: 'Stock alert', heading: `${productName} is running low`,
    blocks: [{ highlight: { label: `Left at ${warehouseName}`, value: `${currentStock} units` } }, { p: 'Book in new stock soon so orders are not refused.' }, signIn('Open inventory')],
    footerNote: STAFF_FOOTER,
  }),

  autoPO: (poNumber, productName) => renderEmail({
    subject: `Purchase order #${poNumber} created automatically`,
    preheader: `For ${productName}, because stock is low.`,
    eyebrow: 'Stock alert', heading: 'Purchase order created',
    blocks: [{ details: [['Purchase order', `#${poNumber}`, true], ['Product', productName]] }, signIn('Review it')],
    footerNote: STAFF_FOOTER,
  }),

  grnDiscrepancy: (grnNumber, productName, expected, received) => renderEmail({
    subject: `Delivery count differs: receipt #${grnNumber}`,
    preheader: `${productName}: expected ${expected}, received ${received}.`,
    eyebrow: `Receipt #${grnNumber}`, heading: 'The boxes received do not match',
    blocks: [{ details: [['Product', productName], ['Expected', String(expected)], ['Received', String(received)]] }, signIn('Check the receipt')],
    footerNote: STAFF_FOOTER,
  }),

  batchExpiry: (productName, expiryDate, warehouseName) => renderEmail({
    subject: `Expiring soon: ${productName} on ${expiryDate}`,
    preheader: `At ${warehouseName}.`,
    eyebrow: 'Stock alert', heading: `${productName} expires soon`,
    blocks: [{ details: [['Expires', expiryDate], ['Warehouse', warehouseName]] }, { p: 'Sell or move this batch first.' }, signIn('Open inventory')],
    footerNote: STAFF_FOOTER,
  }),

  dtaReceived: (applicantName, businessName) => renderEmail({
    subject: `New Stockist application: ${applicantName}`,
    preheader: `${businessName} applied to become a Stockist.`,
    eyebrow: 'Applications', heading: 'New Stockist application',
    blocks: [{ details: [['Applicant', applicantName], ['Business', businessName]] }, signIn('Review the application')],
    footerNote: STAFF_FOOTER,
  }),

  dtaApproved: (applicantName, email, tempPassword) => renderEmail({
    subject: 'Welcome to Nogatu: your Stockist account is ready',
    preheader: 'Sign in and change your temporary password.',
    eyebrow: 'Welcome', heading: 'Your Stockist account is ready',
    greeting: `Hi ${applicantName},`,
    blocks: [
      { p: 'Your Stockist application was approved. Sign in with the details below and change the password straight away.' },
      { details: [['Sign-in email', email]] },
      { highlight: { label: 'Temporary password', value: tempPassword, mono: true } },
      signIn('Sign in'),
    ],
    footerNote: 'You received this email because your Stockist application was approved.',
  }),

  passwordReset: (otp) => renderEmail({
    subject: 'Your Nogatu password reset code',
    preheader: 'The code works for 15 minutes.',
    eyebrow: 'Password reset', heading: 'Reset your password',
    blocks: [
      { highlight: { label: 'Your code', value: otp, mono: true } },
      { p: 'Enter this code on the reset page. It works for 15 minutes.' },
      { notice: { tone: 'info', text: 'Did not ask for this? Ignore this email; your password stays the same.' } },
    ],
    footerNote: 'You received this email because someone asked to reset the password of your Nogatu account.',
  }),
};

module.exports = { EMAIL, ORDER_STEPS };
