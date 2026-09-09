// api/persona.js
// Персонний аудит структур: калібрована персона (PERSONAS) + кілька структур
// блоків -> зауваження й висновок по кожній. Ключ ніколи не потрапляє
// в браузер: ця функція виконується на сервері Vercel, process.env.GEMINI_API_KEY
// береться з налаштувань проєкту, не з коду.

import { PERSONAS } from './personas.js';

const VALID_LEVELS = ['критично', 'помірно', 'незначно'];

// gemini-3.6-flash іноді додає після валідного JSON уламок markdown-
// огорожі — той самий підхід, що в api/generate.js (коміт 36e5960):
// виділяємо перший повний {...} лічильником дужок, а не регуляркою,
// бо вкладені об'єкти й лапки в назвах блоків її зламають. Дужки й
// лапки всередині рядкових значень ігноруються (з урахуванням
// екранованих \").
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

  const { personaKey, structures } = req.body || {};

  if (!personaKey || !Object.prototype.hasOwnProperty.call(PERSONAS, personaKey)) {
    console.error('[persona] невідома persona', personaKey);
    res.status(400).json({ error: 'Невідома персона: ' + personaKey });
    return;
  }

  if (!Array.isArray(structures) || structures.length < 3 || structures.length > 4) {
    console.error('[persona] structures поза межами 3-4', Array.isArray(structures) ? structures.length : typeof structures);
    res.status(400).json({ error: 'structures має містити від 3 до 4 елементів' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[persona] немає ключа на сервері');
    res.status(500).json({ error: 'Ключ не налаштований на сервері' });
    return;
  }

  const persona = PERSONAS[personaKey];

  const structuresText = structures
    .map(function (s) {
      const items = s.order
        .map(function (b, i) {
          return (i + 1) + '. ' + b.name + (b.action ? ' (точка дії)' : '');
        })
        .join('\n');
      return '[id: ' + s.id + '] ' + s.title + '\n' + items;
    })
    .join('\n\n');

  const prompt = `${persona.systemPrompt}

Нижче структури, які треба оцінити:

${structuresText}

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"structures": [{"id": "...", "remarks": [{"level": "критично|помірно|незначно", "text": "..."}], "conclusion": "..."}]}
Поле id має точно збігатися з id структури, під яким вона подана вище.`;

  const validIds = structures.map(function (s) { return s.id; }).sort().join('|');

  function isValidLevel(level) {
    return VALID_LEVELS.indexOf(level) !== -1;
  }

  function attempt(n) {
    return fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    ).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (errText) {
          if (response.status === 429) {
            console.error('[persona] спроба ' + n + ': 429 ліміт Gemini', errText.slice(0, 200));
          } else if (response.status === 503) {
            console.error('[persona] спроба ' + n + ': 503 Gemini перевантажений', errText.slice(0, 200));
          } else {
            console.error('[persona] спроба ' + n + ': Gemini відповів не-200', response.status, errText.slice(0, 200));
          }
          const err = new Error('Gemini не відповів: ' + errText);
          if (response.status === 429) { err.isLimit = true; }
          if (response.status === 503) { err.isOverloaded = true; }
          throw err;
        });
      }
      return response.json();
    }).then(function (data) {
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        console.error('[persona] спроба ' + n + ': порожня відповідь від моделі');
        throw new Error('Порожня відповідь від моделі');
      }

      let parsed;
      try {
        const jsonSlice = extractFirstJsonObject(rawText);
        if (jsonSlice === null) {
          throw new Error('JSON-об’єкт не знайдено у відповіді');
        }
        parsed = JSON.parse(jsonSlice);
      } catch (parseErr) {
        console.error('[persona] спроба ' + n + ': JSON.parse rawText упав', rawText.slice(0, 200));
        throw parseErr;
      }

      if (!Array.isArray(parsed.structures)) {
        console.error('[persona] спроба ' + n + ': відповідь без structures', JSON.stringify(parsed).slice(0, 200));
        throw new Error('Відповідь не містить structures');
      }

      const gotIds = parsed.structures.map(function (s) { return s.id; }).sort().join('|');
      if (gotIds !== validIds) {
        console.error('[persona] спроба ' + n + ': id не збігаються', 'очікувалось:', validIds, 'отримано:', gotIds);
        throw new Error('id у відповіді не збігаються з надісланими');
      }

      const invalidStructure = parsed.structures.find(function (s) {
        return !Array.isArray(s.remarks) || !s.remarks.every(function (r) { return isValidLevel(r.level); });
      });
      if (invalidStructure) {
        console.error(
          '[persona] спроба ' + n + ': level поза дозволеними значеннями',
          'structure id:', invalidStructure.id,
          'remarks:', JSON.stringify(invalidStructure.remarks).slice(0, 200)
        );
        throw new Error('level у зауваженні поза дозволеними значеннями');
      }

      return parsed.structures;
    });
  }

  try {
    const result = await attempt(1).catch(function () { return attempt(2); });
    res.status(200).json({ structures: result });
  } catch (err) {
    const errorBody = { error: 'Не вдалось отримати коректну відповідь від моделі', details: String(err) };
    if (err && err.isLimit) { errorBody.limit = true; }
    if (err && err.isOverloaded) { errorBody.overloaded = true; }
    res.status(502).json(errorBody);
  }
}
