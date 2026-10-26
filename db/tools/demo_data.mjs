// demo data of the shop made through its own routes, so it passes every check real data passes
// and keeps working while the database changes: a tree of categories, products with images and
// the data of safety, their stock by a delivery in batches, sales, a few buyers with carts,
// confirmed orders, reviews and favorites. What is there already stays: categories are found by
// slug, products by sku, a buyer with orders gets no more; a run adds only what is missing.
// The shop lets a buyer in only with a confirmed email, so the buyers take two runs: the first
// registers them, each confirms the email by the link of the mail, the next run logs them in and
// gives them their orders, reviews and favorites. A buyer accepts the versions of the terms and
// of the contract in force the way the form of the shop asks: at the registration, and a version
// put in force after it at the next login.
// usage:
//   DEMO_API_URL=<url of the api> DEMO_ADMIN_EMAIL=<email> DEMO_ADMIN_PASSWORD=<password> \
//   DEMO_USERS_PASSWORD=<password of the demo buyers> node db/tools/demo_data.mjs
// DEMO_ADMIN_* - an account of ADMIN or ROOT with a password; DEMO_EMAIL_DOMAIN (optional,
// example.com) - the domain of the addresses demo.buyer<n>@ of the buyers: mail to example.com
// reaches nobody, the buyers then stay unconfirmed.
// Orders stay unpaid: a payment comes from the payment provider to the webhook of the server.
// The values are read only from the environment of the command and never printed
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

const API_URL = process.env.DEMO_API_URL ?? '';
const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? '';
const USERS_PASSWORD = process.env.DEMO_USERS_PASSWORD ?? '';
const EMAIL_DOMAIN = process.env.DEMO_EMAIL_DOMAIN || 'example.com';

// a limit of the server is waited out when it is short, a longer one stops the run
const MAX_WAIT_SECONDS = 90;
const MAX_ATTEMPTS = 5;

// parents before their children
const CATEGORIES = [
  {
    slug: 'electronics',
    name: 'Electronics',
    description: 'Phones, laptops and sound.',
    parent: null,
  },
  {
    slug: 'phones',
    name: 'Phones',
    description: 'Smartphones of every size.',
    parent: 'electronics',
  },
  {
    slug: 'laptops',
    name: 'Laptops',
    description: 'Laptops for work and play.',
    parent: 'electronics',
  },
  {
    slug: 'headphones',
    name: 'Headphones',
    description: 'Earbuds and over-ear headphones.',
    parent: 'electronics',
  },
  { slug: 'home', name: 'Home', description: 'The kitchen and the light of a home.', parent: null },
  {
    slug: 'kitchen',
    name: 'Kitchen',
    description: 'Coffee, tea and the tools to make them.',
    parent: 'home',
  },
  { slug: 'lighting', name: 'Lighting', description: 'Lamps and smart bulbs.', parent: 'home' },
  {
    slug: 'books',
    name: 'Books',
    description: 'Books about the trade and the craft.',
    parent: null,
  },
];

const MAKERS = {
  devices: {
    name: 'Northwind Devices GmbH',
    address: 'Hauptstrasse 1, 10115 Berlin, Germany',
    email: 'safety@northwind.example.com',
    country: 'DE',
  },
  home: {
    name: 'Casa Lumen S.L.',
    address: 'Calle Mayor 10, 28013 Madrid, Spain',
    email: 'safety@casalumen.example.com',
    country: 'ES',
  },
  books: {
    name: 'Atlas Books B.V.',
    address: 'Damrak 1, 1012 LG Amsterdam, Netherlands',
    email: 'safety@atlasbooks.example.com',
    country: 'NL',
  },
};

// sale - a percent off for 14 days; expiresIn - the last good day of the batch, days from today
const PRODUCTS = [
  {
    sku: 'DEMO-001',
    name: 'Aurora X1 smartphone',
    category: 'phones',
    price: 499,
    units: 25,
    cost: 320,
    maker: 'devices',
    warnings: 'Keep the battery away from heat.',
  },
  {
    sku: 'DEMO-002',
    name: 'Aurora X1 Mini smartphone',
    category: 'phones',
    price: 379,
    units: 30,
    cost: 240,
    maker: 'devices',
    sale: 10,
  },
  {
    sku: 'DEMO-003',
    name: 'Nimbus Fold smartphone',
    category: 'phones',
    price: 1099,
    units: 8,
    cost: 760,
    maker: 'devices',
  },
  {
    sku: 'DEMO-004',
    name: 'Vertex 14 laptop',
    category: 'laptops',
    price: 1199,
    units: 12,
    cost: 850,
    maker: 'devices',
    sale: 15,
  },
  {
    sku: 'DEMO-005',
    name: 'Vertex 16 Pro laptop',
    category: 'laptops',
    price: 1799,
    units: 6,
    cost: 1300,
    maker: 'devices',
  },
  {
    sku: 'DEMO-006',
    name: 'Echo Buds wireless earbuds',
    category: 'headphones',
    price: 89.9,
    units: 60,
    cost: 41,
    maker: 'devices',
    warnings: 'Small parts, keep away from children.',
  },
  {
    sku: 'DEMO-007',
    name: 'Echo Studio over-ear headphones',
    category: 'headphones',
    price: 199,
    units: 20,
    cost: 120,
    maker: 'devices',
    sale: 20,
  },
  {
    sku: 'DEMO-008',
    name: 'Barista espresso machine',
    category: 'kitchen',
    price: 349,
    units: 10,
    cost: 210,
    maker: 'home',
    warnings: 'Hot surfaces while in use.',
  },
  {
    sku: 'DEMO-009',
    name: 'Ceramic chef knife',
    category: 'kitchen',
    price: 59.9,
    units: 40,
    cost: 22,
    maker: 'home',
    warnings: 'Sharp blade.',
  },
  {
    sku: 'DEMO-010',
    name: 'Single origin coffee beans, 1 kg',
    category: 'kitchen',
    price: 24.5,
    units: 80,
    cost: 11,
    maker: 'home',
    expiresIn: 120,
  },
  {
    sku: 'DEMO-011',
    name: 'Green tea, 100 bags',
    category: 'kitchen',
    price: 8.9,
    units: 120,
    cost: 3.2,
    maker: 'home',
    expiresIn: 5,
  },
  {
    sku: 'DEMO-012',
    name: 'Arc floor lamp',
    category: 'lighting',
    price: 129,
    units: 15,
    cost: 70,
    maker: 'home',
  },
  {
    sku: 'DEMO-013',
    name: 'Smart bulb E27, two pack',
    category: 'lighting',
    price: 29.9,
    units: 100,
    cost: 12,
    maker: 'home',
    sale: 25,
  },
  {
    sku: 'DEMO-014',
    name: 'The Pragmatic Shopkeeper, paperback',
    category: 'books',
    price: 19.9,
    units: 50,
    cost: 7,
    maker: 'books',
  },
  {
    sku: 'DEMO-015',
    name: 'Databases in Depth, hardcover',
    category: 'books',
    price: 44,
    units: 25,
    cost: 18,
    maker: 'books',
  },
  {
    sku: 'DEMO-016',
    name: 'A Short History of Trade',
    category: 'books',
    price: 14.5,
    units: 35,
    cost: 5.5,
    maker: 'books',
  },
];

// what each buyer does: a confirmed order, and a cart left after it
const BUYERS = [
  {
    name: 'Olena',
    orders: [
      {
        items: [
          ['DEMO-001', 1],
          ['DEMO-006', 2],
        ],
        confirm: true,
      },
    ],
    reviews: [
      ['DEMO-001', 5, 'Fast, bright screen, the battery lasts two days.'],
      ['DEMO-006', 4, 'Good sound for the price.'],
      ['DEMO-014', 5, 'Read it in one evening.'],
    ],
    favorites: ['DEMO-004', 'DEMO-008'],
  },
  {
    name: 'Marco',
    orders: [
      {
        items: [
          ['DEMO-008', 1],
          ['DEMO-010', 2],
        ],
        confirm: true,
      },
      { items: [['DEMO-013', 3]], confirm: false },
    ],
    reviews: [
      ['DEMO-008', 5, 'Makes a proper espresso.'],
      ['DEMO-010', 4, 'Fruity and fresh.'],
    ],
    favorites: ['DEMO-005', 'DEMO-012', 'DEMO-007'],
  },
  {
    name: 'Sofia',
    orders: [
      {
        items: [
          ['DEMO-015', 1],
          ['DEMO-016', 1],
        ],
        confirm: false,
      },
    ],
    reviews: [
      ['DEMO-015', 4, 'Dense, but worth it.'],
      ['DEMO-012', 3, 'Nice light, the cable is short.'],
    ],
    favorites: ['DEMO-002', 'DEMO-011'],
  },
];

// what is printed never names the values the run was given; any ip address goes too, the errors
// of the network quote the server
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const secrets = new Set();

function hide(text) {
  const parts = [...secrets].filter((part) => part.length >= 3).sort((a, b) => b.length - a.length);
  return parts
    .reduce((out, part) => out.split(part).join('***'), String(text))
    .replace(IP_ADDRESS, '***');
}

function stop(message) {
  console.error(`\n${hide(message)}`);
  process.exit(1);
}

const step = (message) => console.log(`== ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorCodeOf = (res) =>
  res.body && typeof res.body === 'object' ? res.body.errorCode : undefined;

// a session of one account: its cookies and its csrf token, the way a browser keeps them
class Session {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  keepCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const gone = !value || attrs.some((attr) => /^\s*max-age=0\s*$/i.test(attr));
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async takeCsrf() {
    const res = await this.send('GET', '/api/auth/csrf');
    if (res.status !== 200 || !res.body?.csrfToken) stop(`no csrf token: ${res.status}`);
    this.csrf = res.body.csrfToken;
  }

  // one request; a limit of the server and a busy row are waited out and tried again
  async send(method, url, { json, form } = {}) {
    for (let attempt = 1; ; attempt++) {
      const changes = method !== 'GET';
      if (changes && !this.csrf) await this.takeCsrf();

      const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (changes) headers['x-csrf-token'] = this.csrf;
      let body;
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form) {
        body = form();
      }

      const res = await fetch(new URL(url, this.base), {
        method,
        headers,
        body,
        redirect: 'manual',
      });
      this.keepCookies(res);
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      const answer = {
        status: res.status,
        body: type.includes('json') && text ? JSON.parse(text) : text,
      };
      const code = errorCodeOf(answer);

      if (
        attempt < MAX_ATTEMPTS &&
        changes &&
        res.status === 403 &&
        code === 'CSRF_TOKEN_INVALID'
      ) {
        this.csrf = null;
        continue;
      }
      if (attempt < MAX_ATTEMPTS && res.status === 409 && code === 'RESOURCE_BUSY') {
        await sleep(500 * attempt);
        continue;
      }
      if (attempt < MAX_ATTEMPTS && res.status === 429) {
        const seconds = Number(res.headers.get('retry-after') ?? '60');
        if (seconds > MAX_WAIT_SECONDS) {
          stop(`${method} ${url}: a limit of the server holds for ${seconds} s, run again later`);
        }
        console.log(`   waiting ${seconds} s for a limit of the server`);
        await sleep(seconds * 1000);
        continue;
      }
      return answer;
    }
  }
}

// an answer of one of the statuses, else the run stops with the status and the error code
function expectStatus(res, statuses, what) {
  if (!statuses.includes(res.status)) {
    stop(`${what}: ${res.status}${errorCodeOf(res) ? ` ${errorCodeOf(res)}` : ''}`);
  }
  return res;
}

async function login(session, email, password, what) {
  const res = await session.send('POST', '/api/auth/login', { json: { email, password } });
  expectStatus(res, [200], what);
  return res.body;
}

// a png of a diagonal gradient between two colors: a picture of its own for every product
function pngImage(seed, size = 480) {
  const hue = (seed * 47) % 360;
  const color = (h, light) => {
    const k = (n) => (n + h / 30) % 12;
    const f = (n) =>
      light - 0.45 * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  const from = color(hue, 0.78);
  const to = color((hue + 40) % 360, 0.42);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      row.set(
        from.map((c, i) => Math.round(c + (to[i] - c) * t)),
        1 + x * 3,
      );
    }
    rows.push(row);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// the day the given number of days from today, yyyy-mm-dd by utc
const dayFromToday = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function makeCategories(admin) {
  const tree = expectStatus(
    await admin.send('GET', '/api/categories/tree'),
    [200],
    'the category tree',
  );
  const found = new Map();
  const walk = (nodes) => {
    for (const node of nodes) {
      found.set(node.slug, node.id);
      walk(node.children ?? []);
    }
  };
  walk(tree.body.items ?? []);

  let made = 0;
  for (const category of CATEGORIES) {
    if (found.has(category.slug)) continue;
    const res = await admin.send('POST', '/api/categories', {
      json: {
        name: category.name,
        slug: category.slug,
        description: category.description,
        ...(category.parent ? { parentId: found.get(category.parent) } : {}),
      },
    });
    expectStatus(res, [201], `the category ${category.slug}`);
    found.set(category.slug, res.body.id);
    made++;
  }

  step(`categories: ${made} made, ${CATEGORIES.length - made} there already`);
  // the categories of the demo only, the tree has every category of the shop
  return new Map(CATEGORIES.map((category) => [category.slug, found.get(category.slug)]));
}

// the products of the demo the catalog has, by sku; the catalog a guest sees, every product of it
async function demoProductsIn(base, categoryIds) {
  const guest = new Session(base);
  const bySku = new Map();
  let cursor = null;
  do {
    const query = new URLSearchParams({ categoryIds: categoryIds.join(','), limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const res = expectStatus(
      await guest.send('GET', `/api/products?${query}`),
      [200],
      'the catalog',
    );
    for (const product of res.body.items) {
      if (product.sku?.startsWith('DEMO-')) bySku.set(product.sku, product.id);
    }
    cursor = res.body.nextCursor ?? null;
  } while (cursor);
  return bySku;
}

async function makeProducts(admin, base, categories) {
  const bySku = await demoProductsIn(base, [...categories.values()]);
  const made = [];

  for (const [index, product] of PRODUCTS.entries()) {
    if (bySku.has(product.sku)) continue;
    const maker = MAKERS[product.maker];
    const res = await admin.send('POST', '/api/products', {
      form: () => {
        const form = new FormData();
        form.append('name', product.name);
        form.append(
          'description',
          `${product.name}: a product of the demo catalog of the shop, made to show its pages.`,
        );
        form.append('sku', product.sku);
        form.append('price', product.price.toFixed(2));
        form.append('categoryId', String(categories.get(product.category)));
        form.append('safety.manufacturer.name', maker.name);
        form.append('safety.manufacturer.address', maker.address);
        form.append('safety.manufacturer.email', maker.email);
        form.append('safety.manufacturer.country', maker.country);
        if (product.warnings) form.append('safety.warnings', product.warnings);
        for (const n of [0, 1]) {
          const image = new Blob([pngImage(index * 2 + n + 1)], { type: 'image/png' });
          form.append('images', image, `${product.sku.toLowerCase()}-${n + 1}.png`);
        }
        return form;
      },
    });
    expectStatus(res, [201], `the product ${product.sku}`);
    bySku.set(product.sku, res.body.id);
    made.push(product);
  }

  step(`products: ${made.length} made, ${PRODUCTS.length - made.length} there already`);
  return { bySku, made };
}

// the stock of the new products comes the way real stock comes: a delivery of a supplier
async function deliverStock(admin, bySku, made) {
  if (!made.length) return;
  const res = await admin.send('POST', '/api/products/stock/deliveries', {
    json: {
      source: 'supplier',
      supplier: 'Demo Wholesale Ltd',
      document: `DEMO-${randomBytes(3).toString('hex').toUpperCase()}`,
      note: 'The stock of the demo catalog.',
      items: made.map((product) => ({
        productId: bySku.get(product.sku),
        quantity: product.units,
        unitCost: product.cost,
        ...(product.expiresIn ? { expiresAt: dayFromToday(product.expiresIn) } : {}),
      })),
    },
  });
  expectStatus(res, [201], 'the delivery of the stock');
  step(`stock: ${made.length} products delivered`);
}

async function putOnSale(admin, bySku, made) {
  const onSale = made.filter((product) => product.sale);
  if (!onSale.length) return;
  const endsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const res = await admin.send('POST', '/api/products/sales', {
    json: {
      items: onSale.map((product) => ({
        productId: bySku.get(product.sku),
        sale: { percent: product.sale, endsAt },
      })),
    },
  });
  expectStatus(res, [200, 201], 'the sales');
  step(`sales: ${onSale.length} products on sale for 14 days`);
}

// the ids of the versions of the terms and of the contract in force; none while root published none
async function versionsInForce(base) {
  const res = expectStatus(
    await new Session(base).send('GET', '/api/legal/documents/current'),
    [200],
    'the terms in force',
  );
  return res.body.items.map((doc) => doc.id);
}

// a buyer of the demo: logged in (ready), registered and waiting for the link of the mail to
// confirm the email (the shop lets in only a confirmed email, the run cannot confirm it), or
// registered now. A buyer who waits is not registered again: that would send a new link and
// close the one sent before
async function buyerSession(base, index, buyer, inForce) {
  const session = new Session(base);
  const email = `demo.buyer${index + 1}@${EMAIL_DOMAIN}`;
  const what = `buyer ${index + 1}`;

  let logged = await session.send('POST', '/api/auth/login', {
    json: { email, password: USERS_PASSWORD },
  });
  // a version of the terms or of the contract came in force since the buyer accepted them: the
  // login names the versions in force and the buyer logs in again accepting them
  let consents = 0;
  if (logged.status === 409 && errorCodeOf(logged) === 'LEGAL_ACCEPTANCE_REQUIRED') {
    consents = logged.body.details.kinds.length;
    logged = await session.send('POST', '/api/auth/login', {
      json: {
        email,
        password: USERS_PASSWORD,
        acceptedDocumentIds: logged.body.details.current.map((doc) => doc.id),
      },
    });
  }
  if (logged.status === 200) return { session, state: 'ready', consents };
  if (logged.status === 403 && errorCodeOf(logged) === 'EMAIL_NOT_VERIFIED') {
    return { session: null, state: 'waiting' };
  }
  expectStatus(logged, [401], `the login of ${what}`);

  // no account, or one nobody confirmed with another password (registering takes it over)
  const res = await session.send('POST', '/api/auth/register', {
    json: {
      email,
      password: USERS_PASSWORD,
      name: buyer.name,
      ...(inForce.length ? { acceptedDocumentIds: inForce } : {}),
    },
  });
  if (res.status === 409 && errorCodeOf(res) === 'EMAIL_ALREADY_IN_USE') {
    stop(`${what}: the address belongs to a confirmed account with another password`);
  }
  expectStatus(res, [201], `the registration of ${what}`);
  return { session: null, state: 'registered' };
}

// a buyer who has any order or a cart already did the demo
async function hasOrders(session, index) {
  const list = expectStatus(
    await session.send('GET', '/api/orders?limit=1'),
    [200],
    `the orders of buyer ${index + 1}`,
  );
  if (list.body.total > 0) return true;
  const cart = expectStatus(
    await session.send('GET', '/api/orders/current'),
    [200, 404],
    `the cart of buyer ${index + 1}`,
  );
  return cart.status === 200 && (cart.body.items?.length ?? 0) > 0;
}

async function placeOrders(session, index, buyer, bySku) {
  let placed = 0;
  for (const order of buyer.orders) {
    // the cart the items went into, the answer of each item names it
    let orderId;
    for (const [sku, quantity] of order.items) {
      const res = await session.send('POST', '/api/orders/current/items', {
        json: { productId: bySku.get(sku), quantity },
      });
      expectStatus(res, [200, 201], `the cart of buyer ${index + 1}`);
      orderId = res.body.id;
    }
    if (order.confirm) {
      const res = await session.send('POST', '/api/orders/current/confirm', {
        json: {
          orderId,
          shippingAddress: `Demo street ${index + 1}, Kyiv`,
          recipientFirstName: buyer.name,
          recipientLastName: 'Demo',
          recipientPhone: `+38067111223${index + 1}`,
        },
      });
      expectStatus(res, [200], `the order of buyer ${index + 1}`);
    }
    placed++;
  }
  return placed;
}

// a review or a favorite given before answers 409: it is there already
async function reviewAndFavor(session, index, buyer, bySku) {
  let reviews = 0;
  let favorites = 0;
  for (const [sku, rating, comment] of buyer.reviews) {
    const res = await session.send('POST', `/api/products/${bySku.get(sku)}/reviews`, {
      json: { rating, comment },
    });
    expectStatus(res, [201, 409], `a review of buyer ${index + 1}`);
    if (res.status === 201) reviews++;
  }
  for (const sku of buyer.favorites) {
    const res = await session.send('POST', `/api/favorites/${bySku.get(sku)}`);
    expectStatus(res, [200, 201, 409], `a favorite of buyer ${index + 1}`);
    if (res.status !== 409) favorites++;
  }
  return { reviews, favorites };
}

async function main() {
  for (const [name, value] of [
    ['DEMO_API_URL', API_URL],
    ['DEMO_ADMIN_EMAIL', ADMIN_EMAIL],
    ['DEMO_ADMIN_PASSWORD', ADMIN_PASSWORD],
    ['DEMO_USERS_PASSWORD', USERS_PASSWORD],
  ]) {
    if (!value) stop(`${name} is not set`);
  }
  let base;
  try {
    base = new URL(API_URL);
  } catch {
    stop('DEMO_API_URL is not a url');
  }
  for (const value of [
    API_URL,
    base.origin,
    base.host,
    base.hostname,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    USERS_PASSWORD,
    EMAIL_DOMAIN,
  ]) {
    secrets.add(value);
  }

  step('logging in as the admin');
  const admin = new Session(base);
  const account = await login(admin, ADMIN_EMAIL, ADMIN_PASSWORD, 'the login of the admin');
  if (account.role !== 'ADMIN' && account.role !== 'ROOT')
    stop('the account of DEMO_ADMIN_EMAIL is no admin');

  const categories = await makeCategories(admin);
  const { bySku, made } = await makeProducts(admin, base, categories);
  await deliverStock(admin, bySku, made);
  await putOnSale(admin, bySku, made);

  const inForce = await versionsInForce(base);
  const states = { ready: 0, waiting: 0, registered: 0 };
  let consents = 0;
  let orders = 0;
  let reviews = 0;
  let favorites = 0;
  for (const [index, buyer] of BUYERS.entries()) {
    const {
      session,
      state,
      consents: accepted = 0,
    } = await buyerSession(base, index, buyer, inForce);
    states[state]++;
    consents += accepted;
    if (!session) continue;
    if (!(await hasOrders(session, index))) {
      orders += await placeOrders(session, index, buyer, bySku);
    }
    const given = await reviewAndFavor(session, index, buyer, bySku);
    reviews += given.reviews;
    favorites += given.favorites;
  }

  step(
    `buyers: ${states.ready} logged in, ${states.registered} registered now, ` +
      `${states.waiting} wait for the confirmation of their email`,
  );
  if (states.ready < BUYERS.length) {
    console.log(
      '   a buyer logs in once the link of the mail sent at the registration confirms the email: ' +
        'open the mails and run again',
    );
    if (!process.env.DEMO_EMAIL_DOMAIN) {
      console.log(
        '   the mails went to example.com and reach nobody: set DEMO_EMAIL_DOMAIN to a domain ' +
          'whose mail you read',
      );
    }
  }
  step(
    `terms in force: ${inForce.length}, consents to new ones: ${consents} given; ` +
      `orders and carts: ${orders} made, reviews: ${reviews} made, favorites: ${favorites} made`,
  );
  step('done');
}

main().catch((err) => stop(`failed: ${err?.cause?.code ?? err?.message ?? err}`));
