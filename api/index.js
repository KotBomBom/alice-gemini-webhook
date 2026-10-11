const MAX_HISTORY = 12;

// --- ДОБАВЛЕН БАЗОВЫЙ ПРОМПТ ---
const SYSTEM_PROMPT = `Ты — полезный и дружелюбный ассистент по имени Джеминай. 
Твоя задача — отвечать на вопросы пользователя четко, кратко и по делу. 
Если пользователь спрашивает о фактах, используй предоставленные результаты поиска. 
Если информации недостаточно, честно скажи об этом. 
Отвечай на русском языке, если пользователь не попросил иное. 
Избегай сложных технических терминов без объяснения. Не используй Morkdown.`;
// -------------------------------

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function aliceResponse(text, endSession = false, sessionState = {}) {
  return { version: "1.0", response: { text: String(text || "Не удалось ответить."), end_session: endSession }, session_state: sessionState };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk.toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function getCommand(body) {
  return String(body?.request?.command || body?.request?.original_utterance || body?.original_utterance || "").trim();
}

function getHistory(body) {
  return Array.isArray(body?.state?.session?.history) ? body.state.session.history.slice(-MAX_HISTORY) : [];
}

async function searchWeb(query) {
  if (!process.env.SERPER_API_KEY) return "";
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 5 })
  });
  if (!response.ok) throw new Error("Serper HTTP " + response.status);
  const data = await response.json();
  return (data.organic || []).slice(0, 5).map((x,i) => (i+1)+". "+(x.title||"")+"\n"+(x.snippet||"")+(x.link?"\n"+x.link:"")).join("\n\n");
}

// Обновленная функция askGemini
async function askGemini(prompt, history, searchContext) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY_MISSING: добавь переменную в Vercel для Production и передеплой");
  
  const contents = [];
  
  // Добавляем системный промпт как первое сообщение от пользователя (или модели, в зависимости от стратегии)
  // Здесь мы используем подход "System Instruction" через контент, так как это универсально для v1beta
  contents.push({ role: "user", parts: [{ text: SYSTEM_PROMPT }] });
  // Можно добавить ответ модели, чтобы закрепить контекст, но обычно достаточно одного промпта
  // contents.push({ role: "model", parts: [{ text: "Хорошо, я понял инструкцию." }] }); 

  for (const item of history) {
    if (item && typeof item.text === "string") {
      contents.push({ role: item.role === "model" ? "model" : "user", parts: [{ text: item.text }] });
    }
  }
  
  const finalPrompt = searchContext ? prompt + "\n\nРезультаты поиска:\n" + searchContext : prompt;
  contents.push({ role: "user", parts: [{ text: finalPrompt }] });
  
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ 
      contents, 
      generationConfig: { temperature: 0.7, maxOutputTokens: 700 } 
      // Если API поддерживает systemInstruction напрямую, можно добавить:
      // systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
    })
  });
  
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || "нет подробностей";
    throw new Error("GEMINI_HTTP_" + response.status + ": " + message);
  }
  
  const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE: " + (data?.promptFeedback?.blockReason || "модель не вернула текст"));
  return answer;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") return send(res, 200, { ok: true, service: "alice-gemini-webhook" });
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(res, 405, { error: "Method not allowed" }); }
    
    const body = await readBody(req);
    const command = getCommand(body);
    const sessionState = body?.state?.session || {};
    const history = getHistory(body);
    
    if (!command) return send(res, 200, aliceResponse("Привет! Я Джеминай ИИ. Задай мне вопрос.", false, { ...sessionState, history }));
    
    let searchContext = "";
    if (/сегодня|сейчас|последн|новост|погод|курс|цен[аыуе]?|актуальн|когда выйдет/i.test(command) && process.env.SERPER_API_KEY) {
      try { searchContext = await searchWeb(command); } catch (e) { console.error("Serper:", e.message); }
    }
    
    const answer = await askGemini(command, history, searchContext);
    
    const updatedHistory = [...history, { role: "user", text: command }, { role: "model", text: answer }].slice(-MAX_HISTORY);
    return send(res, 200, aliceResponse(answer, false, { ...sessionState, history: updatedHistory }));
  } catch (error) {
    const detail = String(error?.message || "unknown error");
    console.error("Alice webhook error:", error?.stack || detail);
    // Diagnostic message deliberately excludes all secrets/API key values.
    let message = "Ошибка подключения к Gemini. ";
    if (detail.startsWith("GEMINI_API_KEY_MISSING")) message += "В Vercel не найдена переменная GEMINI_API_KEY для Production.";
    else if (detail.startsWith("GEMINI_HTTP_400")) message += "Gemini отклонил запрос (400). " + detail.slice(15, 180);
    else if (detail.startsWith("GEMINI_HTTP_401") || detail.startsWith("GEMINI_HTTP_403")) message += "Проверь API-ключ и разрешения Gemini. " + detail.slice(15, 180);
    else if (detail.startsWith("GEMINI_HTTP_404")) message += "Модель или endpoint не найдены. " + detail.slice(15, 180);
    else if (detail.startsWith("GEMINI_HTTP_429")) message += "Превышен лимит запросов или квота. " + detail.slice(15, 180);
    else if (detail.startsWith("GEMINI_HTTP_")) message += detail.slice(0, 180);
    else if (detail.startsWith("GEMINI_EMPTY_RESPONSE")) message += "Модель не вернула текст. " + detail.slice(22, 140);
    else if (detail.startsWith("GEMINI_API_KEY_MISSING")) message += "Добавь GEMINI_API_KEY в Production.";
    else message += detail.slice(0, 180);
    return send(res, 200, aliceResponse(message));
  }
};
