// api/top-tasks.js
// Один API-крок Sandbox: категорія + чим підкріплюється + аудиторія + ціль -> 3-5 Top Tasks.
// Ключ ніколи не потрапляє в браузер: ця функція виконується на сервері Vercel,
// process.env.GEMINI_API_KEY береться з налаштувань проєкту, не з коду.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Метод не підтримується' });
    return;
  }

  const { category, support, audience, goal } = req.body || {};

  if (!category || !support || !audience || !goal) {
    res.status(400).json({ error: 'Не вистачає полів: category, support, audience, goal' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
      res.status(502).json({ error: 'Gemini не відповів', details: errText });
      return;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      res.status(502).json({ error: 'Порожня відповідь від моделі' });
      return;
    }

    const parsed = JSON.parse(rawText);

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      res.status(502).json({ error: 'Відповідь не містить tasks' });
      return;
    }

    res.status(200).json({ tasks: parsed.tasks });
  } catch (err) {
    res.status(500).json({ error: 'Помилка запиту', details: String(err) });
  }
}
