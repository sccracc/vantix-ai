export const config = { runtime: 'edge' };

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';
const DEFAULT_PLAN_CONFIG = {
  adminEmail: 'socceracctiktok@gmail.com',
  defaultPlanId: 'free',
  plans: {
    free: {
      label: 'Free',
      priceUsd: 0,
      tokenLimit: 6000,
      showProgressBar: true,
    },
    starter: {
      label: 'Starter',
      priceUsd: 10,
      tokenLimit: 2000000,
      showProgressBar: true,
    },
    pro: {
      label: 'Pro',
      priceUsd: 20,
      tokenLimit: 10000000,
      showProgressBar: true,
    },
    ultra: {
      label: 'Ultra',
      priceUsd: 50,
      tokenLimit: 35000000,
      showProgressBar: true,
    },
    god_mode: {
      label: 'God Mode',
      priceUsd: 0,
      tokenLimit: 999999999,
      showProgressBar: false,
    },
  },
};

let googleTokenCache = {
  accessToken: '',
  expiresAt: 0,
};

export default async function handler(req) {
  if (req.method === 'GET') {
    return jsonResponse(
      {
        ok: true,
        endpoint: '/api/chat',
        message: 'Use POST with a JSON body containing a messages array.',
      },
      200
    );
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed' } }, 405);
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      {
        error: {
          message:
            'Missing DEEPSEEK_API_KEY. Add it in Vercel Project Settings > Environment Variables, then redeploy.',
        },
      },
      500
    );
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: { message: 'Invalid JSON body' } }, 400);
  }

  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    return jsonResponse({ error: { message: 'messages is required' } }, 400);
  }

  const userUid = req.headers.get('x-vantix-uid') || payload.userUid || '';
  const userEmail = req.headers.get('x-vantix-email') || payload.userEmail || '';
  if (!userUid) {
    return jsonResponse({ error: { message: 'Missing authenticated user UID' } }, 401);
  }

  const planConfig = await getPlanConfig(req);
  let userProfile;
  try {
    userProfile = await getUserProfile(userUid, userEmail, planConfig);
  } catch (error) {
    return jsonResponse(
      { error: { message: error?.message || 'Failed to load usage profile' } },
      500
    );
  }

  const isAdmin =
    userProfile.role === 'admin' ||
    userProfile.email === getAdminEmail(planConfig) ||
    userEmail === getAdminEmail(planConfig);
  const requestedModel = String(payload?.model || '');
  const requestedMode = String(payload?.mode || (requestedModel === 'deepseek-v4-pro' ? 'expert' : 'fast')).toLowerCase();
  const remainingUnits = getRemainingUsageUnits(userProfile);
  if (!isAdmin && remainingUnits <= 0) {
    return jsonResponse({ error: { message: 'Usage limit reached' } }, 403);
  }
  if (!isAdmin && requestedModel === 'deepseek-v4-pro' && remainingUnits < 1000) {
    return jsonResponse(
      { error: { message: 'Insufficient units for Expert Mode. Switch to Fast Mode or Upgrade.' } },
      403
    );
  }

  const upstreamPayload = {
    ...payload,
    stream: true,
    messages: payload.messages,
  };
  delete upstreamPayload.userUid;
  delete upstreamPayload.userEmail;
  delete upstreamPayload.mode;

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (error) {
    return jsonResponse(
      { error: { message: error?.message || 'Failed to reach Vantix AI' } },
      502
    );
  }

  if (!upstream.body) {
    const errorText = await upstream.text().catch(() => '');
    return new Response(errorText || 'Upstream response body missing', {
      status: upstream.status || 502,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
        ...corsHeaders(),
      },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let rawSseText = '';
  let streamFailed = false;

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        rawSseText += decoder.decode(value, { stream: true });
        await writer.write(value);
      }
      rawSseText += decoder.decode();
    } catch (error) {
      streamFailed = true;
      console.error('Stream relay failed:', error);
    } finally {
      try {
        if (!streamFailed && upstream.ok) {
          const usageDelta = calculateUsageUnitsFromSse(rawSseText, {
            modelId: requestedModel,
            planId: userProfile.planId,
            mode: requestedMode,
            nonBillablePromptTokens: estimateNonBillablePromptTokens(payload.messages),
          });
          await consumeUsageUnits(userUid, usageDelta, userProfile, planConfig);
        }
      } catch (error) {
        console.error('Failed to increment usage:', error);
      } finally {
        await writer.close().catch(() => {});
        reader.releaseLock();
      }
    }
  })();

  return new Response(readable, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Vantix-Uid, X-Vantix-Email',
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

async function getUserProfile(uid, fallbackEmail = '', planConfig = DEFAULT_PLAN_CONFIG) {
  const accessToken = await getGoogleAccessToken();
  const projectId = getFirebaseProjectId();
  const docUrl = `${FIRESTORE_BASE_URL}/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const resp = await fetch(docUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (resp.status === 404) {
    const defaultPlanId = getDefaultPlanId(planConfig);
    const defaultPlan = getPlanDefinition(planConfig, defaultPlanId);
    const profile = {
      uid,
      email: fallbackEmail || '',
      role: fallbackEmail === getAdminEmail(planConfig) ? 'admin' : 'user',
      plan: defaultPlanId,
      planId: defaultPlanId,
      tokensUsed: 0,
      tokenLimit: Number(defaultPlan.tokenLimit || DEFAULT_PLAN_CONFIG.plans.free.tokenLimit),
      creditBalance: 0,
      topupBalance: 0,
      freeUsageResetDate: getUsageResetKey(),
      usageResetDate: getUsageResetKey(),
    };
    await upsertUserProfileDefaults(uid, profile, accessToken, projectId);
    return profile;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore user lookup failed (${resp.status})`);
  }

  const doc = await resp.json();
  const fields = fromFirestoreFields(doc.fields || {});
  const defaultPlanId = getStoredPlanId(fields, planConfig);
  const defaultPlan = getPlanDefinition(planConfig, defaultPlanId);
  const role = String(fields.role || (fallbackEmail === getAdminEmail(planConfig) ? 'admin' : 'user'));
  const profile = {
    uid,
    email: String(fields.email || fallbackEmail || ''),
    role,
    plan: String(defaultPlanId),
    planId: String(defaultPlanId),
    tokensUsed: toSafeNumber(fields.tokensUsed, 0),
    tokenLimit: resolveUserTokenLimit(fields, role, defaultPlanId, planConfig),
    creditBalance: toSafeNumber(fields.creditBalance ?? fields.topupBalance, 0),
    topupBalance: toSafeNumber(fields.topupBalance ?? fields.creditBalance, 0),
    freeUsageResetDate: String(fields.freeUsageResetDate || fields.usageResetDate || ''),
    usageResetDate: String(fields.usageResetDate || fields.freeUsageResetDate || ''),
  };
  if (shouldResetFreeUsage(fields)) {
    profile.tokensUsed = 0;
    profile.freeUsageResetDate = getUsageResetKey();
    profile.usageResetDate = getUsageResetKey();
  }
  if (
    !fields.role ||
    !fields.plan ||
    !fields.planId ||
    typeof fields.tokenLimit === 'undefined' ||
    typeof fields.creditBalance === 'undefined' ||
    typeof fields.topupBalance === 'undefined' ||
    (profile.planId === 'free' && shouldResetFreeUsage(fields)) ||
    Number(fields.tokenLimit) !== Number(profile.tokenLimit)
  ) {
    await upsertUserProfileDefaults(uid, profile, accessToken, projectId);
  }
  return profile;
}

async function getPlanConfig(req) {
  try {
    const resp = await fetch(new URL('/plan-config.json', req.url), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!resp.ok) return DEFAULT_PLAN_CONFIG;
    const json = await resp.json();
    return {
      ...DEFAULT_PLAN_CONFIG,
      ...json,
      plans: {
        ...DEFAULT_PLAN_CONFIG.plans,
        ...(json?.plans || {}),
      },
    };
  } catch {
    return DEFAULT_PLAN_CONFIG;
  }
}

function getAdminEmail(planConfig) {
  return planConfig?.adminEmail || DEFAULT_PLAN_CONFIG.adminEmail;
}

function getDefaultPlanId(planConfig) {
  return planConfig?.defaultPlanId || DEFAULT_PLAN_CONFIG.defaultPlanId;
}

function getPlanDefinition(planConfig, planId) {
  const plans = planConfig?.plans || DEFAULT_PLAN_CONFIG.plans;
  return plans[planId] || plans[getDefaultPlanId(planConfig)] || DEFAULT_PLAN_CONFIG.plans.free;
}

function getStoredPlanId(fields = {}, planConfig = DEFAULT_PLAN_CONFIG) {
  return String(fields.plan || fields.planId || getDefaultPlanId(planConfig));
}

function getUsageResetKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getFreeUsageResetField(fields = {}) {
  return String(fields.freeUsageResetDate || fields.usageResetDate || '');
}

function shouldResetFreeUsage(fields = {}) {
  return getStoredPlanId(fields) === 'free' && getFreeUsageResetField(fields) !== getUsageResetKey();
}

const LEGACY_PLAN_LIMITS = {
  free: [5000, 10000],
  starter: [1000000],
  pro: [5000000],
  ultra: [25000000],
};

function resolveUserTokenLimit(fields = {}, role = 'user', planId = getDefaultPlanId(DEFAULT_PLAN_CONFIG), planConfig = DEFAULT_PLAN_CONFIG) {
  const effectivePlanId = role === 'admin' ? 'god_mode' : planId;
  const planDef = getPlanDefinition(planConfig, effectivePlanId);
  const planTokenLimit = Number(planDef.tokenLimit || DEFAULT_PLAN_CONFIG.plans.free.tokenLimit);
  const storedTokenLimit = Number(fields.tokenLimit);
  if (!Number.isFinite(storedTokenLimit)) return planTokenLimit;
  if (storedTokenLimit === planTokenLimit) return storedTokenLimit;
  if ((LEGACY_PLAN_LIMITS[effectivePlanId] || []).includes(storedTokenLimit)) return planTokenLimit;

  const knownPlanLimits = new Set(
    Object.values(planConfig?.plans || DEFAULT_PLAN_CONFIG.plans)
      .map(plan => Number(plan?.tokenLimit))
      .filter(Number.isFinite)
  );

  return knownPlanLimits.has(storedTokenLimit) ? planTokenLimit : storedTokenLimit;
}

async function upsertUserProfileDefaults(uid, profile, accessToken, projectId) {
  const baseUrl = `${FIRESTORE_BASE_URL}/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const updateMask = ['email', 'role', 'plan', 'planId', 'tokenLimit', 'tokensUsed', 'creditBalance', 'topupBalance', 'freeUsageResetDate', 'usageResetDate'];
  const params = new URLSearchParams();
  updateMask.forEach(field => params.append('updateMask.fieldPaths', field));

  const resp = await fetch(`${baseUrl}?${params.toString()}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      fields: toFirestoreFields({
        email: String(profile.email || ''),
        role: String(profile.role || 'user'),
        plan: String(profile.plan || profile.planId || 'free'),
        planId: String(profile.planId || profile.plan || 'free'),
        tokenLimit: Number(profile.tokenLimit || 0),
        tokensUsed: Number(profile.tokensUsed || 0),
        creditBalance: Number(profile.creditBalance || 0),
        topupBalance: Number(profile.topupBalance || profile.creditBalance || 0),
        freeUsageResetDate: String(profile.freeUsageResetDate || getUsageResetKey()),
        usageResetDate: String(profile.usageResetDate || getUsageResetKey()),
      }),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore user backfill failed (${resp.status})`);
  }
}

function getRemainingUsageUnits(profile = {}) {
  const tokenLimit = Number(profile.tokenLimit || 0);
  const tokensUsed = Number(profile.tokensUsed || 0);
  const creditBalance = Number(profile.creditBalance ?? profile.topupBalance ?? 0);
  return Math.max(0, tokenLimit - tokensUsed + creditBalance);
}

async function consumeUsageUnits(uid, tokenDelta, fallbackProfile = {}, planConfig = DEFAULT_PLAN_CONFIG) {
  const delta = Math.max(1, Math.ceil(Number(tokenDelta) || 0));
  const accessToken = await getGoogleAccessToken();
  const projectId = getFirebaseProjectId();
  const currentProfile = await getUserProfile(uid, fallbackProfile.email || '', planConfig);
  const tokenLimit = Number(currentProfile.tokenLimit || fallbackProfile.tokenLimit || 0);
  const tokensUsed = Number(currentProfile.tokensUsed || 0);
  const creditBalance = Number(currentProfile.creditBalance ?? currentProfile.topupBalance ?? 0);
  const monthlyRemaining = Math.max(0, tokenLimit - tokensUsed);
  const monthlySpend = Math.min(monthlyRemaining, delta);
  const creditSpend = Math.min(creditBalance, Math.max(0, delta - monthlySpend));

  const commitUrl = `${FIRESTORE_BASE_URL}/projects/${projectId}/databases/(default)/documents:commit`;
  const documentName = `projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const resp = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      writes: [
        {
          transform: {
            document: documentName,
            fieldTransforms: [
              {
                fieldPath: 'tokensUsed',
                increment: { integerValue: String(monthlySpend) },
              },
              {
                fieldPath: 'creditBalance',
                increment: { integerValue: String(-creditSpend) },
              },
              {
                fieldPath: 'topupBalance',
                increment: { integerValue: String(-creditSpend) },
              },
              {
                fieldPath: 'lastUsageAt',
                setToServerValue: 'REQUEST_TIME',
              },
            ],
          },
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore usage increment failed (${resp.status})`);
  }
}

function getFirebaseProjectId() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('Missing FIREBASE_PROJECT_ID environment variable');
  }
  return projectId;
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (googleTokenCache.accessToken && googleTokenCache.expiresAt - 60 > now) {
    return googleTokenCache.accessToken;
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    const missing = [];
    if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
    if (!privateKeyRaw) missing.push('FIREBASE_PRIVATE_KEY');
    throw new Error(
      `Firebase usage-limit config is incomplete. Add ${missing.join(' and ')} in Vercel Project Settings > Environment Variables.`
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  const assertion = await createServiceAccountJwt({
    clientEmail,
    privateKey,
    tokenUrl: FIREBASE_TOKEN_URL,
  });

  const resp = await fetch(FIREBASE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Google OAuth token exchange failed (${resp.status})`);
  }

  const json = await resp.json();
  googleTokenCache = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 3600),
  };
  return googleTokenCache.accessToken;
}

async function createServiceAccountJwt({ clientEmail, privateKey, tokenUrl }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem) {
  const pem = privateKeyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = fromFirestoreValue(value);
  }
  return out;
}

function toFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = toFirestoreValue(value);
  }
  return out;
}

function toFirestoreValue(value) {
  if (value === null || typeof value === 'undefined') return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return !!value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue?.fields || {});
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(fromFirestoreValue);
  return null;
}

function toSafeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isDiscountedPlan(planId = '') {
  return ['pro', 'ultra'].includes(String(planId || '').toLowerCase());
}

function estimateTokenCount(value) {
  if (typeof value === 'string') return Math.max(0, Math.ceil(value.length / 4));
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTokenCount(item?.text || item?.content || ''), 0);
  }
  if (value && typeof value === 'object') {
    return estimateTokenCount(value.text || value.content || '');
  }
  return 0;
}

function estimateNonBillablePromptTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => {
    if (String(message?.role || '') !== 'system') return sum;
    return sum + estimateTokenCount(message?.content || '');
  }, 0);
}

function calculateUsageUnitsFromSse(chunkText, { modelId = '', planId = '', mode = 'fast', nonBillablePromptTokens = 0 } = {}) {
  let contentText = '';
  let reasoningText = '';
  let usage = null;
  const events = chunkText.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) contentText += delta.content;
      if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
      if (json?.usage) usage = json.usage;
    } catch {
      // ignore malformed partial chunk fragments
    }
  }

  const promptTokens = Math.max(0, Number(usage?.prompt_tokens || 0) - Math.max(0, Math.ceil(Number(nonBillablePromptTokens) || 0)));
  const completionTokens = Number(usage?.completion_tokens || 0);
  const totalTokens = Number(usage?.total_tokens || (promptTokens + completionTokens));
  const reasoningTokens = Math.max(0, Math.ceil(reasoningText.length / 4));
  const visibleTokens = Math.max(0, Math.ceil(contentText.length / 4));
  const discountedPromptTokens = isDiscountedPlan(planId) ? Math.floor(promptTokens / 2) : promptTokens;
  const baseUnits = (promptTokens || completionTokens)
    ? (discountedPromptTokens + completionTokens)
    : (totalTokens > 0 ? totalTokens : Math.max(1, visibleTokens + reasoningTokens));
  const weightedUnits = mode === 'expert' ? baseUnits * 10 : baseUnits;
  return Math.max(1, Math.ceil(weightedUnits));
}

function isExpertModel(modelId = '') {
  return String(modelId || '') === 'deepseek-v4-pro';
}
