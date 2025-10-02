🚀 Features
 - Create Stripe Checkout Sessions for payments.
 - Pass metadata (client_reference_id, sue_reason) into Stripe.
 - Handle webhooks for:
      - checkout.session.completed → add credits + notify subscriber.
      - payment_intent.payment_failed → notify subscriber of failure.
 - Success and cancel pages included.
 - Uses ManyChat custom field (credits) to track balance.
 - Supports Test and Production Stripe keys with .env.

📦 Requirements
 - Node.js 18+
 - npm
 - Stripe account (Test + Live keys)
 - ManyChat API key
 - A ManyChat custom field named credits

⚙️ Setup
   npm install

 # Server
 - BASE_URL=http://localhost:3000
 - https://pottier-bethel-unforgetfully.ngrok-free.dev 

# Mode: PROD=true for live, false for test
PROD=false

# Stripe keys
TEST_STRIPE_SECRET_KEY=sk_test_...
TEST_STRIPE_WEBHOOK_SECRET=whsec_...
PROD_STRIPE_SECRET_KEY=sk_live_...
PROD_STRIPE_WEBHOOK_SECRET=whsec_...

# ManyChat
MANYCHAT_API_KEY=mc_api_key_here

▶️ Run the server
   click start.bat
   npm start
▶️ Dev the server
   npm run dev

✅ Webhooks
 - checkout.session.completed → increments ManyChat credits + notifies subscriber.
 - payment_intent.payment_failed → notifies subscriber of failed payment.

📲 ManyChat Integration
 - Ensure a custom field credits exists in ManyChat.
 - Update field_id in incrementCredits() with your ManyChat field’s ID.
 - Subscribers get automatic messages when payments succeed/fail.

Check logs for:
✅ Payment received! Your new credits: X
⚠️ Payment failed! Try another card.

📚 References
 - Stripe Checkout Sessions
 - Stripe Webhooks
 - ManyChat API Docs