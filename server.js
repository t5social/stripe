const express = require("express");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const PAYMENT_LINK_ID = process.env.PAYMENT_LINK_ID; // your plink_...
const MAX_TICKETS = parseInt(process.env.MAX_TICKETS || "80", 10);

const app = express();

// Stripe needs the raw body for webhook signature verification
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("⚠️  Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("➡️  Received event:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        await handleCheckoutCompleted(session);
      } catch (err) {
        console.error("❌ Error handling checkout.session.completed:", err);
      }
    }

    res.json({ received: true });
  }
);

async function handleCheckoutCompleted(session) {
  // Only care about this specific Payment Link
  if (session.payment_link !== PAYMENT_LINK_ID) {
    console.log(
      "ℹ️  checkout.session.completed for a different payment link:",
      session.payment_link
    );
    return;
  }

  console.log("🧾 Handling checkout.session.completed for session:", session.id);

  // Get line items to know how many tickets were bought in this session
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
  });

  let quantityThisOrder = 0;
  for (const item of lineItems.data) {
    quantityThisOrder += item.quantity || 0;
  }

  console.log("🎟 Tickets in this order:", quantityThisOrder);

  // Read current total from Payment Link metadata
  const pl = await stripe.paymentLinks.retrieve(PAYMENT_LINK_ID);
  const currentSold = parseInt(pl.metadata?.tickets_sold || "0", 10);

  const newTotal = currentSold + quantityThisOrder;

  console.log(
    `📊 Previous total: ${currentSold}, new total: ${newTotal} (max ${MAX_TICKETS})`
  );

  // Prepare metadata update
  const newMetadata = {
    ...(pl.metadata || {}),
    tickets_sold: String(newTotal),
  };

  const updateParams = { metadata: newMetadata };

  // If we’ve hit or exceeded the cap, deactivate the link
  if (newTotal >= MAX_TICKETS) {
    updateParams.active = false;
    console.log("🛑 Ticket cap reached. Deactivating payment link.");
  }

  await stripe.paymentLinks.update(PAYMENT_LINK_ID, updateParams);

  console.log(
    `✅ Sold ${quantityThisOrder} tickets in this order. Total = ${newTotal} / ${MAX_TICKETS}.` +
      (newTotal >= MAX_TICKETS ? " Payment link deactivated." : "")
  );
}

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Webhook server running on port ${port}`));
