// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// User-Agent, damit Shopify-CDN nicht rumzickt
const SHOPIFY_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/*,*/*",
};

// Mockup-URLs
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1833.jpg?v=1764169061";

// In-Memory Cache: key -> Buffer (PNG)
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (ohne BG-Removal, Tasche + Tasse) läuft.");
});

// --------------------------------------------------
// Hilfsfunktion: Bild von URL laden
// --------------------------------------------------
async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

// --------------------------------------------------
// Artwork direkt auf Mockup legen (ohne BG-Entfernung)
// --------------------------------------------------
async function placeArtworkOnMockup(artworkUrl, mockupUrl, scale, offsetX, offsetY) {
  // Artwork laden
  const artBuf = await loadImage(artworkUrl);
  // Sicherstellen, dass wir ein PNG mit Alpha haben (falls wir später doch Transparenz haben wollen)
  const artPng = await sharp(artBuf).ensureAlpha().png().toBuffer();

  // Mockup laden
  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Konnte Mockup-Abmessungen nicht lesen.");
  }

  // Artwork skalieren (Breite = scale * Mockup-Breite)
  const scaledArt = await sharp(artPng)
    .resize(Math.round(meta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const left = Math.round(meta.width * offsetX);
  const top = Math.round(meta.height * offsetY);

  // Artwork auf Mockup kompositen
  const finalBuffer = await mockSharp
    .composite([{ input: scaledArt, left, top }])
    .png()
    .toBuffer();

  return finalBuffer;
}

// --------------------------------------------------
// /tote-preview – Artwork auf Tragetasche
// --------------------------------------------------
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TOTE_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    // Skala und Position wie bei der Transparent-Variante
    const finalPng = await placeArtworkOnMockup(
      artworkUrl,
      TOTE_MOCKUP_URL,
      0.42, // 42 % der Breite der Tasche
      0.26, // etwas links
      0.46  // etwas tiefer
    );

    previewCache.set(cacheKey, finalPng);
    res.setHeader("Content-Type", "image/png");
    res.send(finalPng);
  } catch (err) {
    console.error("Fehler in /tote-preview (no-bg):", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview (no-bg)",
      detail: err.message || String(err),
    });
  }
});

// --------------------------------------------------
// /mug-preview – Artwork auf Tasse
// --------------------------------------------------
app.get("/mug-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "MUG_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    // Skala & Position für Tasse (kleiner, zentriert vorne)
    const finalPng = await placeArtworkOnMockup(
      artworkUrl,
      MUG_MOCKUP_URL,
      0.26, // ~26 % der Breite der Tasse
      0.37, // etwas rechts der Mitte
      0.38  // etwas unterhalb der Mitte
    );

    previewCache.set(cacheKey, finalPng);
    res.setHeader("Content-Type", "image/png");
    res.send(finalPng);
  } catch (err) {
    console.error("Fehler in /mug-preview (no-bg):", err);
    res.status(500).json({
      error: "Interner Fehler in /mug-preview (no-bg)",
      detail: err.message || String(err),
    });
  }
});

// --------------------------------------------------
// Serverstart
// --------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
