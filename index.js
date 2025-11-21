import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import OpenAI from "openai";

const app = express();

// OpenAI Client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Tragetaschen-Mockup (ohne eigenes Design)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/Tragetasche_Mockup.jpg?v=1763713012";

// Hilfsfunktion: Bild herunterladen
async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bild-Download fehlgeschlagen: ${res.status} ${res.statusText} - ${url}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Hilfsfunktion: Design aus Mockup mit OpenAI extrahieren
async function extractDesignWithOpenAI(mockupBuffer) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY fehlt");
  }

  const base64Input = mockupBuffer.toString("base64");

  // WICHTIG: KEIN response_format MEHR
  const response = await client.images.generate({
    model: "gpt-image-1",
    prompt:
      "Das Bild zeigt ein Kissen-Mockup mit einem personalisierten Design. " +
      "Extrahiere EXAKT dieses Design (Bild + Text) ohne Hintergrund und ohne es zu verändern. " +
      "Gib das Design als PNG mit transparentem Hintergrund zurück.",
    size: "1024x1024",
    // image-Input (aktuelles SDK akzeptiert 'image' als Base64-String)
    image: base64Input,
    n: 1
  });

  // gpt-image-1 liefert immer b64_json
  const b64 = response.data[0].b64_json;
  const designPngBuffer = Buffer.from(b64, "base64");
  return designPngBuffer;
}

// Hilfsfunktion: Design auf Tragetasche setzen
async function composeDesignOnTote(designBuffer) {
  const mockupBuffer = await downloadImage(TOTE_MOCKUP_URL);
  const mockup = sharp(mockupBuffer);
  const meta = await mockup.metadata();

  const mockW = meta.width || 2000;
  const mockH = meta.height || 2000;

  // Breite des Designs relativ zur Tasche
  const targetWidth = Math.round(mockW * 0.55);

  const resizedDesign = await sharp(designBuffer)
    .resize({ width: targetWidth, fit: "inside" })
    .png()
    .toBuffer();

  // Position anpassen bis es optisch passt
  const left = Math.round(mockW * 0.22);
  const top = Math.round(mockH * 0.26);

  const composed = await sharp(mockupBuffer)
    .composite([
      {
        input: resizedDesign,
        left,
        top
      }
    ])
    .png()
    .toBuffer();

  return composed;
}

// Endpoint: /tote-preview
app.get("/tote-preview", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    // 1. Kissen-Mockup (_customization_image) laden
    const pillowMockup = await downloadImage(srcUrl);

    // 2. Design mit OpenAI extrahieren (transparentes PNG)
    const designPng = await extractDesignWithOpenAI(pillowMockup);

    // 3. Design auf Tragetasche setzen
    const totePreview = await composeDesignOnTote(designPng);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(totePreview);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).send("Internal server error");
  }
});

// Healthcheck
app.get("/", (_req, res) => {
  res.send("Teeinblue Artwork Backend läuft.");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
