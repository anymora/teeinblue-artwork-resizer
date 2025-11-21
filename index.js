import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

const TARGET_WIDTH = 2953;
const TARGET_HEIGHT = 3543;

app.get("/format-tote", async (req, res) => {
  try {
    const srcUrl = req.query.url;
    if (!srcUrl) {
      return res.status(400).send("Missing ?url parameter");
    }

    const response = await fetch(srcUrl);
    if (!response.ok) {
      console.error("Fetch failed:", response.status, await response.text());
      return res
        .status(502)
        .send("Failed to fetch source image from Teeinblue URL");
    }

    const buffer = await response.arrayBuffer();
    const inputBuffer = Buffer.from(buffer);

    const meta = await sharp(inputBuffer).metadata();
    const origWidth = meta.width || TARGET_WIDTH;
    const origHeight = meta.height || TARGET_WIDTH;

    const scale = TARGET_WIDTH / origWidth;
    const newHeight = Math.round(origHeight * scale);

    const paddingTotal = Math.max(TARGET_HEIGHT - newHeight, 0);
    const topPadding = Math.floor(paddingTotal / 2);
    const bottomPadding = paddingTotal - topPadding;

    const outputBuffer = await sharp(inputBuffer)
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

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(outputBuffer);
  } catch (err) {
    console.error("Error in /format-tote:", err);
    res.status(500).send("Internal server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Artwork resizer listening on port ${PORT}`);
});
