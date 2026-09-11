/* Pomodoro d'Oro — Groq AI Proxy (server-side secret) */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/* Groq high-performance models list */
const GROQ_FALLBACK_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-3.2-11b-vision-instruct',
  'llama-3.2-3b-instruct',
  'gemma2-9b-it',
  'mixtral-8x7b-32768'
];

/* Detect chain-of-thought leaking into the visible answer */
const COT = /here'?s a thinking process|thinking process:|draft response:|\bdraft:\s*"|check constraints|\b\d+\.\s*(analyze user input|check (current )?context|determine response)/i;

/* Last-resort: pull the quoted draft out of a leaky reply */
function extractFinal(t) {
  let m = t.match(/Draft(?:\s+Response)?:\s*"([\s\S]{10,1200}?)"\s*(?:\n|Check|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = t.match(/"([^"\n]{20,600})"\s*\n?\s*Check constraints/i);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/models') {
      const apiKey = env.GROQ_API_KEY || env.NVIDIA_API_KEY;
      if (!apiKey) return json({ error: 'No API key configured (GROQ_API_KEY)' }, 500);

      try {
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: 'Bearer ' + apiKey }
        });
        if (r.ok) {
          const d = await r.json();
          const list = (d.data || []).map(m => m.id).filter(id => !id.includes('whisper') && !id.includes('safetensors'));
          return json({ models: list.length ? list : GROQ_FALLBACK_MODELS });
        }
      } catch (e) {}

      return json({ models: GROQ_FALLBACK_MODELS });
    }

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      const origin = request.headers.get('Origin') || '';
      if (origin) {
        let oh = '';
        try { oh = new URL(origin).host; } catch (e) { return json({ error: 'bad origin' }, 403); }
        if (oh !== url.host) return json({ error: 'cross-origin blocked' }, 403);
      }

      if (parseInt(request.headers.get('Content-Length') || '0', 10) > 32768)
        return json({ error: 'payload too large' }, 413);

      const apiKey = env.GROQ_API_KEY || env.NVIDIA_API_KEY;
      if (!apiKey) return json({ error: 'AI API secret not set (GROQ_API_KEY)' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad JSON' }, 400); }
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: 'messages required' }, 400);

      const userSystem = body.messages[0]?.role === 'system' ? body.messages[0].content : '';
      const systemPrompt = userSystem + ' CRITICAL: You are Maya, a warm, intelligent, and highly encouraging Nepali study coach. Reply with ONLY the final answer. Never show reasoning steps, analysis, drafts, or constraint checks.';

      const messages = [
        { role: 'system', content: systemPrompt },
        ...body.messages.slice(1).slice(-12)
      ].map(m => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content || '').slice(0, 4000)
      }));

      const modelList = Array.from(new Set([
        env.GROQ_MODEL,
        ...GROQ_FALLBACK_MODELS
      ])).filter(Boolean);

      let lastStatus = 0, lastDetail = '', lastModel = '';
      let extracted = null, extractedModel = null, leaks = 0;

      for (const model of modelList) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 18000);

        try {
          const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.65,
              top_p: 0.9,
              max_tokens: 350,
              stream: false
            }),
            signal: controller.signal
          });
          clearTimeout(timeout);

          if (!upstream.ok) {
            lastStatus = upstream.status;
            lastModel = model;
            lastDetail = (await upstream.text().catch(() => '')).slice(0, 200);
            continue;
          }

          const data = await upstream.json();
          const reply = data.choices?.[0]?.message?.content || '';

          if (!reply || COT.test(reply)) {
            leaks++;
            if (reply && !extracted) { extracted = extractFinal(reply); extractedModel = model; }
            if (leaks >= 2 && extracted) break;
            lastStatus = 200; lastModel = model; lastDetail = 'reasoning leak or empty';
            continue;
          }

          return json({ reply, model: 'Groq · ' + model });
        } catch (e) {
          clearTimeout(timeout);
          lastStatus = 0; lastModel = model;
          lastDetail = e.message || String(e);
          if (lastDetail.includes('timeout') || lastDetail.includes('abort')) {
            lastStatus = 524;
          }
          continue;
        }
      }

      if (extracted) return json({ reply: extracted, model: 'Groq · ' + (extractedModel || 'groq') });
      return json({ error: 'Groq models unavailable (last status: ' + lastStatus + ' on ' + lastModel + ')', detail: lastDetail, tried: modelList }, 502);
    }

    return env.ASSETS.fetch(request);
  }
};