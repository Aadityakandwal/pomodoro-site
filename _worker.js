/* Pomodoro d'Oro — Pure Groq AI Proxy */
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

// Active supported Groq fallback models (decommissioned models like mixtral-8x7b removed)
const GROQ_FALLBACK_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it'
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

function getGroqKey(env) {
  let key = (env.GROQ_API_KEY || env.NVIDIA_API_KEY || '').trim();
  return key;
}

async function fetchActiveGroqModels(groqKey) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: 'Bearer ' + groqKey }
    });
    if (r.ok) {
      const d = await r.json();
      const list = (d.data || [])
        .map(m => m.id)
        .filter(id => !id.includes('whisper') && !id.includes('safetensors') && !id.includes('guard') && !id.includes('mixtral-8x7b'));
      if (list.length) return list;
    }
  } catch (e) {}
  return GROQ_FALLBACK_MODELS;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const groqKey = getGroqKey(env);

    if (url.pathname === '/api/models') {
      if (!groqKey) return json({ error: 'No Groq API key configured in Cloudflare secrets (GROQ_API_KEY)' }, 500);
      const models = await fetchActiveGroqModels(groqKey);
      return json({ models, provider: 'groq' });
    }

    if (url.pathname === '/api/yt-search') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return json({ results: [] });
      try {
        const upstream = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        const html = await upstream.text();
        const results = [];
        const reg = /"videoRenderer":{"videoId":"([^"]{11})".+?"title":{"runs":\[{"text":"([^"]+)"/g;
        let m;
        while ((m = reg.exec(html)) !== null && results.length < 8) {
          if (!results.some(r => r.ytId === m[1])) {
            results.push({
              id: 'Y' + m[1],
              kind: 'yt',
              ytId: m[1],
              title: m[2],
              source: 'YouTube'
            });
          }
        }
        return json({ results });
      } catch (e) {
        return json({ results: [] });
      }
    }

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

      if (!groqKey) return json({ error: 'No Groq API key configured in Cloudflare Secrets. Please add GROQ_API_KEY secret.' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad JSON' }, 400); }
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: 'messages required' }, 400);

      const userSystem = body.messages[0]?.role === 'system' ? body.messages[0].content : '';
      const systemPrompt = userSystem + ' CRITICAL: You are Maya, a sweet, warm, cheerful girl study coach and companion. Speak with a caring, encouraging female tone with cute emojis. Reply with ONLY the final answer. Never show reasoning steps, drafts, or constraint checks.';

      const messages = [
        { role: 'system', content: systemPrompt },
        ...body.messages.slice(1).slice(-10)
      ].map(m => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content || '').slice(0, 3000)
      }));

      // Fetch live models from Groq API directly so decommissioned models are NEVER queried!
      let activeModels = await fetchActiveGroqModels(groqKey);
      if (env.GROQ_MODEL && activeModels.includes(env.GROQ_MODEL)) {
        activeModels = [env.GROQ_MODEL, ...activeModels.filter(m => m !== env.GROQ_MODEL)];
      }

      let lastStatus = 0, lastDetail = '', lastModel = '';
      let extracted = null, extractedModel = null, leaks = 0;

      for (const model of activeModels) {
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
            lastDetail = (await upstream.text().catch(() => '')).slice(0, 250);
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

      if (extracted) return json({ reply: extracted, model: 'Groq · ' + (extractedModel || 'llama-3.3-70b-versatile') });
      return json({ error: 'Groq API Error (' + lastStatus + ' on ' + lastModel + ')', detail: lastDetail, tried: activeModels }, 502);
    }

    return env.ASSETS.fetch(request);
  }
};