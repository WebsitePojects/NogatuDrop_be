const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// GET /api/v1/cart
const getCart = asyncHandler(async (req, res) => {
  const [items] = await pool.execute(
    `SELECT ci.id, ci.product_id, ci.quantity, ci.added_at, ci.updated_at,
            p.name AS product_name, p.sku, p.category, p.retail_price, p.partner_price,
            p.unit, p.image_url,
            (ci.quantity * p.partner_price) AS subtotal
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = ? AND p.is_deleted = 0 AND p.is_active = 1
     ORDER BY ci.added_at DESC`,
    [req.user.id]
  );

  const total = items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);

  res.json({
    success: true,
    data: {
      items,
      itemCount: items.length,
      total: total.toFixed(2),
    },
  });
});

// POST /api/v1/cart (upsert)
const addToCart = asyncHandler(async (req, res) => {
  const { product_id, quantity } = req.body;
  const userId = req.user.id;

  // Verify product exists and is active
  const [product] = await pool.execute(
    'SELECT id FROM products WHERE id = ? AND is_deleted = 0 AND is_active = 1',
    [product_id]
  );
  if (product.length === 0) throw ApiError.notFound('Product not found');

  // Upsert: if product already in cart, update qty
  const [existing] = await pool.execute(
    'SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?',
    [userId, product_id]
  );

  if (existing.length > 0) {
    const newQty = existing[0].quantity + (quantity || 1);
    await pool.execute(
      'UPDATE cart_items SET quantity = ? WHERE id = ?',
      [newQty, existing[0].id]
    );
  } else {
    await pool.execute(
      'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)',
      [userId, product_id, quantity || 1]
    );
  }

  // Return updated cart
  const [items] = await pool.execute(
    `SELECT ci.id, ci.product_id, ci.quantity, p.name AS product_name, p.partner_price,
            (ci.quantity * p.partner_price) AS subtotal
     FROM cart_items ci JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = ?`,
    [userId]
  );

  res.status(201).json({ success: true, message: 'Item added to cart', data: items });
});

// PUT /api/v1/cart/:id
const updateCartItem = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  const cartItemId = req.params.id;

  if (!quantity || quantity < 1) throw ApiError.badRequest('Quantity must be at least 1');

  const [existing] = await pool.execute(
    'SELECT id FROM cart_items WHERE id = ? AND user_id = ?',
    [cartItemId, req.user.id]
  );
  if (existing.length === 0) throw ApiError.notFound('Cart item not found');

  await pool.execute('UPDATE cart_items SET quantity = ? WHERE id = ?', [quantity, cartItemId]);

  res.json({ success: true, message: 'Cart item updated' });
});

// DELETE /api/v1/cart/:id
const removeCartItem = asyncHandler(async (req, res) => {
  const [existing] = await pool.execute(
    'SELECT id FROM cart_items WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (existing.length === 0) throw ApiError.notFound('Cart item not found');

  await pool.execute('DELETE FROM cart_items WHERE id = ?', [req.params.id]);

  res.json({ success: true, message: 'Item removed from cart' });
});

// DELETE /api/v1/cart
const clearCart = asyncHandler(async (req, res) => {
  await pool.execute('DELETE FROM cart_items WHERE user_id = ?', [req.user.id]);
  res.json({ success: true, message: 'Cart cleared' });
});

module.exports = { getCart, addToCart, updateCartItem, removeCartItem, clearCart };
