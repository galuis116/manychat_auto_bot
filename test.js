// import dependencies
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs-extra');
const path = require('path');

// load env variables
const STRIPE_SECRET_KEY = process.env.PROD === 'True' ? process.env.PROD_STRIPE_SECRET_KEY : process.env.TEST_STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.PROD === 'True' ? process.env.PROD_STRIPE_WEBHOOK_SECRET : process.env.TEST_STRIPE_WEBHOOK_SECRET;

// init app
const app = express();
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Use JSON for all routes EXCEPT /webhook
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') return next();
    express.json()(req, res, next);
});
const PORT = process.env.PORT || 3000;

// ---- helper: increment credits ----
async function incrementCredits(subscriberId, credit) {
    // Step 1: Get subscriber info
    const resp = await fetch(`https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await resp.json();
    const subscriber = data?.data;
  
    if (!subscriber) {
      console.log(`Subscriber ${subscriberId} not found`);
      return;
    }
  
    // Step 2: Get current credits safely
    let currentCredits = subscriber.custom_fields?.find(f => f.name === 'credits')?.value ?? 0;
    currentCredits = Number(currentCredits) || 0; // ensure valid number
  
    // Step 3: Increment
    const newCredits = currentCredits + Number(credit);
  
    // Step 4: Set new credits
    const setResp = await fetch('https://api.manychat.com/fb/subscriber/setCustomField', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        field_id: 12880026,
        field_name: 'credits',
        field_value: newCredits
      }),
    });
  
    const setData = await setResp.json();
    console.log('Set credits response:', subscriberId, JSON.stringify(setData));
    console.log(`Credits updated from ${currentCredits} → ${newCredits}`);
    return newCredits;
  }


// ---- endpoint: create checkout session ----
app.post('/create-checkout-session', express.json(), async (req, res) => {
    const { client_reference_id, sue_reason, answer_1, answer_2, answer_3, credit } = req.body;
    if( credit === "1" ){
        var product_data = "One Credit Purchase"; // $3.00
        var amount = 300;
    } else if( credit === "3" ){
        var product_data = "Three Credits Purchase"; // $7.99
        var amount = 799;
    } else if( credit === "5" ){
        var product_data = "Five Credits Purchase"; // $12.00
        var amount = 1200;
    } else {
        return res.status(400).json({ error: 'Invalid credit option' });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
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
            mode: 'payment',
            payment_intent_data: {
                metadata: {
                    client_reference_id: String(client_reference_id || ''),
                    sue_reason: String(sue_reason || ''),
                    credit_amount: String(credit || ''),
                    answer_1: String(answer_1 || ''),
                    answer_2: String(answer_2 || ''),
                    answer_3: String(answer_3 || ''),
                }
            },
            client_reference_id: String(client_reference_id || ''),
            success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/cancel`,
        });
        
        return res.json({ url: session.url });
    } catch (err) {
        console.error('create-checkout-session error', err);
        return res.status(500).json({ error: err.message });
    }
});

// Success callback
app.get('/success', async (req, res) => {
    const sessionId = req.query.session_id;
  
    // Optional: fetch session details from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Do whatever you want: update database, send confirmation, etc.
    res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Payment Success</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                background: #f9f9f9;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .card {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                text-align: center;
              }
              h1 {
                font-size: 28px;
                color: #2d7a46;
              }
              p {
                font-size: 18px;
                color: #555;
              }
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
  app.get('/cancel', (req, res) => {
    console.log('User canceled payment');
    res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Payment Canceled</title>
            <style>
              body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: #fff5f5;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .card {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                text-align: center;
              }
              h1 {
                font-size: 28px;
                color: #d93025;
              }
              p {
                font-size: 18px;
                color: #444;
              }
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
// Note: raw body is required for stripe signature verification
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge receipt
    res.json({ received: true });

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object; // Checkout Session
        const manychatId = session.client_reference_id;
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        const credit = paymentIntent.metadata.credit_amount;
        
        if (manychatId) {
            // Step 1: Update credits
            const newCredits = await incrementCredits(manychatId, credit);
        
            // Step 2: Trigger ManyChat flow to notify user for credits update
            const sendPayload = {
                subscriber_id: Number(manychatId),
                data: {
                    version: "v2",
                    content: [
                      {
                        type: "text",
                        text: `✅ Payment received! Your new credits: ${newCredits}`
                      }
                    ]
                }
            };
        
            const resp = await fetch('https://api.manychat.com/fb/sending/sendContent', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(sendPayload)
            });
        
            const respText = await resp.text();
            console.log('📨 ManyChat sendFlow response for Payment success:', manychatId, resp.status, respText, event.type);
        }
    } 
    else if(event.type === 'payment_intent.payment_failed') {
        const session = event.data.object; // Checkout Session
        const manychatId = session.metadata.client_reference_id;
      // Step 3: Trigger ManyChat flow to notify user for payment failure
        const sendPayload = {
            subscriber_id: Number(manychatId),
            data: {
                version: "v2",
                content: [
                {
                    type: "text",
                    text: '⚠️ Payment failed! Try to use another card.'
                }
                ]
            }
        };

        const resp = await fetch('https://api.manychat.com/fb/sending/sendContent', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sendPayload)
        });

        const respText = await resp.text();
        console.log('📨 ManyChat sendFlow response for Payment failed:', manychatId, resp.status, respText, event.type);
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
