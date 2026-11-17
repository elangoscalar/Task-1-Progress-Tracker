const KEY = 'study-progress';

function sendError(res, status, code, message, hint) {
  return res.status(status).json({
    error: message,
    code,
    ...(hint ? { hint } : {})
  });
}

function getRedisConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url) {
    const error = new Error('Redis REST URL is not configured.');
    error.code = 'REDIS_URL_MISSING';
    throw error;
  }
  if (!token) {
    const error = new Error('Redis REST token is not configured.');
    error.code = 'REDIS_TOKEN_MISSING';
    throw error;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
  } catch {
    const error = new Error('Redis REST URL is invalid. It must be a valid HTTPS URL.');
    error.code = 'REDIS_URL_INVALID';
    throw error;
  }

  return { url, token };
}

async function redis(command) {
  const { url, token } = getRedisConfig();
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });
  } catch (error) {
    const e = new Error(`Could not reach Redis: ${error.message || 'network error'}`);
    e.code = 'REDIS_NETWORK_ERROR';
    throw e;
  }

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const e = new Error('Redis returned a response that was not valid JSON.');
    e.code = 'REDIS_INVALID_RESPONSE';
    throw e;
  }

  if (!response.ok) {
    const e = new Error(
      payload && payload.error
        ? `Redis HTTP ${response.status}: ${payload.error}`
        : `Redis returned HTTP ${response.status}.`
    );
    e.code = response.status === 401 || response.status === 403
      ? 'REDIS_AUTH_FAILED'
      : 'REDIS_HTTP_ERROR';
    throw e;
  }

  if (payload && payload.error) {
    const e = new Error(`Redis error: ${payload.error}`);
    e.code = /auth|token|unauthorized/i.test(payload.error)
      ? 'REDIS_AUTH_FAILED'
      : 'REDIS_COMMAND_ERROR';
    throw e;
  }

  return payload ? payload.result : null;
}

function checkPassword(req) {
  const expected = process.env.EDIT_PASSWORD;
  if (!expected) {
    const error = new Error('Owner password is not configured on this Vercel deployment.');
    error.code = 'EDIT_PASSWORD_MISSING';
    throw error;
  }
  return req.headers['x-edit-password'] === expected;
}

function clean(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object.');
    error.code = 'INVALID_BODY';
    throw error;
  }
  if (!body.c || typeof body.c !== 'object' || Array.isArray(body.c)) {
    const error = new Error('Request body must contain a chapter status object named "c".');
    error.code = 'INVALID_PROGRESS';
    throw error;
  }

  const out = { updated: new Date().toISOString(), c: {} };
  for (const [key, value] of Object.entries(body.c)) {
    if (!/^[wa]\d{1,2}$/.test(key)) continue;
    if (!value || !['n', 'o', 'd'].includes(value.s)) {
      const error = new Error(`Invalid status for chapter "${key}". Use n, o, or d.`);
      error.code = 'INVALID_CHAPTER_STATUS';
      throw error;
    }
    out.c[key] = {
      s: value.s,
      d: typeof value.d === 'string' ? value.d.slice(0, 40) : ''
    };
  }
  return out;
}

function handleError(res, error) {
  const code = error.code || 'INTERNAL_ERROR';
  const statusByCode = {
    EDIT_PASSWORD_MISSING: 503,
    REDIS_URL_MISSING: 503,
    REDIS_TOKEN_MISSING: 503,
    REDIS_URL_INVALID: 503,
    REDIS_AUTH_FAILED: 502,
    REDIS_NETWORK_ERROR: 502,
    REDIS_INVALID_RESPONSE: 502,
    REDIS_HTTP_ERROR: 502,
    REDIS_COMMAND_ERROR: 502,
    INVALID_BODY: 400,
    INVALID_PROGRESS: 400,
    INVALID_CHAPTER_STATUS: 400
  };
  console.error('[api/progress]', code, error.message);
  return sendError(
    res,
    statusByCode[code] || 500,
    code,
    error.message || 'Unexpected server error.',
    code === 'EDIT_PASSWORD_MISSING'
      ? 'Add EDIT_PASSWORD in Vercel → Project Settings → Environment Variables, then redeploy.'
      : code.startsWith('REDIS_')
        ? 'Check the Redis integration and the UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL / KV_REST_API_TOKEN variables.'
        : undefined
  );
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (req.method === 'GET') {
      const value = await redis(['GET', KEY]);
      if (value === null || value === undefined || value === '') {
        return res.status(200).json({ updated: '', c: {} });
      }

      try {
        const saved = typeof value === 'string' ? JSON.parse(value) : value;
        if (!saved || typeof saved !== 'object' || !saved.c || typeof saved.c !== 'object') {
          throw new Error('Saved progress has an unexpected format.');
        }
        return res.status(200).json(saved);
      } catch (error) {
        const e = new Error(`Saved progress could not be parsed: ${error.message}`);
        e.code = 'SAVED_PROGRESS_INVALID';
        return sendError(res, 502, e.code, e.message, 'The Redis key "study-progress" contains invalid JSON or an unexpected structure.');
      }
    }

    if (req.method === 'POST') {
      if (!checkPassword(req)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Wrong password.');
      }

      // Login verification checks both the password and the Redis connection,
      // without changing the saved progress.
      if (req.body && req.body.action === 'verify') {
        await redis(['PING']);
        return res.status(200).json({ ok: true, message: 'Password verified and database connection is working.' });
      }

      const data = clean(req.body);
      await redis(['SET', KEY, JSON.stringify(data)]);
      return res.status(200).json(data);
    }

    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  } catch (error) {
    return handleError(res, error);
  }
};
