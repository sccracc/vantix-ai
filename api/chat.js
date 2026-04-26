export const config = { runtime: 'edge' };

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';
const DEFAULT_TOKEN_LIMIT = 100000;
const ADMIN_EMAIL = 'socceracctiktok@gmail.com';

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

  let userProfile;
  try {
    userProfile = await getUserProfile(userUid, userEmail);
  } catch (error) {
    return jsonResponse(
      { error: { message: error?.message || 'Failed to load usage profile' } },
      500
    );
  }

  const isAdmin = userProfile.role === 'admin' || userProfile.email === ADMIN_EMAIL || userEmail === ADMIN_EMAIL;
  if (!isAdmin && userProfile.tokensUsed >= userProfile.tokenLimit) {
    return jsonResponse({ error: { message: 'Usage limit reached' } }, 403);
  }

  const upstreamPayload = {
    ...payload,
    stream: true,
    messages: payload.messages,
  };
  delete upstreamPayload.userUid;
  delete upstreamPayload.userEmail;

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
      { error: { message: error?.message || 'Failed to reach DeepSeek' } },
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
          const streamedText = extractContentFromSseChunk(rawSseText);
          const approxTokens = Math.max(1, Math.ceil(streamedText.length / 4));
          await incrementUserTokensUsed(userUid, approxTokens);
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

async function getUserProfile(uid, fallbackEmail = '') {
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
    return {
      uid,
      email: fallbackEmail || '',
      role: fallbackEmail === ADMIN_EMAIL ? 'admin' : 'user',
      tokensUsed: 0,
      tokenLimit: DEFAULT_TOKEN_LIMIT,
    };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Firestore user lookup failed (${resp.status})`);
  }

  const doc = await resp.json();
  const fields = fromFirestoreFields(doc.fields || {});
  return {
    uid,
    email: String(fields.email || fallbackEmail || ''),
    role: String(fields.role || (fallbackEmail === ADMIN_EMAIL ? 'admin' : 'user')),
    tokensUsed: toSafeNumber(fields.tokensUsed, 0),
    tokenLimit: toSafeNumber(fields.tokenLimit, DEFAULT_TOKEN_LIMIT),
  };
}

async function incrementUserTokensUsed(uid, tokenDelta) {
  const accessToken = await getGoogleAccessToken();
  const projectId = getFirebaseProjectId();
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
                increment: { integerValue: String(tokenDelta) },
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
    throw new Error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY environment variable');
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

function extractContentFromSseChunk(chunkText) {
  let text = '';
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
      if (delta?.content) text += delta.content;
    } catch {
      // ignore malformed partial chunk fragments
    }
  }
  return text;
}
