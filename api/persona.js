// api/persona.js
// Персонний аудит структур: калібрована персона (PERSONAS) + кілька структур
// блоків -> зауваження й висновок по кожній. Ключ ніколи не потрапляє
// в браузер: ця функція виконується на сервері Vercel, process.env.GEMINI_API_KEY
// береться з налаштувань проєкту, не з коду.

import { PERSONAS } from './personas.js';

const VALID_LEVELS = ['критично', 'помірно', 'незначно'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Метод не підтримується' });
    return;
  }

  const { personaKey, structures } = req.body || {};

  if (!personaKey || !Object.prototype.hasOwnProperty.call(PERSONAS, personaKey)) {
    res.status(400).json({ error: 'Невідома персона: ' + personaKey });
    return;
  }

  if (!Array.isArray(structures) || structures.length < 3 || structures.length > 4) {
    res.status(400).json({ error: 'structures має містити від 3 до 4 елементів' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
      return s.title + '\n' + items;
    })
    .join('\n\n');

  const prompt = `${persona.systemPrompt}

Нижче структури, які треба оцінити:

${structuresText}

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"structures": [{"id": "...", "remarks": [{"level": "критично|помірно|незначно", "text": "..."}], "conclusion": "..."}]}`;

  const validIds = structures.map(function (s) { return s.id; }).sort().join('|');

  function isValidLevel(level) {
    return VALID_LEVELS.indexOf(level) !== -1;
  }

  function attempt() {
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
          throw new Error('Gemini не відповів: ' + errText);
        });
      }
      return response.json();
    }).then(function (data) {
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error('Порожня відповідь від моделі');
      }

      const parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed.structures)) {
        throw new Error('Відповідь не містить structures');
      }

      const gotIds = parsed.structures.map(function (s) { return s.id; }).sort().join('|');
      if (gotIds !== validIds) {
        throw new Error('id у відповіді не збігаються з надісланими');
      }

      const levelsOk = parsed.structures.every(function (s) {
        return Array.isArray(s.remarks) && s.remarks.every(function (r) { return isValidLevel(r.level); });
      });
      if (!levelsOk) {
        throw new Error('level у зауваженні поза дозволеними значеннями');
      }

      return parsed.structures;
    });
  }

  try {
    const result = await attempt().catch(attempt);
    res.status(200).json({ structures: result });
  } catch (err) {
    res.status(502).json({ error: 'Не вдалось отримати коректну відповідь від моделі', details: String(err) });
  }
}
