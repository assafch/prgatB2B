// Seed fake FMCG catalog + personalized pricing for the demo customer.
// Lets you exercise the customer UI without a real Priority PAT.
// Run: node scripts/seed-demo-catalog.mjs

import Database from 'better-sqlite3';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('foreign_keys = ON');

const DEMO_CUSTNAME = 'DEMO001';

const families = [
  { code: '01', desc: 'משקאות' },
  { code: '02', desc: 'חטיפים וממתקים' },
  { code: '03', desc: 'מזון יבש' },
  { code: '04', desc: 'ניקיון וטואלטיקה' },
];

const products = [
  { partname: 'COKE-15',   partdes: 'קוקה קולה 1.5 ליטר',           family: '01', barcode: '7290000000011', list: 8.90,  personal: 7.50,  box: 12 },
  { partname: 'SPRITE-15', partdes: 'ספרייט 1.5 ליטר',               family: '01', barcode: '7290000000012', list: 8.90,  personal: 7.50,  box: 12 },
  { partname: 'WATER-2',   partdes: 'מי עדן 2 ליטר',                family: '01', barcode: '7290000000013', list: 4.50,  personal: 3.80,  box: 6  },
  { partname: 'JUICE-1',   partdes: 'מיץ תפוזים פרי הגליל 1 ליטר',  family: '01', barcode: '7290000000014', list: 12.90, personal: 11.20, box: 12 },

  { partname: 'BAMBA-80',  partdes: 'במבה אסם 80 גרם',              family: '02', barcode: '7290000000021', list: 5.50,  personal: 4.20,  box: 24 },
  { partname: 'BISLI-70',  partdes: 'ביסלי גריל 70 גרם',            family: '02', barcode: '7290000000022', list: 5.50,  personal: 4.20,  box: 24 },
  { partname: 'PESEK-100', partdes: 'פסק זמן עלית 100 גרם',         family: '02', barcode: '7290000000023', list: 7.90,  personal: 6.50,  box: 18 },
  { partname: 'PRINGLES',  partdes: 'פרינגלס מקור 165 גרם',         family: '02', barcode: '7290000000024', list: 14.90, personal: 12.50, box: 12 },

  { partname: 'PASTA-500', partdes: 'פסטה אסם פנה 500 גרם',         family: '03', barcode: '7290000000031', list: 6.90,  personal: 5.40,  box: 20 },
  { partname: 'RICE-1KG',  partdes: 'אורז סוגאט 1 ק״ג',             family: '03', barcode: '7290000000032', list: 12.90, personal: 10.80, box: 12 },
  { partname: 'OIL-1L',    partdes: 'שמן זית כתית מעולה 1 ליטר',    family: '03', barcode: '7290000000033', list: 49.90, personal: 42.00, box: 6  },
  { partname: 'TOMATO-CN', partdes: 'רסק עגבניות יכין 500 גרם',     family: '03', barcode: '7290000000034', list: 7.50,  personal: 6.20,  box: 24 },

  { partname: 'SOAP-DISH', partdes: 'סבון כלים סנו 750 מ״ל',         family: '04', barcode: '7290000000041', list: 11.90, personal: 9.50,  box: 12 },
  { partname: 'LAUNDRY-3', partdes: 'אבקת כביסה אריאל 3 ק״ג',        family: '04', barcode: '7290000000042', list: 39.90, personal: 33.00, box: 4  },
  { partname: 'TOILET-12', partdes: 'נייר טואלט סופט 12 גלילים',     family: '04', barcode: '7290000000043', list: 24.90, personal: 21.00, box: 8  },
];

const upsertProduct = db.prepare(`
  INSERT INTO catalog_cache (partname, partdes, family, family_desc, barcode, list_price, box_size, active, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  ON CONFLICT(partname) DO UPDATE SET
    partdes = excluded.partdes,
    family = excluded.family,
    family_desc = excluded.family_desc,
    barcode = excluded.barcode,
    list_price = excluded.list_price,
    box_size = excluded.box_size,
    active = 1,
    updated_at = datetime('now')
`);

const upsertPrice = db.prepare(`
  INSERT INTO customer_pricing (custname, partname, price, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(custname, partname) DO UPDATE SET
    price = excluded.price,
    updated_at = datetime('now')
`);

const tx = db.transaction(() => {
  for (const p of products) {
    const fam = families.find((f) => f.code === p.family);
    upsertProduct.run(p.partname, p.partdes, p.family, fam?.desc ?? null, p.barcode, p.list, p.box);
    upsertPrice.run(DEMO_CUSTNAME, p.partname, p.personal);
  }
});

tx();

const productCount = db.prepare('SELECT COUNT(*) as c FROM catalog_cache').get().c;
const pricingCount = db.prepare('SELECT COUNT(*) as c FROM customer_pricing WHERE custname = ?').get(DEMO_CUSTNAME).c;

console.log(`✓ Seeded ${productCount} products and ${pricingCount} customer-specific prices for ${DEMO_CUSTNAME}`);

db.close();
