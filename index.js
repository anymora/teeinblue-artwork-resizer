// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Tragetaschen-Mockup (Hintergrund)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Einfacher In-Memory-Cache: artworkUrl -> fertiges PNG
const previewCache = new Map(); // key: artworkUrl, value: Buffer

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (direktes Artwork auf Tragetasche) läuft.");
});

/**
 * GET /tote-preview?url=<URL_DES_ARTWORK-BILDES>
 *
 * Erwartet: Ein Bild, bei dem das Design schon freigestellt oder direkt verwendbar ist
 * (z.B. aus _customization_image).
 * Ablauf:
 * 1. Artwork von der URL laden
 * 2. Tragetaschen-Mockup laden
 * 3. Artwork sinnvoll skalieren
 * 4. Artwork auf Mockup compositen (Position wie vorher)
 * 5. Fertiges PNG zurückgeben
 */
app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res
      .status(400)
      .json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  // 0. Cache-Hit? -> sofort zurück (zweiter Aufruf für dasselbe Design ist dann sofort)
  if (previewCache.has(artworkUrl)) {
    const cachedBuffer = previewCache.get(artworkUrl);
    res.setHeader("Content-Type", "image/png");
    return res.send(cachedBuffer);
  }

  try {
    // 1. Artwork laden
    const artResp = await fetch(artworkUrl);
    if (!artResp.ok) {
      return res.status(400).json({
        error: "Konnte Artwork-Bild nicht laden.",
        detail: `HTTP ${artResp.status}`,
      });
    }
    const artArrayBuf = await artResp.arrayBuffer();
    let artBuffer = Buffer.from(artArrayBuf);

    // Sicherheit: PNG + Alphakanal erzwingen
    artBuffer = await sharp(artBuffer)
      .ensureAlpha()
      .png()
      .toBuffer();

    // 2. Tragetaschen-Mockup laden
    const toteResp = await fetch(TOTE_MOCKUP_URL);
    if (!toteResp.ok) {
      return res.status(500).json({
        error: "Konnte Tragetaschen-Mockup nicht laden.",
        detail: `HTTP ${toteResp.status}`,
      });
    }
    const toteArrayBuf = await toteResp.arrayBuffer();
    const toteBuffer = Buffer.from(toteArrayBuf);

    const toteSharp = sharp(toteBuffer);
    const toteMeta = await toteSharp.metadata();

    if (!toteMeta.width || !toteMeta.height) {
      return res
        .status(500)
        .json({ error: "Konnte Größe des Tragetaschen-Mockups nicht lesen." });
    }

    // 3. Artwork skalieren (Breite ~45% der Tasche – wie vorher)
    const designOnToteBuffer = await sharp(artBuffer)
      .resize(Math.round(toteMeta.width * 0.45), null, {
        fit: "inside",
        fastShrinkOnLoad: true,
      })
      .png()
      .toBuffer();

    // 4. Position auf der Tasche:
    // - etwas weiter nach links (0.26)
    // - etwas weiter nach unten (0.36)
    const offsetLeft = Math.round(toteMeta.width * 0.26);
    const offsetTop = Math.round(toteMeta.height * 0.36);

    const finalBuffer = await toteSharp
      .composite([
        {
          input: designOnToteBuffer,
          left: offsetLeft,
          top: offsetTop,
        },
      ])
      .png()
      .toBuffer();

    // 5. In Cache legen (für zukünftige Aufrufe mit gleicher URL)
    previewCache.set(artworkUrl, finalBuffer);

    // 6. Fertiges Bild zurückgeben
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    return res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// Server starten
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
