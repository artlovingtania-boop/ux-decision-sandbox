// api/generate.js
// Один API-крок Sandbox: блоки + задачі + прив'язки + три значення осей ->
// один порядок блоків. Ключ ніколи не потрапляє в браузер: ця функція
// виконується на сервері Vercel, process.env.GEMINI_API_KEY береться
// з налаштувань проєкту, не з коду.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Метод не підтримується' });
    return;
  }

  const { category, support, audience, goal, tasks, blocks, axes } = req.body || {};

  if (!category || !support || !audience || !goal || !Array.isArray(blocks) || blocks.length === 0 || !axes) {
    console.error('[generate] нема обов’язкових полів', { category: !!category, support: !!support, audience: !!audience, goal: !!goal, blocks: Array.isArray(blocks) ? blocks.length : typeof blocks, axes: !!axes });
    res.status(400).json({ error: "Не вистачає полів: category, support, audience, goal, blocks, axes" });
    return;
  }

  const { evidence, grouping, weight } = axes;
  if (!evidence || !grouping || !weight) {
    console.error('[generate] axes без evidence/grouping/weight', axes);
    res.status(400).json({ error: 'axes має містити evidence, grouping, weight' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[generate] немає ключа на сервері');
    res.status(500).json({ error: 'Ключ не налаштований на сервері' });
    return;
  }

  const taskList = Array.isArray(tasks) ? tasks : [];
  const blocksText = blocks
    .map(function (b) {
      const unitPart = b.unit ? b.unit + (b.count ? ' · ' + b.count : '') : '';
      const tasksPart = Array.isArray(b.tasks) && b.tasks.length ? b.tasks.join(', ') : 'без задач';
      return '- "' + b.name + '"' + (unitPart ? ' (' + unitPart + ')' : '') + ' — задачі: ' + tasksPart;
    })
    .join('\n');

  // Промпт вимагає рівно ті самі блоки — жодного додавання, вилучення
  // чи перейменування — і повертає тільки порядок, без осей і пояснень:
  // осі й так відомі виклику (вони задані клієнтом), а не моделлю.
  const prompt = `Ти складаєш порядок блоків односторінкової структури під задані параметри.

Категорія продукту: ${category}
Чим підкріплюється діяльність: ${support}
Цільова аудиторія: ${audience}
Бізнес-ціль: ${goal}
Top Tasks: ${taskList.length ? taskList.join(', ') : 'не задані'}

Блоки й задачі, які вони закривають:
${blocksText}

Три значення осей, під які будується порядок:
- Доказова база до дії: ${evidence}
- Принцип групування: ${grouping}
- Розподіл ваги: ${weight}

Виведи ОДИН порядок блоків, що найкраще відповідає цим трьом значенням разом.
Використай РІВНО ті самі блоки, що перелічені вище, усі без винятку — нічого не додавай, не вилучай і не перейменовуй.

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"order": ["назва блоку", "назва блоку", ...]}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
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
        console.error('[generate] 429 ліміт Gemini', errText.slice(0, 200));
      } else if (isOverloaded) {
        console.error('[generate] 503 Gemini перевантажений', errText.slice(0, 200));
      } else {
        console.error('[generate] Gemini відповів не-200', response.status, errText.slice(0, 200));
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
      console.error('[generate] порожня відповідь від моделі');
      res.status(502).json({ error: 'Порожня відповідь від моделі' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('[generate] JSON.parse rawText упав', rawText.slice(0, 200));
      throw parseErr;
    }

    if (!Array.isArray(parsed.order) || parsed.order.length === 0) {
      console.error(
        '[generate] order не масив або порожній',
        'отримано:', JSON.stringify(parsed.order).slice(0, 200),
        'очікувані блоки:', blocks.map(function (b) { return b.name; })
      );
      res.status(502).json({ error: 'Відповідь не містить order' });
      return;
    }

    res.status(200).json({ order: parsed.order });
  } catch (err) {
    res.status(500).json({ error: 'Помилка запиту', details: String(err) });
  }
}
