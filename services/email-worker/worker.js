export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, env);
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/send-estimate') {
      return handleSendEstimate(request, env);
    }

    return json({ error: 'Not found' }, 404, env);
  }
};

async function handleSendEstimate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, env);
  }

  const { customerEmail, customerName, subject, customerHtml, internalEmail, internalSubject, internalHtml } = body;

  if (!customerEmail || !customerHtml || !subject) {
    return json({ error: 'Missing required fields: customerEmail, customerHtml, subject' }, 400, env);
  }

  const fromEmail = env.FROM_EMAIL || 'noreply@example.com';
  const fromName = env.FROM_NAME || 'Fence Estimate';
  const replyTo = env.REPLY_TO_EMAIL || env.INTERNAL_EMAIL || null;
  const apiKey = env.RESEND_API_KEY;

  if (!apiKey) {
    return json({ error: 'Email service not configured' }, 500, env);
  }

  const results = { customer: null, internal: null };

  // Send customer email (with reply-to so replies reach the business inbox)
  const custRes = await sendEmail(apiKey, {
    from: `${fromName} <${fromEmail}>`,
    reply_to: replyTo,
    to: customerEmail,
    subject: subject,
    html: customerHtml
  });
  results.customer = custRes;

  // Send internal P&L email if configured
  if (internalEmail && internalHtml) {
    const intRes = await sendEmail(apiKey, {
      from: `${fromName} <${fromEmail}>`,
      to: internalEmail,
      subject: internalSubject || subject,
      html: internalHtml
    });
    results.internal = intRes;
  }

  const ok = results.customer.ok && (!internalEmail || results.internal.ok);
  return json({ ok, results }, ok ? 200 : 502, env);
}

async function sendEmail(apiKey, params) {
  try {
    const payload = {
      from: params.from,
      to: [params.to],
      subject: params.subject,
      html: params.html
    };
    if (params.reply_to) {
      payload.reply_to = params.reply_to;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}
