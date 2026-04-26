import { stream } from '@netlify/functions';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function normalizeSupabaseUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return '';
  }
}

function parseJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function validateSupabaseToken(accessToken) {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const tokenPayload = parseJwtPayload(accessToken);
  const tokenIssuer = tokenPayload?.iss || '';
  const configuredHost = (() => {
    try { return new URL(supabaseUrl).host; } catch (_) { return ''; }
  })();
  const issuerHost = (() => {
    try { return tokenIssuer ? new URL(tokenIssuer).host : ''; } catch (_) { return ''; }
  })();

  if (!supabaseUrl || (!serviceRoleKey && !anonKey)) {
    return { ok: false, reason: 'Supabase server configuration is missing.' };
  }
  if (issuerHost && configuredHost && issuerHost !== configuredHost) {
    return {
      ok: false,
      reason: `Session token is for ${issuerHost}, but server is configured for ${configuredHost}.`,
    };
  }
  if (typeof tokenPayload?.exp === 'number' && (tokenPayload.exp * 1000) <= Date.now()) {
    return { ok: false, reason: 'Session token is expired.' };
  }

  const apiKey = serviceRoleKey || anonKey;
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
        'authorization': `Bearer ${accessToken}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, reason: `Invalid session token. ${text || `HTTP ${resp.status}`}`.trim() };
    }
    const user = await resp.json().catch(() => null);
    if (!user?.id) {
      return { ok: false, reason: 'Invalid session token.' };
    }
    return { ok: true, user };
  } catch (error) {
    return { ok: false, reason: `Supabase auth check failed. ${error?.message || 'Unknown error'}` };
  }
}

export const handler = stream(async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: 'Method not allowed.' } }),
    };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: 'Missing bearer token.' } }),
    };
  }
  const accessToken = authHeader.slice('Bearer '.length).trim();
  if (!accessToken) {
    return {
      statusCode: 401,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: 'Missing bearer token.' } }),
    };
  }

  const auth = await validateSupabaseToken(accessToken);
  if (!auth.ok) {
    return {
      statusCode: 401,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: auth.reason } }),
    };
  }

  const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!deepseekApiKey) {
    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: 'Missing DEEPSEEK_API_KEY.' } }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ error: { message: 'Invalid JSON body.' } }),
    };
  }

  try {
    const upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${deepseekApiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.body) {
      const text = await upstream.text();
      return {
        statusCode: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        },
        body: text,
      };
    }

    const reader = upstream.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    });

    return {
      statusCode: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate, no-transform',
        'pragma': 'no-cache',
        'expires': '0',
        'x-accel-buffering': 'no',
        'connection': 'keep-alive',
      },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({
        error: {
          message: 'Upstream DeepSeek request failed.',
          detail: error?.message || 'Unknown error',
        },
      }),
    };
  }
});
