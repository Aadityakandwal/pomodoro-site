/* Pomodoro d'Oro — Universal AI Proxy (Groq & NVIDIA) */
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

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'mixtral-8x7b-32768'
];

const NVIDIA_MODELS = [
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'nvidia/mistral-nemo-minitron-8b-8k-instruct'
];

/* Detect chain-of-thought leaking into visible output */
const COT = /here'?s a thinking process|thinking process:|draft response:|\bdraft:\s*"|check constraints|\b\d+\.\s*(analyze user input|check (current )?context|determine response)/i;

function extractFinal(t) {
  let m = t.match(/Draft(?:\s+Response)?:\s*"([\s\S]{10,1200}?)"\s*(?:\n|Check|$)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = t.match(/"([^"\n]{20,600})"\s*\n?\s*Check constraints/i);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}

function resolveKeys(env) {
  let groqKey = (env.GROQ_API_KEY || '').trim();
  let nvidiaKey = (env.NVIDIA_API_KEY || '').trim();

  // Auto-detect misplaced key strings
  if (!groqKey && nvidiaKey.startsWith('gsk_')) {
    groqKey = nvidiaKey;
  }
  if (!nvidiaKey && groqKey.startsWith('nvapi-')) {
    nvidiaKey = groqKey;
  }
  return { groqKey, nvidiaKey };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { groqKey, nvidiaKey } = resolveKeys(env);

    if (url.pathname === '/api/models') {
      if (!groqKey && !nvidiaKey) return json({ error: 'No API key configured (GROQ_API_KEY or NVIDIA_API_KEY)' }, 500);

      if (groqKey) {
        try {
          const r = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: 'Bearer ' + groqKey }
          });
          if (r.ok) {
            const d = await r.json();
            const list = (d.data || []).map(m => m.id).filter(id => !id.includes('whisper') && !id.includes('safetensors'));
            return json({ models: list.length ? list : GROQ_MODELS, provider: 'groq' });
          }
        } catch (e) {}
      }

      if (nvidiaKey) {
        try {
          const r = await fetch('https://integrate.api.nvidia.com/v1/models', {
            headers: { Authorization: 'Bearer ' + nvidiaKey }
          });
          if (r.ok) {
            const d = await r.json();
            return json({ models: (d.data || []).map(m => m.id), provider: 'nvidia' });
          }
        } catch (e) {}
      }

      return json({ models: [...GROQ_MODELS, ...NVIDIA_MODELS] });
    }

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      const origin = request.headers.get('Origin') || '';
      if (origin) {
        let oh = '';
        try { oh = new URL(origin).host; } catch (e) { return json({ error: 'bad origin header: ' + origin }, 403); }
        if (oh !== url.host && !oh.endsWith('.pages.dev') && !oh.includes('localhost') && !oh.includes('127.0.0.1')) {
          return json({ error: 'cross-origin blocked: ' + oh + ' vs ' + url.host }, 403);
        }
      }

      if (parseInt(request.headers.get('Content-Length') || '0', 10) > 32768)
        return json({ error: 'payload too large' }, 413);

      if (!groqKey && !nvidiaKey) return json({ error: 'AI API secret not set (GROQ_API_KEY or NVIDIA_API_KEY)' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad JSON' }, 400); }
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: 'messages required' }, 400);

      const userSystem = body.messages[0]?.role === 'system' ? body.messages[0].content : '';
      const systemPrompt = userSystem + ' CRITICAL: You are Maya, a warm, concise Nepali study coach. Reply with ONLY the final answer. Never show reasoning steps, drafts, or constraint checks.';

      const messages = [
        { role: 'system', content: systemPrompt },
        ...body.messages.slice(1).slice(-10)
      ].map(m => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content || '').slice(0, 3000)
      }));

      let lastStatus = 0, lastDetail = '', lastModel = '';
      let extracted = null, extractedModel = null, leaks = 0;

      /* Try Groq API if Groq key exists */
      if (groqKey) {
        const groqList = Array.from(new Set([env.GROQ_MODEL, ...GROQ_MODELS])).filter(Boolean);
        for (const model of groqList) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + groqKey,
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
              lastStatus = upstream.status; lastModel = model;
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
            continue;
          }
        }
      }

      /* Fallback to NVIDIA API if NVIDIA key exists */
      if (nvidiaKey) {
        const nvidList = Array.from(new Set([env.NVIDIA_MODEL, ...NVIDIA_MODELS])).filter(Boolean);
        for (const model of nvidList) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 18000);
          try {
            const upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + nvidiaKey,
                'Content-Type': 'application/json',
                Accept: 'application/json'
              },
              body: JSON.stringify({ model, messages, temperature: 0.6, top_p: 0.9, max_tokens: 300, stream: false }),
              signal: controller.signal
            });
            clearTimeout(timeout);

            if (!upstream.ok) {
              lastStatus = upstream.status; lastModel = model;
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

            return json({ reply, model: 'NVIDIA · ' + model });
          } catch (e) {
            clearTimeout(timeout);
            lastStatus = 0; lastModel = model;
            lastDetail = e.message || String(e);
            continue;
          }
        }
      }

      if (extracted) return json({ reply: extracted, model: 'AI · ' + (extractedModel || 'fallback') });
      return json({ error: 'AI service unavailable (status: ' + lastStatus + ' on ' + lastModel + ')', detail: lastDetail }, 502);
    }

    return env.ASSETS.fetch(request);
  }
};