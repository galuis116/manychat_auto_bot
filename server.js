// import dependencies
const express = require("express");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const fs = require("fs-extra");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const https = require("https");
const http = require("http");

// load env variables
const STRIPE_SECRET_KEY =
  process.env.PROD === "True"
    ? process.env.PROD_STRIPE_SECRET_KEY
    : process.env.TEST_STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET =
  process.env.PROD === "True"
    ? process.env.PROD_STRIPE_WEBHOOK_SECRET
    : process.env.TEST_STRIPE_WEBHOOK_SECRET;

// init app
const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// SSL Certificate paths (update with your win-acme PEM folder)
const sslOptions = {
  key: fs.readFileSync("C:/tools/frustrationcourtserwer.com-key.pem"),
  cert: fs.readFileSync("C:/tools/frustrationcourtserwer.com-fullchain.pem"),
  minVersion: "TLSv1.2",        // recommended
  honorCipherOrder: true
};


// SQLite setup
const dbPath = path.join(__dirname, "verdict_images.db");
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`
	CREATE TABLE IF NOT EXISTS images (
	  item_id TEXT PRIMARY KEY,
	  case_details TEXT,
	  verdict TEXT,
	  image_url TEXT,
	  status TEXT,
	  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
  `);
});

// Use JSON for all routes EXCEPT /webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  express.json()(req, res, next);
});

// Log every request for debugging
app.use("/static", (req, res, next) => {
  console.log(`[STATIC] Incoming request: ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Serve static folder with explicit options
app.use(
  "/static",
  express.static(path.join(__dirname, "public", "images"), {
    dotfiles: "ignore",
    index: false,
    maxAge: "1d",
    redirect: false,
  })
);
// ---- helper: increment credits ----
async function incrementCredits(subscriberId, credit) {
  const resp = await fetch(
    `https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  const data = await resp.json();
  const subscriber = data?.data;

  if (!subscriber) {
    console.log(`Subscriber ${subscriberId} not found`);
    return;
  }

  let currentCredits =
    subscriber.custom_fields?.find((f) => f.name === "credits")?.value ?? 0;
  currentCredits = Number(currentCredits) || 0;

  const newCredits = currentCredits + Number(credit);

  const setResp = await fetch(
    "https://api.manychat.com/fb/subscriber/setCustomField",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        field_id: 12880026,
        field_name: "credits",
        field_value: newCredits,
      }),
    }
  );

  const setData = await setResp.json();
  console.log("Set credits response:", subscriberId, JSON.stringify(setData));
  console.log(`Credits updated from ${currentCredits} → ${newCredits}`);
  return newCredits;
}

// ---- endpoint: create checkout session ----
app.post("/create-checkout-session", express.json(), async (req, res) => {
  const {
    client_reference_id,
    sue_reason,
    answer_1,
    answer_2,
    answer_3,
    answer_4,
    credit,
  } = req.body;

  let product_data, amount;
  if (credit === "1") {
    product_data = "One Credit Purchase"; // $3.00
    amount = 300;
  } else if (credit === "3") {
    product_data = "Three Credits Purchase"; // $7.99
    amount = 799;
  } else if (credit === "5") {
    product_data = "Five Credits Purchase"; // $12.00
    amount = 1200;
  } else {
    return res.status(400).json({ error: "Invalid credit option" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: product_data },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      payment_intent_data: {
        metadata: {
          client_reference_id: String(client_reference_id || ""),
          sue_reason: String(sue_reason || ""),
          credit_amount: String(credit || ""),
          answer_1: String(answer_1 || ""),
          answer_2: String(answer_2 || ""),
          answer_3: String(answer_3 || ""),
          answer_4: String(answer_4 || ""),
        },
      },
      client_reference_id: String(client_reference_id || ""),
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error", err);
    return res.status(500).json({ error: err.message });
  }
});

// Success callback
app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  res.send(`
	<!DOCTYPE html>
	<html>
	  <head>
		<title>Payment Success</title>
		<style>
		  body { font-family: Arial, sans-serif; background: #f9f9f9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
		  .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
		  h1 { font-size: 28px; color: #2d7a46; }
		  p { font-size: 18px; color: #555; }
		</style>
	  </head>
	  <body>
		<div class="card">
		  <h1>🎉 Payment Created!</h1>
		  <p>Thank you for your purchase.</p>
		  <p><strong>Session ID:</strong> ${session.id}</p>
		  <p>You will be informed via Frustration Court.</p>
		</div>
	  </body>
	</html>
  `);
});

// Cancel callback
app.get("/cancel", (req, res) => {
  console.log("User canceled payment");
  res.send(`
	<!DOCTYPE html>
	<html>
	  <head>
		<title>Payment Canceled</title>
		<style>
		  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #fff5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
		  .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
		  h1 { font-size: 28px; color: #d93025; }
		  p { font-size: 18px; color: #444; }
		</style>
	  </head>
	  <body>
		<div class="card">
		  <h1>❌ Payment Canceled</h1>
		  <p>Your transaction has been canceled. No charges were made.</p>
		</div>
	  </body>
	</html>
  `);
});

// ---- Stripe webhook endpoint ----
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.json({ received: true });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const manychatId = session.client_reference_id;
      const paymentIntent = await stripe.paymentIntents.retrieve(
        session.payment_intent
      );
      const credit = paymentIntent.metadata.credit_amount;

      if (manychatId) {
        const newCredits = await incrementCredits(manychatId, credit);

        const sendPayload = {
          subscriber_id: Number(manychatId),
          data: {
            version: "v2",
            content: [
              {
                type: "text",
                text: `✅ Payment received! Your new credits: ${newCredits}`,
              },
            ],
          },
        };

        const resp = await fetch(
          "https://api.manychat.com/fb/sending/sendContent",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(sendPayload),
          }
        );

        const respText = await resp.text();
        console.log(
          "📨 ManyChat sendFlow response:",
          manychatId,
          resp.status,
          respText,
          event.type
        );
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const session = event.data.object;
      const manychatId = session.metadata.client_reference_id;
      const sendPayload = {
        subscriber_id: Number(manychatId),
        data: {
          version: "v2",
          content: [
            {
              type: "text",
              text: "⚠️ Payment failed! Try to use another card.",
            },
          ],
        },
      };

      const resp = await fetch(
        "https://api.manychat.com/fb/sending/sendContent",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(sendPayload),
        }
      );

      const respText = await resp.text();
      console.log(
        "📨 ManyChat sendFlow response for Payment failed:",
        manychatId,
        resp.status,
        respText,
        event.type
      );
    }
  }
);

// ---- endpoint: async OpenAI image generation with SQLite ----
app.post("/generate-verdict-image", async (req, res) => {
  console.log("✅ Received image generation request:", req.body);
  const { case_details, verdict } = req.body;

  if (!case_details || !verdict)
    return res.status(400).json({ error: "Missing case_details, verdict" });

  const item_id = uuidv4();
  db.run(
    `INSERT OR REPLACE INTO images (item_id, case_details, verdict, status) VALUES (?, ?, ?, ?)`,
    [item_id, case_details, verdict, "processing"]
  );

  res.json({ status: "processing", item_id });

  setImmediate(async () => {
    try {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      const prompt = `
		You are an expert cinematic AI image creator generating symbolic, emotional verdicts for the project "Frustration Court" — a fictional AI-powered emotional courtroom.

		Create a visually striking, surreal courtroom scene that captures the emotional essence of the case and verdict provided below.

		CASE DETAILS:
		"${case_details}"

		VERDICT:
		"${verdict}"

		Your task:
		- Generate an artistic and symbolic courtroom illustration that visually represents the emotional weight, irony, and tone of the verdict.
		- The image should feel like a dystopian emotional court where justice meets chaos and sarcasm.

		Visual Style Guidelines:
		- **Mood:** dark, dramatic, sarcastic, cinematic, with emotional depth.
		- **Setting:** surreal courtroom or psychological space, not realistic — mix of human and symbolic elements.
		- **Key symbols:** broken gavel, floating verdict papers, red wax seal labeled “Frustration Court”, cracked scales of justice, smoke, or glowing emotional energy.
		- **Textures:** aged parchment, metal, shadowed marble, subtle grain and light leaks.
		- **Lighting:** low-key cinematic lighting with strong contrast (spotlight on the verdict area, dark corners, subtle red reflections).
		- **Colors:** black, deep red, charcoal gray, parchment beige, subtle highlights in gold or crimson.
		- **Composition:** central focus on the “verdict area” (symbolic paper or holographic display), surrounded by symbolic chaos or emotional debris.
		- **Typography area:** include space where verdict text could exist, but do NOT include readable words — use abstract lines, pseudo-legal scribbles, or stylized placeholder marks.
		- **Additional elements:** add emotional symbolism — shadows forming human faces, smoke shaped like frustration, faint reflections of the user’s emotional theme.
		- **Art Direction Keywords:** dystopian, brutalist, surreal, emotional, dark humor, poetic justice.

		Atmosphere Keywords:
		- dramatic tension
		- emotional absurdity
		- digital spirituality
		- ironic authority
		- metaphysical courtroom

		Do NOT include:
		- realistic text or actual human likeness
		- violence, blood, or horror
		- political, religious, or real-world logos

		Output Format:
		- Aspect Ratio: 4:5 (vertical poster, optimized for mobile and social media)
		- Style: hyperrealistic cinematic concept art
		- Vibe: darkly poetic, intelligent, and satirical — the perfect visual match for an AI judge’s sarcastic verdict.

		Example tone to inspire:
		“Justice served. No mercy. No refunds.”

		Return only the final artistic scene — do not describe or explain it.
		`;

      const response = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt,
            size: "1024x1024",
          }),
        }
      );

      const data = await response.json();
      if (!data.data || !data.data[0]?.url) {
        console.error("OpenAI image API failed:", data);
        db.run(`UPDATE images SET status = ? WHERE item_id = ?`, [
          "failed",
          item_id,
        ]);
        return;
      }

      const imageUrl = data.data[0].url;
      console.log("✅ OpenAI image URL:", imageUrl);
      // Download image into /public/images folder
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      const localImageName = `${item_id}.png`;
      const localImagePath = path.join(
        __dirname,
        "public",
        "images",
        localImageName
      );

      await fs.outputFile(localImagePath, Buffer.from(imageBuffer));
      const publicImageUrl = `${process.env.BASE_URL}/static/${localImageName}`;
      db.run(`UPDATE images SET image_url = ?, status = ? WHERE item_id = ?`, [
        publicImageUrl,
        "completed",
        item_id,
      ]);
    } catch (err) {
      console.error("❌ Error generating image:", err);
      db.run(`UPDATE images SET status = ? WHERE item_id = ?`, [
        "failed",
        item_id,
      ]);
    }
  });
});

// ---- endpoint: retrieve image URL ----
app.post("/get-image-url", async (req, res) => {
  const { item_id } = req.body;
  console.log("✅ Received get-image-url request:", item_id);
  if (!item_id) return res.status(400).json({ error: "Missing item_id" });

  db.get(`SELECT * FROM images WHERE item_id = ?`, [item_id], (err, row) => {
    if (err) {
      console.error("DB query error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (!row) return res.status(404).json({ error: "Item not found" });
    return res.json({
      image_url: row.image_url,
      item_id: row.item_id,
      status: row.status,
    });
  });
});

// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---- START HTTPS SERVER ----
https.createServer(sslOptions, app).listen(443, () => {
  console.log("✅ HTTPS server running at https://frustrationcourtserwer.com");
});

// ---- Optional HTTP -> HTTPS redirect ----
http
  .createServer((req, res) => {
    res.writeHead(301, { Location: "https://" + req.headers.host + req.url });
    res.end();
  })
  .listen(80);
