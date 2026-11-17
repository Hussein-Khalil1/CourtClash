const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require("./auth_router");
const { User } = require("../models/users");
const {
  hasActiveSubscription,
  saveSubscription,
  describeSubscription,
  subscriptionPeriodEnd,
} = require("./subscription");

const router = express.Router();

const frontendUrl = (
  process.env.FRONTEND_URL || "http://localhost:3000"
).replace(/\/+$/, "");

const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC,
  premium: process.env.STRIPE_PRICE_PREMIUM,
};

router.post("/create-checkout-session", requireAuth, async (req, res) => {
  const { plan } = req.body;

  if (!PRICE_IDS[plan]) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  const user = req.user;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      line_items: [
        {
          price: PRICE_IDS[plan],
          quantity: 1,
        },
      ],
      client_reference_id: user.id,
      subscription_data: {
        metadata: { userId: user.id, plan },
      },

      success_url: `${req.protocol}://${req.get("host")}/api/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/?checkout=canceled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Could not create checkout session" });
  }
});

router.get("/checkout/complete", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!req.user || !sessionId) {
    return res.redirect(`${frontendUrl}/`);
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.client_reference_id !== req.user.id) {
      return res.redirect(`${frontendUrl}/`);
    }

    if (session.payment_status !== "paid" || !session.subscription) {
      return res.redirect(`${frontendUrl}/?checkout=pending`);
    }

    const subscription = await stripe.subscriptions.retrieve(
      session.subscription,
    );

    await saveSubscription({ id: req.user.id }, subscription, {
      stripeCustomerId: session.customer,
      stripeSubscriptionId: session.subscription,
    });

    const user = await User.findByPk(req.user.id);

    if (!hasActiveSubscription(user)) {
      return res.redirect(`${frontendUrl}/?checkout=pending`);
    }

    return res.redirect(`${frontendUrl}/`);
  } catch (err) {
    console.error("Checkout complete error:", err);
    return res.redirect(`${frontendUrl}/?checkout=pending`);
  }
});

function withCancelState(user, subscription) {
  const state = describeSubscription(user);

  state.cancelAtPeriodEnd = subscription.cancel_at_period_end === true;

  const periodEnd = subscriptionPeriodEnd(subscription);

  if (periodEnd) {
    state.currentPeriodEnd = periodEnd;
  }

  return state;
}

router.get("/subscription", requireAuth, async (req, res) => {
  const user = req.user;
  const state = describeSubscription(user);
  state.cancelAtPeriodEnd = false;

  if (!user.stripeSubscriptionId) {
    return res.json({ subscription: state });
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(
      user.stripeSubscriptionId,
    );

    res.json({ subscription: withCancelState(user, subscription) });
  } catch (err) {
    console.error("Subscription lookup error:", err);
    res.json({ subscription: state });
  }
});

router.post("/subscription/cancel", requireAuth, async (req, res) => {
  const user = req.user;

  if (!user.stripeSubscriptionId) {
    return res
      .status(400)
      .json({ error: "You do not have a subscription to cancel." });
  }

  try {
    const subscription = await stripe.subscriptions.update(
      user.stripeSubscriptionId,
      { cancel_at_period_end: true },
    );

    await saveSubscription({ id: user.id }, subscription);

    const updated = await User.findByPk(user.id);

    res.json({ subscription: withCancelState(updated, subscription) });
  } catch (err) {
    console.error("Subscription cancel error:", err);
    res.status(500).json({ error: "Could not cancel your subscription." });
  }
});

router.post("/subscription/resume", requireAuth, async (req, res) => {
  const user = req.user;

  if (!user.stripeSubscriptionId) {
    return res
      .status(400)
      .json({ error: "You do not have a subscription to resume." });
  }

  try {
    const subscription = await stripe.subscriptions.update(
      user.stripeSubscriptionId,
      { cancel_at_period_end: false },
    );

    await saveSubscription({ id: user.id }, subscription);

    const updated = await User.findByPk(user.id);

    res.json({ subscription: withCancelState(updated, subscription) });
  } catch (err) {
    console.error("Subscription resume error:", err);
    res.status(500).json({ error: "Could not resume your subscription." });
  }
});

module.exports = router;
