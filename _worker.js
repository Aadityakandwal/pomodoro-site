/* Pomodoro d'Oro — AI proxy (key stays server-side) */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/* Direct-answer models only. Reasoning-suffix models removed entirely. */
const FALLBACK_MODELS = [
  'nvidia/mistral-nemo-minitron-8b-8k-instruct',
  'google/gemma-4-31b-it',
  'mistralai/mistral-large-2-instruct',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b'
];
const RETRY_STATUSES = new Set([404, 410]);

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
      if (!env.NVIDIA_API_KEY) return json({ error: 'NVIDIA_API_KEY secret not set' }, 500);
      const r = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: 'Bearer ' + env.NVIDIA_API_KEY } });
      if (!r.ok) return json({ error: 'upstream ' + r.status }, 502);
      const d = await r.json();
      return json({ models: (d.data || []).map(m => m.id) });
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
      if (!env.NVIDIA_API_KEY) return json({ error: 'NVIDIA_API_KEY secret not set' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad JSON' }, 400); }
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: 'messages required' }, 400);

      const userSystem = body.messages[0]?.role === 'system' ? body.messages[0].content : '';
      const messages = [
        { role: 'system', content: userSystem + ' CRITICAL: Reply with ONLY the final answer. Never show reasoning steps, analysis, drafts, or constraint checks.' },
        ...body.messages.slice(1).slice(-12)
      ].map(m => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content || '').slice(0, 4000)
      }));

      const models = [env.NVIDIA_MODEL, ...FALLBACK_MODELS].filter(Boolean);
      let lastStatus = 0, lastDetail = '', lastModel = '';
      let extracted = null, extractedModel = null, leaks = 0;

      for (const model of models) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        try {
          const upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.NVIDIA_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ model, messages, temperature: 0.6, top_p: 0.9, max_tokens: 280, stream: false }),
            signal: controller.signal
          });
          clearTimeout(timeout);

        if (!upstream.ok) {
          lastStatus = upstream.status; lastModel = model;
          lastDetail = (await upstream.text().catch(() => '')).slice(0, 200);
          if (!RETRY_STATUSES.has(upstream.status)) break;
          continue;
        }

        const data = await upstream.json();
        const reply = data.choices?.[0]?.message?.content || '';

        if (COT.test(reply)) {
          /* leaky model: salvage the draft, then try the next model for a clean one */
          leaks++;
          if (!extracted) { extracted = extractFinal(reply); extractedModel = model; }
          if (leaks >= 2 && extracted) break;
          lastStatus = 200; lastModel = model; lastDetail = 'reasoning leak';
          continue;
        }
        return json({ reply, model });
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

      if (extracted) return json({ reply: extracted, model: (extractedModel || 'unknown') + ' (draft-extracted)' });
      return json({ error: 'all models failed (last: ' + lastStatus + ' on ' + lastModel + ')', detail: lastDetail, tried: models }, 502);
    }

    return env.ASSETS.fetch(request);
  }
};