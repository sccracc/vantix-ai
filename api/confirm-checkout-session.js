import {
  corsHeaders,
  jsonResponse,
  stripeRequest,
  getFirestoreAccess,
  getFirestoreUserDoc,
  patchFirestoreUser,
} from './_lib/billing.js';

export const config = { runtime: 'edge' };

const PLAN_LIMITS = {
  starter: 2000000,
  pro: 10000000,
  ultra: 35000000,
  free: 6000,
  god_mode: 999999999,
};

const TOPUP_PACKS = {
  quick_refill: 50000,
  power_up: 250000,
  vault: 1000000,
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed' } }, 405);
  }

  try {
    const body = await req.json();
    const uid = String(body?.uid || '').trim();
    const sessionId = String(body?.sessionId || '').trim();
    if (!uid) return jsonResponse({ error: { message: 'Missing uid' } }, 400);
    if (!sessionId) return jsonResponse({ error: { message: 'Missing sessionId' } }, 400);

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=customer`);
    const sessionUid = String(session?.metadata?.firebaseUid || session?.client_reference_id || '');
    if (sessionUid && sessionUid !== uid) {
      return jsonResponse({ error: { message: 'Session user mismatch' } }, 403);
    }

    const customerId = typeof session?.customer === 'object' ? String(session.customer.id || '') : String(session?.customer || '');
    const customerEmail = String(session?.customer_details?.email || session?.customer_email || '');
    const { accessToken, projectId } = await getFirestoreAccess();

    const topupId = normalizeTopupId(session?.metadata?.topupId || '');
    if (topupId && TOPUP_PACKS[topupId]) {
      const userDoc = await getFirestoreUserDoc(uid, accessToken, projectId);
      const creditBalance = Number(userDoc.creditBalance || 0);
      const newBalance = creditBalance + TOPUP_PACKS[topupId];
      await patchFirestoreUser(
        uid,
        {
          creditBalance: newBalance,
          topupBalance: newBalance,
          stripeCustomerId: customerId,
          email: customerEmail,
          lastTopUpAt: new Date().toISOString(),
        },
        accessToken,
        projectId
      );

      return jsonResponse({
        ok: true,
        topupId,
        units: TOPUP_PACKS[topupId],
        creditBalance: newBalance,
        customerId,
      }, 200);
    }

    const sessionPlanId = normalizePlanId(session?.metadata?.planId || session?.subscription?.metadata?.planId || '');
    const planId = sessionPlanId || 'free';
    if (!['starter', 'pro', 'ultra'].includes(planId)) {
      return jsonResponse({ error: { message: 'Checkout session did not map to a paid plan' } }, 400);
    }

    const subscriptionId = typeof session?.subscription === 'object' ? String(session.subscription.id || '') : String(session?.subscription || '');
    await patchFirestoreUser(
      uid,
      {
        plan: planId,
        planId,
        tokenLimit: PLAN_LIMITS[planId],
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: String(session?.subscription?.status || session?.status || 'active'),
        email: customerEmail,
      },
      accessToken,
      projectId
    );

    return jsonResponse({
      ok: true,
      planId,
      tokenLimit: PLAN_LIMITS[planId],
      subscriptionId,
      customerId,
    }, 200);
  } catch (error) {
    return jsonResponse({ error: { message: error?.message || 'Failed to confirm checkout session' } }, 500);
  }
}

function normalizePlanId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'starter' || normalized === 'pro' || normalized === 'ultra') return normalized;
  return '';
}

function normalizeTopupId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'quick_refill' || normalized === 'power_up' || normalized === 'vault') return normalized;
  return '';
}
