const { User } = require("../models/users");

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];
const SUBSCRIPTION_REQUIRED =
  String(process.env.SUBSCRIPTION_REQUIRED || "true").toLowerCase() !== "false";

function subscriptionsAreRequired() {
  return SUBSCRIPTION_REQUIRED;
}

function hasActiveSubscription(user) {
  if (!user) {
    return false;
  }

  if (!subscriptionsAreRequired()) {
    return true;
  }

  return ACTIVE_SUBSCRIPTION_STATUSES.includes(user.subscriptionStatus);
}

function describeSubscription(user) {
  if (!user) {
    return {
      active: false,
      status: "none",
      plan: null,
      currentPeriodEnd: null,
    };
  }

  return {
    active: hasActiveSubscription(user),
    status: subscriptionsAreRequired()
      ? user.subscriptionStatus || "none"
      : user.subscriptionStatus || "local",
    plan: user.subscriptionPlan || null,
    currentPeriodEnd: user.currentPeriodEnd || null,
  };
}

function requireSubscription(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!hasActiveSubscription(req.user)) {
    return res.status(403).json({
      error: "An active CourtClash subscription is required.",
      code: "subscription_required",
      subscription: describeSubscription(req.user),
    });
  }

  next();
}

async function userIsSubscribed(userId) {
  const user = await User.findByPk(userId);

  return hasActiveSubscription(user);
}

function subscriptionPeriodEnd(subscription) {
  let periodEnd = subscription.current_period_end;

  if (!periodEnd && subscription.items && subscription.items.data.length > 0) {
    periodEnd = subscription.items.data[0].current_period_end;
  }

  if (!periodEnd) {
    return null;
  }

  return new Date(periodEnd * 1000);
}

async function saveSubscription(where, subscription, extraValues) {
  const values = Object.assign(
    { subscriptionStatus: subscription.status },
    extraValues || {},
  );

  const periodEnd = subscriptionPeriodEnd(subscription);

  if (periodEnd) {
    values.currentPeriodEnd = periodEnd;
  }

  if (subscription.metadata && subscription.metadata.plan) {
    values.subscriptionPlan = subscription.metadata.plan;
  }

  await User.update(values, { where });
}

module.exports = {
  ACTIVE_SUBSCRIPTION_STATUSES,
  subscriptionsAreRequired,
  hasActiveSubscription,
  describeSubscription,
  requireSubscription,
  userIsSubscribed,
  subscriptionPeriodEnd,
  saveSubscription,
};
