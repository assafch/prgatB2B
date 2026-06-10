// Generate the PWA icons (192/512, maskable-safe) from an inline SVG.
// Run: node scripts/make-icons.mjs
import sharp from 'sharp';
import fs from 'node:fs';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" fill="#c8102e"/>
  <text x="256" y="248" font-family="Heebo, Arial Hebrew, Arial, sans-serif"
        font-size="148" font-weight="700" fill="#ffffff" text-anchor="middle">אורגת</text>
  <text x="256" y="390" font-family="Heebo, Arial, sans-serif"
        font-size="100" font-weight="700" fill="#ffd9de" text-anchor="middle">B2B</text>
</svg>`;

fs.mkdirSync('public/icons', { recursive: true });
for (const size of [192, 512]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`public/icons/icon-${size}.png`);
  console.log(`icon-${size}.png written`);
}
