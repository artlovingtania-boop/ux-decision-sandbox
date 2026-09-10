// api/generate.js
// Один API-крок Sandbox: блоки + задачі + прив'язки + три значення осей ->
// один порядок блоків. Ключ ніколи не потрапляє в браузер: ця функція
// виконується на сервері Vercel, process.env.GEMINI_API_KEY береться
// з налаштувань проєкту, не з коду.

// gemini-3.1-flash-lite іноді додає після валідного JSON уламок
// markdown-огорожі (наприклад "``]}" другим рядком) — JSON.parse на
// всьому тексті падає, хоча сам об'єкт коректний. Виділяємо перший
// повний {...} лічильником дужок, а не регуляркою: вкладені об'єкти
// й лапки в назвах блоків регулярку зламали б. Дужки й лапки всередині
// рядкових значень ігноруються (з урахуванням екранованих \").
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

// Опис значення осі "Принцип групування" для промпту — підставляється
// лише те значення, яке прийшло від клієнта, не всі три одразу.
const GROUPING_DESCRIPTIONS = {
  'за типом контенту': 'блоки згруповані за тим, ЧИМ вони є: спершу все про організацію, потім усе про діяльність, потім усе про оточення',
  'за задачею': 'блоки згруповані за тим, ЯКУ ЗАДАЧУ вони обслуговують: спершу всі блоки першої задачі, потім другої',
  'за етапом знайомства': 'блоки згруповані за тим, НАСКІЛЬКИ глибоко зайшов відвідувач: перше враження → перевірка → рішення'
};

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
  // Відсортовані за назвою (не в порядку, як прийшли від дизайнера) —
  // інакше модель переписує вхідний порядок майже без змін, він служить
  // їй якорем. .slice() — не чіпає оригінальний blocks, він ще потрібен
  // нижче для звірки order.
  const blocksText = blocks
    .slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'uk'); })
    .map(function (b) {
      const unitPart = b.unit ? b.unit + (b.count ? ' · ' + b.count : '') : '';
      const tasksPart = Array.isArray(b.tasks) && b.tasks.length ? b.tasks.join(', ') : 'без задач';
      return '- "' + b.name + '"' + (unitPart ? ' (' + unitPart + ')' : '') + ' — задачі: ' + tasksPart;
    })
    .join('\n');

  const groupingDescription = GROUPING_DESCRIPTIONS[grouping] || grouping;
  // TT1/TT2/TT3/... — та сама схема для будь-якого номера задачі;
  // "рівний" — окремий випадок, без пріоритету.
  const weightDescription = weight === 'рівний'
    ? 'жодна задача не має переваги в порядку'
    : 'значення "' + weight + '" означає, що блоки задачі ' + weight + ' мають стояти раніше за блоки інших задач: людина, яка прийшла з цією задачею, має закрити її якнайшвидше';

  // Промпт вимагає рівно ті самі блоки — жодного додавання, вилучення
  // чи перейменування — і повертає тільки порядок, без осей і пояснень:
  // осі й так відомі виклику (вони задані клієнтом), а не моделлю.
  // Доказова база до дії тут не згадується взагалі — точки дії ставить
  // код після відповіді моделі, модель на них не впливає.
  const prompt = `Ти складаєш порядок блоків односторінкової структури під задані параметри.

Категорія продукту: ${category}
Чим підкріплюється діяльність: ${support}
Цільова аудиторія: ${audience}
Бізнес-ціль: ${goal}
Top Tasks: ${taskList.length ? taskList.join(', ') : 'не задані'}

Перелік нижче — набір блоків, а не порядок. Порядок, у якому вони перелічені, довільний і підказкою не є.

Блоки й задачі, які вони закривають:
${blocksText}

Принцип групування: ${grouping} — ${groupingDescription}
Розподіл ваги: ${weight} — ${weightDescription}

Виведи ОДИН порядок блоків, що найкраще відповідає цим двом значенням разом.
Використай РІВНО ті самі блоки, що перелічені вище, усі без винятку — нічого не додавай, не вилучай і не перейменовуй.

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"order": ["назва блоку", "назва блоку", ...]}`;

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
      const jsonSlice = extractFirstJsonObject(rawText);
      if (jsonSlice === null) {
        throw new Error('JSON-об’єкт не знайдено у відповіді');
      }
      parsed = JSON.parse(jsonSlice);
    } catch (parseErr) {
      console.error('[generate] JSON.parse rawText упав', rawText.slice(0, 200));
      res.status(502).json({ error: 'Не вдалось розпарсити відповідь моделі', details: String(parseErr) });
      return;
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
