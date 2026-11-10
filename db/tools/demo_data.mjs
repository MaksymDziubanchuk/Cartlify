// demo data of the shop made through its own routes, so it passes every check real data passes
// and keeps working while the database changes: a tree of categories, products with their variants
// (one, two or three each, every variant with its pictures of the gallery, its price and its
// article number, and the values of the characteristics that tell it from the others) and the data
// of safety, the stock of each variant by a delivery in batches,
// sales, a few buyers with carts, confirmed orders, reviews and favorites. What is there already
// stays: categories are found by slug, products by name, a buyer with orders gets no more; a run
// adds only what is missing.
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

// The registration asks for the answer of the captcha (Cloudflare Turnstile). The script has no widget:
// it sends the answer a dummy widget gives, which the dummy secret of Cloudflare takes for any answer.
// That secret is the TURNSTILE_SECRET_KEY of the tests, of a local server and of dev until the
// frontend has its widget; a server that holds the secret of a real widget refuses the answer
// (400 CAPTCHA_INVALID), and the buyers are not registered there
const CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

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

// what a product of a category weighs and measures packed: grams, then length, width and height in
// millimetres; the shop needs them to send an order
const PACKAGES = {
  phones: [350, 200, 110, 60],
  laptops: [2400, 420, 310, 70],
  headphones: [450, 220, 190, 90],
  kitchen: [1800, 320, 260, 200],
  lighting: [900, 300, 150, 150],
  books: [600, 240, 170, 40],
};

// The characteristics the variants of a product are told apart by (no two variants of a product
// have the same values of all of them). They go to the directory once, by name; a variant names
// its values by the key: a value of a list by its name, a number or a text as it is.
const GROUP = 'Demo characteristics';
const CHARACTERISTICS = {
  colour: {
    name: 'Colour',
    type: 'option',
    isMain: true,
    options: [
      { name: 'Black', colorCode: '#000000' },
      { name: 'White', colorCode: '#ffffff' },
      { name: 'Silver', colorCode: '#c0c0c0' },
      { name: 'Green', colorCode: '#2e8b57' },
    ],
  },
  storage: { name: 'Storage', type: 'number', unit: 'GB', decimals: 0 },
  size: { name: 'Size', type: 'text' },
};

// A product has one, two or three variants; what a buyer picks (memory, color, size) is a variant.
// values - what tells the variant from the others of its product (see CHARACTERISTICS).
// code - the number of the product, the article number of its variants is <code>-<their place>.
// A variant has: price; units - what a delivery brings; cost - what a unit cost the shop;
// sale - a percent off for 14 days; expiresIn - the last good day of the batch, days from today
const PRODUCTS = [
  {
    code: 'DEMO-001',
    name: 'Aurora X1 smartphone',
    category: 'phones',
    maker: 'devices',
    warnings: 'Keep the battery away from heat.',
    variants: [
      { price: 499, units: 25, cost: 320, values: { storage: 128 } },
      { price: 549, units: 18, cost: 350, values: { storage: 256 } },
      { price: 629, units: 10, cost: 410, values: { storage: 512 } },
    ],
  },
  {
    code: 'DEMO-002',
    name: 'Aurora X1 Mini smartphone',
    category: 'phones',
    maker: 'devices',
    variants: [
      { price: 379, units: 30, cost: 240, sale: 10, values: { storage: 64 } },
      { price: 429, units: 20, cost: 275, sale: 10, values: { storage: 128 } },
    ],
  },
  {
    code: 'DEMO-003',
    name: 'Nimbus Fold smartphone',
    category: 'phones',
    maker: 'devices',
    variants: [{ price: 1099, units: 8, cost: 760 }],
  },
  {
    code: 'DEMO-004',
    name: 'Vertex 14 laptop',
    category: 'laptops',
    maker: 'devices',
    variants: [
      { price: 1199, units: 12, cost: 850, sale: 15, values: { storage: 512 } },
      { price: 1499, units: 7, cost: 1080, sale: 15, values: { storage: 1024 } },
    ],
  },
  {
    code: 'DEMO-005',
    name: 'Vertex 16 Pro laptop',
    category: 'laptops',
    maker: 'devices',
    variants: [{ price: 1799, units: 6, cost: 1300 }],
  },
  {
    code: 'DEMO-006',
    name: 'Echo Buds wireless earbuds',
    category: 'headphones',
    maker: 'devices',
    warnings: 'Small parts, keep away from children.',
    variants: [
      { price: 89.9, units: 60, cost: 41, values: { colour: 'Black' } },
      { price: 89.9, units: 45, cost: 41, values: { colour: 'White' } },
      { price: 94.9, units: 30, cost: 44, values: { colour: 'Green' } },
    ],
  },
  {
    code: 'DEMO-007',
    name: 'Echo Studio over-ear headphones',
    category: 'headphones',
    maker: 'devices',
    variants: [
      { price: 199, units: 20, cost: 120, sale: 20, values: { colour: 'Black' } },
      { price: 219, units: 14, cost: 132, sale: 20, values: { colour: 'Silver' } },
    ],
  },
  {
    code: 'DEMO-008',
    name: 'Barista espresso machine',
    category: 'kitchen',
    maker: 'home',
    warnings: 'Hot surfaces while in use.',
    variants: [{ price: 349, units: 10, cost: 210 }],
  },
  {
    code: 'DEMO-009',
    name: 'Ceramic chef knife',
    category: 'kitchen',
    maker: 'home',
    warnings: 'Sharp blade.',
    variants: [
      { price: 59.9, units: 40, cost: 22, values: { size: '15 cm' } },
      { price: 69.9, units: 25, cost: 27, values: { size: '20 cm' } },
    ],
  },
  {
    code: 'DEMO-010',
    name: 'Single origin coffee beans',
    category: 'kitchen',
    maker: 'home',
    variants: [
      { price: 24.5, units: 80, cost: 11, expiresIn: 120, values: { size: '1 kg' } },
      { price: 7.5, units: 120, cost: 3.4, expiresIn: 120, values: { size: '250 g' } },
    ],
  },
  {
    code: 'DEMO-011',
    name: 'Green tea, 100 bags',
    category: 'kitchen',
    maker: 'home',
    variants: [{ price: 8.9, units: 120, cost: 3.2, expiresIn: 5 }],
  },
  {
    code: 'DEMO-012',
    name: 'Arc floor lamp',
    category: 'lighting',
    maker: 'home',
    variants: [
      { price: 129, units: 15, cost: 70, values: { colour: 'Black' } },
      { price: 139, units: 9, cost: 76, values: { colour: 'White' } },
    ],
  },
  {
    code: 'DEMO-013',
    name: 'Smart bulb E27, two pack',
    category: 'lighting',
    maker: 'home',
    variants: [{ price: 29.9, units: 100, cost: 12, sale: 25 }],
  },
  {
    code: 'DEMO-014',
    name: 'The Pragmatic Shopkeeper, paperback',
    category: 'books',
    maker: 'books',
    variants: [{ price: 19.9, units: 50, cost: 7 }],
  },
  {
    code: 'DEMO-015',
    name: 'Databases in Depth, hardcover',
    category: 'books',
    maker: 'books',
    variants: [{ price: 44, units: 25, cost: 18 }],
  },
  {
    code: 'DEMO-016',
    name: 'A Short History of Trade',
    category: 'books',
    maker: 'books',
    variants: [{ price: 14.5, units: 35, cost: 5.5 }],
  },
];

// the article number of the variant at the place n (from 1) of a product
const skuOf = (product, n) => `${product.code}-${n}`;

// what each buyer does: a confirmed order, and a cart left after it. An item of an order and a
// favorite name a variant by its article number; a review names a product by its code. Olena keeps
// two variants of one laptop among her favorites: the product counts her once
const BUYERS = [
  {
    name: 'Olena',
    orders: [
      {
        items: [
          ['DEMO-001-2', 1],
          ['DEMO-006-1', 2],
        ],
        confirm: true,
      },
    ],
    reviews: [
      ['DEMO-001', 5, 'Fast, bright screen, the battery lasts two days.'],
      ['DEMO-006', 4, 'Good sound for the price.'],
      ['DEMO-014', 5, 'Read it in one evening.'],
    ],
    favorites: ['DEMO-004-1', 'DEMO-004-2', 'DEMO-008-1'],
  },
  {
    name: 'Marco',
    orders: [
      {
        items: [
          ['DEMO-008-1', 1],
          ['DEMO-010-1', 2],
        ],
        confirm: true,
      },
      { items: [['DEMO-013-1', 3]], confirm: false },
    ],
    reviews: [
      ['DEMO-008', 5, 'Makes a proper espresso.'],
      ['DEMO-010', 4, 'Fruity and fresh.'],
    ],
    favorites: ['DEMO-005-1', 'DEMO-012-2', 'DEMO-007-1'],
  },
  {
    name: 'Sofia',
    orders: [
      {
        items: [
          ['DEMO-015-1', 1],
          ['DEMO-016-1', 1],
        ],
        confirm: false,
      },
    ],
    reviews: [
      ['DEMO-015', 4, 'Dense, but worth it.'],
      ['DEMO-012', 3, 'Nice light, the cable is short.'],
    ],
    favorites: ['DEMO-002-1', 'DEMO-011-1'],
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

// the products of the demo the catalog has, by name (the code of a product is the article number
// of its variants, which a buyer does not see in the catalog); the catalog a guest sees, every
// product of it
async function demoProductsIn(base, categoryIds) {
  const guest = new Session(base);
  const names = new Set(PRODUCTS.map((product) => product.name));
  const byName = new Map();
  let cursor = null;
  do {
    const query = new URLSearchParams({ categoryIds: categoryIds.join(','), limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const res = expectStatus(
      await guest.send('GET', `/api/products?${query}`),
      [200],
      'the catalog',
    );
    for (const row of res.body.items) {
      if (names.has(row.product.name)) byName.set(row.product.name, row.product.id);
    }
    cursor = res.body.nextCursor ?? null;
  } while (cursor);
  return byName;
}

// the manufacturers go to the directory once, a product names one by its id; a manufacturer the
// directory has already (a second run) gives its id with the refusal
async function makeManufacturers(admin) {
  const ids = new Map();

  for (const [key, maker] of Object.entries(MAKERS)) {
    const res = await admin.send('POST', '/api/admin/parties', { json: maker });
    expectStatus(res, [201, 409], `the manufacturer ${maker.name}`);
    ids.set(key, res.status === 201 ? res.body.id : res.body.details.partyId);
  }

  step(`manufacturers: ${ids.size} in the directory`);
  return ids;
}

// The characteristics of the demo go to the directory once: found by name, made when there is none
// (a group of their own holds them), each choice with its values. Gives the id of each characteristic
// by its key, and the id of each value of a list by its name
async function makeCharacteristics(admin) {
  const groups = expectStatus(
    await admin.send('GET', '/api/admin/attribute-groups'),
    [200],
    'the groups',
  );
  let groupId = groups.body.items.find((group) => group.name === GROUP)?.id;
  if (groupId === undefined) {
    const res = await admin.send('POST', '/api/admin/attribute-groups', { json: { name: GROUP } });
    groupId = expectStatus(res, [201], 'the group of the characteristics').body.id;
  }

  const found = new Map();
  for (const [key, spec] of Object.entries(CHARACTERISTICS)) {
    const query = new URLSearchParams({ q: spec.name });
    const list = expectStatus(
      await admin.send('GET', `/api/admin/attributes?${query}`),
      [200],
      `the characteristic ${spec.name}`,
    );
    let attribute = list.body.items.find(
      (item) => item.name.toLowerCase() === spec.name.toLowerCase(),
    );
    if (!attribute) {
      const res = await admin.send('POST', '/api/admin/attributes', {
        json: {
          name: spec.name,
          type: spec.type,
          groupId,
          ...(spec.unit ? { unit: spec.unit } : {}),
          ...(spec.isMain ? { isMain: true } : {}),
          ...(spec.decimals !== undefined ? { decimals: spec.decimals } : {}),
        },
      });
      attribute = expectStatus(res, [201], `the characteristic ${spec.name}`).body;
    }

    const options = new Map();
    for (const option of spec.options ?? []) {
      const listed = expectStatus(
        await admin.send('GET', `/api/admin/attributes/${attribute.id}/options`),
        [200],
        `the values of ${spec.name}`,
      );
      let value = listed.body.items.find(
        (item) => item.name.toLowerCase() === option.name.toLowerCase(),
      );
      if (!value) {
        const res = await admin.send('POST', `/api/admin/attributes/${attribute.id}/options`, {
          json: option,
        });
        value = expectStatus(res, [201], `the value ${option.name}`).body;
      }
      options.set(option.name, value.id);
    }

    found.set(key, { id: attribute.id, type: spec.type, options });
  }

  step(`characteristics: ${found.size} in the directory`);
  return found;
}

// the values of a variant as the form of a product sends them
function attributesOf(variant, characteristics) {
  return Object.entries(variant.values ?? {}).map(([key, value]) => {
    const characteristic = characteristics.get(key);
    return {
      attributeId: characteristic.id,
      value: characteristic.type === 'option' ? characteristic.options.get(value) : value,
    };
  });
}

// The pictures of a product are uploaded once, to its gallery, and each variant picks its own from
// it: the first file is shown by every variant (as its second picture), and each variant has a
// file of its own (its first, the main one). The variants are told apart by their place.
async function makeProducts(admin, base, categories, manufacturers, characteristics) {
  const found = await demoProductsIn(base, [...categories.values()]);
  const ids = new Map();
  // the variants of each product by their article numbers
  const variantIds = new Map();
  const made = [];

  const keepVariants = (product, variants) => {
    for (const [n, variant] of variants.entries())
      variantIds.set(skuOf(product, n + 1), variant.id);
  };

  for (const [index, product] of PRODUCTS.entries()) {
    if (found.has(product.name)) {
      ids.set(product.code, found.get(product.name));
      continue;
    }

    const res = await admin.send('POST', '/api/products', {
      form: () => {
        const form = new FormData();
        form.append('name', product.name);
        form.append(
          'description',
          `${product.name}: a product of the demo catalog of the shop, made to show its pages.`,
        );
        form.append('categoryId', String(categories.get(product.category)));
        form.append('manufacturerId', String(manufacturers.get(product.maker)));
        if (product.warnings) form.append('warnings', product.warnings);

        const [weight, length, width, height] = PACKAGES[product.category];
        form.append(
          'variants',
          JSON.stringify(
            product.variants.map((variant, n) => ({
              sku: skuOf(product, n + 1),
              price: variant.price,
              weightGrams: weight,
              lengthMm: length,
              widthMm: width,
              heightMm: height,
              images: [
                { file: n + 1, position: 1 },
                { file: 0, position: 2 },
              ],
              attributes: attributesOf(variant, characteristics),
            })),
          ),
        );

        // file 0 is the picture all the variants share, file n + 1 belongs to the variant n
        for (let n = 0; n <= product.variants.length; n++) {
          const image = new Blob([pngImage(index * 4 + n + 1)], { type: 'image/png' });
          form.append('images', image, `${product.code.toLowerCase()}-${n}.png`);
        }
        return form;
      },
    });
    expectStatus(res, [201], `the product ${product.code}`);
    ids.set(product.code, res.body.product.id);
    keepVariants(product, res.body.variants);
    made.push(product);
  }

  // the variants of the products that were there: the card of an admin lists them by their place
  for (const product of PRODUCTS) {
    if (variantIds.has(skuOf(product, 1))) continue;
    const card = expectStatus(
      await admin.send('GET', `/api/products/${ids.get(product.code)}`),
      [200],
      `the card of ${product.code}`,
    );
    keepVariants(product, card.body.variants);
  }

  step(`products: ${made.length} made, ${PRODUCTS.length - made.length} there already`);
  return { ids, variantIds, made };
}

// the stock of the new products comes the way real stock comes: a delivery of a supplier, a batch
// for each variant
async function deliverStock(admin, variantIds, made) {
  if (!made.length) return;
  const items = made.flatMap((product) =>
    product.variants.map((variant, n) => ({
      variantId: variantIds.get(skuOf(product, n + 1)),
      quantity: variant.units,
      unitCost: variant.cost,
      ...(variant.expiresIn ? { expiresAt: dayFromToday(variant.expiresIn) } : {}),
    })),
  );
  const res = await admin.send('POST', '/api/products/stock/deliveries', {
    json: {
      source: 'supplier',
      supplier: 'Demo Wholesale Ltd',
      document: `DEMO-${randomBytes(3).toString('hex').toUpperCase()}`,
      note: 'The stock of the demo catalog.',
      items,
    },
  });
  expectStatus(res, [201], 'the delivery of the stock');
  step(`stock: ${items.length} variants of ${made.length} products delivered`);
}

async function putOnSale(admin, variantIds, made) {
  const onSale = made.flatMap((product) =>
    product.variants.flatMap((variant, n) =>
      variant.sale
        ? [{ variantId: variantIds.get(skuOf(product, n + 1)), percent: variant.sale }]
        : [],
    ),
  );
  if (!onSale.length) return;
  const endsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const res = await admin.send('POST', '/api/products/sales', {
    json: {
      items: onSale.map((one) => ({
        variantId: one.variantId,
        sale: { percent: one.percent, endsAt },
      })),
    },
  });
  expectStatus(res, [200, 201], 'the sales');
  step(`sales: ${onSale.length} variants on sale for 14 days`);
}

// the ids of the versions of the terms and of the contract in force; none while root published none.
// The privacy policy is in force too, and nobody accepts it
async function versionsInForce(base) {
  const res = expectStatus(
    await new Session(base).send('GET', '/api/legal/documents/current'),
    [200],
    'the terms in force',
  );
  return res.body.items.filter((doc) => doc.kind !== 'privacy').map((doc) => doc.id);
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
      captchaToken: CAPTCHA_TOKEN,
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

// a postal code of the form each country writes it, for the countries the shop may deliver to
const SAMPLE_POSTAL_CODES = {
  UA: '01001',
  PL: '00-950',
  DE: '10115',
  FR: '75001',
  ES: '28001',
  IT: '00100',
  NL: '1011 AB',
  BE: '1000',
  AT: '1010',
  CZ: '110 00',
  SK: '811 01',
  PT: '1000-001',
  SE: '111 22',
  GB: 'SW1A 1AA',
  CH: '8001',
};

// how the demo orders are delivered, as the shop offers it now: to an address of the first country
// of the manual method, else a pickup
async function deliveryOfDemo(base) {
  const res = await new Session(base).send('GET', '/api/delivery/methods');
  expectStatus(res, [200], 'the delivery methods of the shop');
  const manual = res.body.methods.find((method) => method.method === 'manual');
  const country = manual?.countries.find((code) => SAMPLE_POSTAL_CODES[code]);
  if (manual && country) {
    return {
      method: 'manual',
      address: {
        country,
        postalCode: SAMPLE_POSTAL_CODES[country],
        city: 'Demo city',
        street: 'Demo street',
        house: '1',
      },
    };
  }
  if (res.body.methods.some((method) => method.method === 'pickup')) return { method: 'pickup' };

  return stop(
    'the shop offers no delivery the demo orders can use: set DELIVERY_COUNTRIES or DELIVERY_METHODS',
  );
}

async function placeOrders(session, index, buyer, variantIds, delivery) {
  let placed = 0;
  for (const order of buyer.orders) {
    // the cart the items went into, the answer of each item names it with the price of each
    // delivery for what it holds now
    let orderId;
    let quotes = [];
    for (const [sku, quantity] of order.items) {
      const res = await session.send('POST', '/api/orders/current/items', {
        json: { variantId: variantIds.get(sku), quantity },
      });
      expectStatus(res, [200, 201], `the cart of buyer ${index + 1}`);
      orderId = res.body.id;
      quotes = res.body.deliveryQuotes ?? [];
    }
    if (order.confirm) {
      // the price of the delivery the page shows, as a buyer confirms it
      const quote = quotes.find((one) => one.method === delivery.method);
      const res = await session.send('POST', '/api/orders/current/confirm', {
        json: {
          orderId,
          expectedDeliveryPrice: quote?.price ?? 0,
          delivery: {
            ...delivery,
            recipientFirstName: buyer.name,
            recipientLastName: 'Demo',
            recipientPhone: `+38067111223${index + 1}`,
          },
        },
      });
      expectStatus(res, [200], `the order of buyer ${index + 1}`);
    }
    placed++;
  }
  return placed;
}

// a review or a favorite given before answers 409: it is there already
async function reviewAndFavor(session, index, buyer, productIds, variantIds) {
  let reviews = 0;
  let favorites = 0;
  for (const [code, rating, comment] of buyer.reviews) {
    const res = await session.send('POST', `/api/products/${productIds.get(code)}/reviews`, {
      json: { rating, comment },
    });
    expectStatus(res, [201, 409], `a review of buyer ${index + 1}`);
    if (res.status === 201) reviews++;
  }
  for (const sku of buyer.favorites) {
    const res = await session.send('POST', `/api/favorites/${variantIds.get(sku)}`);
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
  const manufacturers = await makeManufacturers(admin);
  const characteristics = await makeCharacteristics(admin);
  const {
    ids: productIds,
    variantIds,
    made,
  } = await makeProducts(admin, base, categories, manufacturers, characteristics);
  await deliverStock(admin, variantIds, made);
  await putOnSale(admin, variantIds, made);

  const inForce = await versionsInForce(base);
  const delivery = await deliveryOfDemo(base);
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
      orders += await placeOrders(session, index, buyer, variantIds, delivery);
    }
    const given = await reviewAndFavor(session, index, buyer, productIds, variantIds);
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
