export const config = { runtime: 'edge' };

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

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
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
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

  const upstreamPayload = {
    ...payload,
    stream: true,
    messages: payload.messages,
  };

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) await writer.write(value);
      }
    } catch (error) {
      console.error('Stream relay failed:', error);
    } finally {
      await writer.close().catch(() => {});
      reader.releaseLock();
    }
  })();

  return new Response(readable, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
