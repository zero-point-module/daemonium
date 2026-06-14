/**
 * Generate the full favicon / app-icon / social-card set from the idle flame
 * (public/daemon/idle/full.webp), composited onto the app's dark ember backdrop so the flame
 * reads on any browser-tab color. Run with `node scripts/gen-icons.mjs`. Outputs:
 *   app/favicon.ico            — legacy multi-size icon (16/32/48, PNG-in-ICO)
 *   app/icon.png               — modern favicon (512²)
 *   app/apple-icon.png         — iOS home-screen icon (180²)
 *   app/opengraph-image.png    — social share card (1200×630)
 *   app/twitter-image.png      — same, for the summary_large_image card
 *   public/icons/icon-192.png, icon-512.png, maskable-512.png — PWA manifest icons
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const SRC = "public/daemon/idle/full.webp";
const EMBER = "#ff7a18";

/** A square dark backdrop (radial ember glow over near-black) as an SVG buffer. */
function squareBg(size) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="42%" r="75%">
        <stop offset="0%" stop-color="#160d07"/>
        <stop offset="55%" stop-color="#0a0604"/>
        <stop offset="100%" stop-color="#050505"/>
      </radialGradient>
      <radialGradient id="glow" cx="50%" cy="48%" r="42%">
        <stop offset="0%" stop-color="${EMBER}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    <rect width="${size}" height="${size}" fill="url(#glow)"/>
  </svg>`);
}

/** Render the flame centered on the dark square at the given scale → PNG buffer. */
async function squareIcon(size, scale) {
  const inner = Math.round(size * scale);
  const flame = await sharp(SRC).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp(squareBg(size))
    .composite([{ input: flame, gravity: "center" }])
    .png()
    .toBuffer();
}

/** Assemble a valid .ico holding PNG-encoded entries (modern browsers read PNG-in-ICO). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8); // size of image data
    e.writeUInt32LE(offset, 12); // offset
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/** The 1200×630 social card: dark room, wordmark + tagline on the left, the flame on the right. */
async function socialCard() {
  const W = 1200;
  const H = 630;
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="bg" cx="72%" cy="46%" r="80%">
        <stop offset="0%" stop-color="#1a0f08"/>
        <stop offset="52%" stop-color="#0a0604"/>
        <stop offset="100%" stop-color="#040303"/>
      </radialGradient>
      <radialGradient id="glow" cx="74%" cy="50%" r="34%">
        <stop offset="0%" stop-color="${EMBER}" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <text x="84" y="288" font-family="Helvetica, Arial, sans-serif" font-size="92" font-weight="700" letter-spacing="2" fill="#f6ecdd">Daemonium</text>
    <text x="86" y="356" font-family="Helvetica, Arial, sans-serif" font-size="33" font-weight="500" letter-spacing="6" fill="${EMBER}">SUMMON IGNIS</text>
    <text x="86" y="430" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="400" fill="#b9afa2">A living flame that speaks and acts</text>
    <text x="86" y="476" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="400" fill="#b9afa2">onchain — behind a human confirm gate.</text>
  </svg>`);
  const flameSize = 460;
  const flame = await sharp(SRC).resize(flameSize, flameSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp(bg)
    .composite([{ input: flame, left: W - flameSize - 60, top: Math.round((H - flameSize) / 2) }])
    .png()
    .toBuffer();
}

async function main() {
  await mkdir("public/icons", { recursive: true });

  // Modern favicon + iOS + PWA icons.
  await writeFile("app/icon.png", await squareIcon(512, 0.82));
  await writeFile("app/apple-icon.png", await squareIcon(180, 0.8));
  await writeFile("public/icons/icon-192.png", await squareIcon(192, 0.82));
  await writeFile("public/icons/icon-512.png", await squareIcon(512, 0.82));
  // Maskable: extra padding so Android's circle/squircle mask never clips the flame.
  await writeFile("public/icons/maskable-512.png", await squareIcon(512, 0.6));

  // Legacy favicon.ico — bigger flame at tiny sizes so it stays legible.
  const ico = buildIco([
    { size: 16, data: await squareIcon(16, 0.92) },
    { size: 32, data: await squareIcon(32, 0.9) },
    { size: 48, data: await squareIcon(48, 0.88) },
  ]);
  await writeFile("app/favicon.ico", ico);

  // Social cards (Open Graph + Twitter).
  const card = await socialCard();
  await writeFile("app/opengraph-image.png", card);
  await writeFile("app/twitter-image.png", card);

  console.log("icons + social cards generated");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
