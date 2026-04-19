const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── DB setup ────────────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id    SERIAL PRIMARY KEY,
      name  TEXT           NOT NULL,
      price NUMERIC(10,2)  NOT NULL,
      stock INTEGER        NOT NULL DEFAULT 0,
      image TEXT           NOT NULL DEFAULT '📦'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER REFERENCES products(id),
      product_name TEXT           NOT NULL,
      price        NUMERIC(10,2)  NOT NULL,
      created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    );
  `);

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

// ── Rendering ────────────────────────────────────────────────────────────────

const indexTemplate = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8');

function stockBadge(stock) {
  if (stock === 0) return { label: 'Out of Stock', cls: 'out' };
  if (stock <= 5)  return { label: `Low Stock (${stock} left)`, cls: 'low' };
  return { label: 'In Stock', cls: 'in' };
}

function buildCards(products) {
  return products.map(p => {
    const { label, cls } = stockBadge(p.stock);
    const disabled = p.stock === 0 ? 'disabled' : '';
    return `
      <div class="card">
        <div class="card-image">
          ${p.image}
          <span class="stock ${cls}">${label}</span>
        </div>
        <div class="card-body">
          <h2>${p.name}</h2>
          <p class="price">$${parseFloat(p.price).toFixed(2)} <span>USD</span></p>
          <form method="POST" action="/order">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" ${disabled}>${p.stock === 0 ? 'Out of Stock' : 'Order Now'}</button>
          </form>
        </div>
      </div>`;
  }).join('');
}

function buildOrderRows(orders) {
  if (orders.length === 0) {
    return '<tr><td colspan="4" class="empty">No orders yet</td></tr>';
  }
  return orders.map(o => {
    const time = new Date(o.created_at).toLocaleString();
    return `<tr>
      <td class="order-id">#${o.id}</td>
      <td>${o.product_name}</td>
      <td>$${parseFloat(o.price).toFixed(2)}</td>
      <td>${time}</td>
    </tr>`;
  }).join('');
}

function renderPage(products, orders) {
  return indexTemplate
    .replace('{{CARDS}}', buildCards(products))
    .replace('{{ORDER_ROWS}}', buildOrderRows(orders));
}

// ── Request helpers ──────────────────────────────────────────────────────────

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

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Static files
  if (req.method === 'GET' && req.url === '/style.css') {
    serveStatic(res, path.join(__dirname, 'public', 'style.css'), 'text/css');
    return;
  }

  // Home page
  if (req.method === 'GET' && req.url === '/') {
    try {
      const [{ rows: products }, { rows: orders }] = await Promise.all([
        pool.query('SELECT * FROM products ORDER BY id'),
        pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10'),
      ]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderPage(products, orders));
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end('Database error');
    }
    return;
  }

  // Place order
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
  .then(() => server.listen(PORT, () => console.log(`Shop running at http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
