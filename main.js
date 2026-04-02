const http = require('http');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id   SERIAL PRIMARY KEY,
      name  TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      image TEXT NOT NULL DEFAULT '📦'
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      price        NUMERIC(10,2) NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed products if table is empty
  const { rowCount } = await pool.query('SELECT 1 FROM products LIMIT 1');
  if (rowCount === 0) {
    await pool.query(`
      INSERT INTO products (name, price, stock, image) VALUES
        ('Wireless Headphones', 59.99, 15, '🎧'),
        ('Mechanical Keyboard', 89.99,  3, '⌨️'),
        ('USB-C Hub',           34.99,  0, '🔌'),
        ('Webcam HD',           49.99,  8, '📷');
    `);
    console.log('Seeded initial products');
  }
}

function getStockLabel(stock) {
  if (stock === 0) return { label: 'Out of Stock', cls: 'out' };
  if (stock <= 5)  return { label: `Low Stock (${stock} left)`, cls: 'low' };
  return { label: 'In Stock', cls: 'in' };
}

function renderHTML(products, orders) {
  const cards = products.map(p => {
    const { label, cls } = getStockLabel(p.stock);
    const disabled = p.stock === 0 ? 'disabled' : '';
    return `
      <div class="card">
        <div class="emoji">${p.image}</div>
        <h2>${p.name}</h2>
        <p class="price">$${parseFloat(p.price).toFixed(2)}</p>
        <span class="stock ${cls}">${label}</span>
        <form method="POST" action="/order">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" ${disabled}>Order Now</button>
        </form>
      </div>`;
  }).join('');

  const orderRows = orders.map(o => {
    const time = new Date(o.created_at).toLocaleString();
    return `<tr><td>#${o.id}</td><td>${o.product_name}</td><td>$${parseFloat(o.price).toFixed(2)}</td><td>${time}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Product Shop</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f0f2f5; color: #333; }
    header { background: #1a1a2e; color: white; padding: 1rem 2rem; }
    header h1 { font-size: 1.5rem; }
    main { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1.5rem; }
    .card { background: white; border-radius: 12px; padding: 1.5rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .emoji { font-size: 3rem; margin-bottom: 0.75rem; }
    h2 { font-size: 1rem; margin-bottom: 0.5rem; }
    .price { font-size: 1.25rem; font-weight: bold; color: #1a1a2e; margin-bottom: 0.75rem; }
    .stock { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.8rem; font-weight: 600; margin-bottom: 1rem; }
    .stock.in  { background: #d1fae5; color: #065f46; }
    .stock.low { background: #fef3c7; color: #92400e; }
    .stock.out { background: #fee2e2; color: #991b1b; }
    button { width: 100%; padding: 0.6rem; border: none; border-radius: 8px; background: #4f46e5; color: white; font-size: 0.95rem; cursor: pointer; transition: background 0.2s; }
    button:hover:not(:disabled) { background: #4338ca; }
    button:disabled { background: #d1d5db; cursor: not-allowed; }
    .section-title { margin: 2rem 0 1rem; font-size: 1.2rem; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #f0f0f0; }
    th { background: #f8f9fa; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; color: #666; }
    .empty { color: #999; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header><h1>Product Shop</h1></header>
  <main>
    <div class="grid">${cards}</div>
    <p class="section-title">Recent Orders</p>
    <table>
      <thead><tr><th>Order</th><th>Product</th><th>Price</th><th>Time</th></tr></thead>
      <tbody>${orderRows || '<tr><td colspan="4" class="empty">No orders yet</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function parseBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const params = {};
    body.split('&').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    cb(params);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    try {
      const [{ rows: products }, { rows: orders }] = await Promise.all([
        pool.query('SELECT * FROM products ORDER BY id'),
        pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10'),
      ]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderHTML(products, orders));
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end('Database error');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/order') {
    parseBody(req, async (params) => {
      const productId = parseInt(params.id);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT * FROM products WHERE id = $1 FOR UPDATE',
          [productId]
        );
        const product = rows[0];
        if (product && product.stock > 0) {
          await client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [productId]);
          await client.query(
            'INSERT INTO orders (product_id, product_name, price) VALUES ($1, $2, $3)',
            [product.id, product.name, product.price]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
      } finally {
        client.release();
      }
      res.writeHead(302, { Location: '/' });
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

initDB()
  .then(() => {
    server.listen(PORT, () => console.log(`Shop running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  });
