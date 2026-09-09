// api/top-tasks.js
// Один API-крок Sandbox: категорія + чим підкріплюється + аудиторія + ціль -> 3-5 Top Tasks.
// Ключ ніколи не потрапляє в браузер: ця функція виконується на сервері Vercel,
// process.env.GEMINI_API_KEY береться з налаштувань проєкту, не з коду.

// gemini-3.1-flash-lite іноді додає після валідного JSON уламок
// markdown-огорожі — той самий підхід, що в api/generate.js (коміт
// 36e5960): виділяємо перший повний {...} лічильником дужок, а не
// регуляркою.
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) { return null; }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Метод не підтримується' });
    return;
  }

  const { category, support, audience, goal } = req.body || {};

  if (!category || !support || !audience || !goal) {
    console.error('[top-tasks] нема обов’язкових полів', { category: !!category, support: !!support, audience: !!audience, goal: !!goal });
    res.status(400).json({ error: 'Не вистачає полів: category, support, audience, goal' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[top-tasks] немає ключа на сервері');
    res.status(500).json({ error: 'Ключ не налаштований на сервері' });
    return;
  }

  // Промпт побудований на формулюванні з ядра: "дієслово + об'єкт", 3-5 задач,
  // виведених з аудиторії та бізнес-цілі, без вигаданих деталей поза цими двома полями.
  const prompt = `Ти допомагаєш вивести Top Tasks для односторінкової структури.

Категорія продукту: ${category}
Чим підкріплюється діяльність: ${support}
Цільова аудиторія: ${audience}
Бізнес-ціль: ${goal}

Виведи від 3 до 5 Top Tasks — задач, які ця аудиторія вирішує на сторінці.
Формат кожної задачі: "дієслово + об'єкт" (наприклад: "підтвердити легітимність організації").
Виводь тільки задачі, що прямо випливають з аудиторії й цілі — нічого не вигадуй понад це.

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"tasks": ["...", "...", "..."]}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      const isRateLimit = response.status === 429;
      const isOverloaded = response.status === 503;
      if (isRateLimit) {
        console.error('[top-tasks] 429 ліміт Gemini', errText.slice(0, 200));
      } else if (isOverloaded) {
        console.error('[top-tasks] 503 Gemini перевантажений', errText.slice(0, 200));
      } else {
        console.error('[top-tasks] Gemini відповів не-200', response.status, errText.slice(0, 200));
      }
      const errorBody = { error: 'Gemini не відповів', details: errText };
      if (isRateLimit) { errorBody.limit = true; }
      if (isOverloaded) { errorBody.overloaded = true; }
      res.status(502).json(errorBody);
      return;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error('[top-tasks] порожня відповідь від моделі');
      res.status(502).json({ error: 'Порожня відповідь від моделі' });
      return;
    }

    let parsed;
    try {
      const jsonSlice = extractFirstJsonObject(rawText);
      if (jsonSlice === null) {
        throw new Error('JSON-об’єкт не знайдено у відповіді');
      }
      parsed = JSON.parse(jsonSlice);
    } catch (parseErr) {
      console.error('[top-tasks] JSON.parse rawText упав', rawText.slice(0, 200));
      res.status(502).json({ error: 'Не вдалось розпарсити відповідь моделі', details: String(parseErr) });
      return;
    }

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      console.error('[top-tasks] tasks не масив або порожній', 'отримано:', JSON.stringify(parsed.tasks).slice(0, 200));
      res.status(502).json({ error: 'Відповідь не містить tasks' });
      return;
    }

    res.status(200).json({ tasks: parsed.tasks });
  } catch (err) {
    res.status(500).json({ error: 'Помилка запиту', details: String(err) });
  }
}
