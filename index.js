import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Zielgröße für Tragetaschen-Design
const TARGET_WIDTH = 2953;
const TARGET_HEIGHT = 3543;

// Mockup-Bild der Tragetasche (Basis für Vorschau)
// Wenn du das Mockup mal änderst, hier einfach die URL tauschen.
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

// erzeugt das neue gepaddete Design (2953x3543, transparent oben/unten)
async function createPaddedDesignBuffer(srcBuffer) {
  const meta = await sharp(srcBuffer).metadata();
  const origWidth = meta.width || TARGET_WIDTH;
  const origHeight = meta.height || TARGET_WIDTH;

  // Skaliere auf volle Breite, Höhe proportional
  const scale = TARGET_WIDTH / origWidth;
  const newHeight = Math.round(origHeight * scale);

  const paddingTotal = Math.max(TARGET_HEIGHT - newHeight, 0);
  const topPadding = Math.floor(paddingTotal / 2);
  const bottomPadding = paddingTotal - topPadding;

  const outputBuffer = await sharp(srcBuffer)
    .resize({
      width: TARGET_WIDTH,
      height: newHeight,
      fit: "fill"
    })
    .extend({
      top: topPadding,
      bottom: bottomPadding,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    })
    .png({
      force: true,
      compressionLevel: 9
    })
    .toBuffer();

  return outputBuffer;
}

// 1) Nur das neue Design (für _tib_design_link_1)
app.get("/tote-design", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    const srcBuffer = await fetchImageBuffer(srcUrl);
    const designBuffer = await createPaddedDesignBuffer(srcBuffer);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(designBuffer);
  } catch (err) {
    console.error("Error in /tote-design:", err);
    res.status(500).send("Internal server error");
  }
});

// Alias, falls irgendwo noch /format-tote verwendet wird
app.get("/format-tote", async (req, res) => {
  return app._router.handle(
    { ...req, url: "/tote-design" + req.url.slice(req.url.indexOf("?")) },
    res,
    () => {}
  );
});

// 2) Tragetaschen-Mockup mit Design drauf (für _customization_image)
app.get("/tote-mockup", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    // Original-Design holen
    const srcBuffer = await fetchImageBuffer(srcUrl);
    // als erstes das gepaddete Design erzeugen
    const paddedDesign = await createPaddedDesignBuffer(srcBuffer);

    // Mockup laden
    const mockupBuffer = await fetchImageBuffer(TOTE_MOCKUP_URL);
    const mockupSharp = sharp(mockupBuffer);
    const mockMeta = await mockupSharp.metadata();

    const mockWidth = mockMeta.width || 2000;
    const mockHeight = mockMeta.height || 2000;

    // Design-Breite relativ zur Tasche
    const designTargetWidth = Math.round(mockWidth * 0.38); // Feintuning möglich
    const resizedDesignBuffer = await sharp(paddedDesign)
      .resize({
        width: designTargetWidth,
        height: null,
        fit: "inside"
      })
      .toBuffer();

    // Position des Designs auf der Tasche (links/rechts/oben/unten)
    const left = Math.round(mockWidth * 0.30);  // leicht nach links
    const top = Math.round(mockHeight * 0.43);  // etwas nach unten

    const finalMockup = await sharp(mockupBuffer)
      .composite([
        {
          input: resizedDesignBuffer,
          left,
          top
        }
      ])
      .png()
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(finalMockup);
  } catch (err) {
    console.error("Error in /tote-mockup:", err);
    res.status(500).send("Internal server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Artwork resizer listening on port ${PORT}`);
});
