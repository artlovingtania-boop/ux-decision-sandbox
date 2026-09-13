// api/parse.js
// Один API-крок Sandbox: два документи дизайнера (бриф проєкту й опис
// сторінки) -> поля форми: категорія, підкріплення, аудиторії, ціль,
// Top Tasks, перелік блоків. Ключ ніколи не потрапляє в браузер: ця
// функція виконується на сервері Vercel, process.env.GEMINI_API_KEY
// береться з налаштувань проєкту, не з коду.

// Gemini (помічено на gemini-3.1-flash-lite) іноді додає після валідного
// JSON уламок markdown-огорожі — той самий підхід, що в api/generate.js і
// api/top-tasks.js: виділяємо перший повний {...} лічильником дужок,
// а не регуляркою. Третя копія функції — спільний модуль окремим
// рефакторингом.
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

// Форма приймає максимум дві аудиторії (MAX_AUDIENCES в app.html)
const MAX_AUDIENCES = 2;

function asString(value) {
  if (typeof value === 'string') { return value.trim(); }
  if (typeof value === 'number') { return String(value); }
  return '';
}

// count у формі — поле type="number", тож сюди доходить тільки рядок цифр
// або порожній рядок. Діапазон — верхня межа (правило 3 промпту: аудит
// помиляється в бік суворості); усе інше нечислове — порожнє (правило 1:
// порожнє замість припущеного). fix — опис виправлення для логу або null.
function normalizeCount(raw) {
  if (raw === '') { return { value: '', fix: null }; }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return { value: raw.trim(), fix: null };
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { value: String(raw), fix: 'число ' + raw + ' → рядок' };
  }
  const range = typeof raw === 'string' ? raw.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/) : null;
  if (range) {
    const upper = String(Math.max(Number(range[1]), Number(range[2])));
    return { value: upper, fix: 'діапазон ' + JSON.stringify(raw) + ' → ' + upper };
  }
  return { value: '', fix: 'нечислове ' + JSON.stringify(raw) + ' → порожнє' };
}

// Джерело значення: 'page' — стоїть в описі сторінки дослівно, 'brief' —
// у брифі дослівно, 'agent' — усе інше (складене, переформульоване,
// виведене). 'designer' ставить лише клієнт, коли дизайнер править поле, —
// від моделі воно не приймається.
const MODEL_SOURCES = ['page', 'brief', 'agent'];

// Дослівність — обчислення, не судження, тож її перевіряє код: регістр,
// пробіли й типографські лапки/апострофи вирівнюються, крайова пунктуація
// відкидається, і значення шукається в документі цілими словами.
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’ʼ`']/g, "'")
    .replace(/[«»“”„"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,;:!?"'()—–\-\s]+|[.,;:!?"'()—–\-\s]+$/g, '');
}

// Цілими словами, не підрядком. Підрядок робив перевірку залежною від
// відмінка: «показник» проходив як дослівний, бо сидить усередині
// «показників», а «картка» при «картки» — ні. Тепер обидва — не дослівно.
function containsAsWords(haystack, needle) {
  if (haystack === '' || needle === '') { return false; }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?=$|[^\\p{L}\\p{N}])', 'u').test(haystack);
}

// Джерело для порожнього значення — null: позначати нічого. Невідоме
// джерело → 'agent' (походження, яке не можна перевірити, взятим з
// документа не вважається). verbatim — чи перевіряти дослівність: для
// count ні, бо «три» в тексті стає "3".
function normalizeSource(rawSource, value, label, docs, verbatim, fixes) {
  if (value === '') { return null; }
  if (MODEL_SOURCES.indexOf(rawSource) === -1) {
    fixes.push('джерело ' + label + ' ' + JSON.stringify(rawSource) + ' → "agent"');
    return 'agent';
  }
  if (verbatim && rawSource !== 'agent') {
    if (!containsAsWords(normalizeForMatch(docs[rawSource]), normalizeForMatch(value))) {
      fixes.push('джерело ' + label + ' "' + rawSource + '", але дослівно в документі немає → "agent"');
      return 'agent';
    }
  }
  return rawSource;
}

// Прив'язки блок ↔ задача ↔ аудиторія. Модель не знає id, тож повертає
// пари текстом, а код зіставляє текст із щойно нормалізованими tasks і
// audiences. Точний збіг рядка тут не годиться: модель переказує своїми
// словами (на джерелах — 10 разів з 10). Тому — перетин основ слів
// (Жаккар): основа — перші STEM_LENGTH літер, щоб «спонсори»/«спонсорів»
// збігались без справжнього стемера; службові слова й слова до двох літер
// відкидаються, щоб спільне «для» не зшивало дві різні задачі. Кандидатів
// мало (рівно три задачі, до двох аудиторій), тож замість порогу у
// відсотках — найкращий із них, аби бал був більший за нуль.
const STEM_LENGTH = 5;
const LINK_STOPWORDS = ['та', 'для', 'від', 'про', 'або', 'під', 'над', 'при', 'без', 'через', 'що', 'як', 'усі', 'всі', 'це'];

function linkStems(text) {
  const stems = new Set();
  normalizeForMatch(text).split(/[^\p{L}\p{N}']+/u).forEach(function (word) {
    if (word.length <= 2 || LINK_STOPWORDS.indexOf(word) !== -1) { return; }
    stems.add(word.slice(0, STEM_LENGTH));
  });
  return stems;
}

function jaccard(a, b) {
  let intersection = 0;
  a.forEach(function (stem) { if (b.has(stem)) { intersection++; } });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Найкращий кандидат для тексту: { index, tied } або null, якщо жоден не
// має спільної основи. Точний збіг (після нормалізації) виграє одразу.
// tied — чи ділить найкращий бал ще хтось: що з нічиєю робити, вирішує
// виклик (задачі й аудиторії поводяться по-різному, див. resolveLinks).
function bestMatch(text, candidateValues) {
  const normalized = normalizeForMatch(text);
  const exact = candidateValues.findIndex(function (v) { return normalizeForMatch(v) === normalized; });
  if (exact !== -1) { return { index: exact, tied: false }; }
  const stems = linkStems(text);
  const scores = candidateValues.map(function (v) { return jaccard(stems, linkStems(v)); });
  const best = Math.max.apply(null, scores.concat(0));
  if (best === 0) { return null; }
  const top = scores.reduce(function (acc, s, i) { if (s === best) { acc.push(i); } return acc; }, []);
  return { index: top[0], tied: top.length > 1 };
}

// Сирі пари блоку → пари з канонічними текстами (рівно ті, що в tasks і
// audiences відповіді; клієнт перетворює їх на id точним збігом).
//   не масив / немає → null (модель не відповіла — видно в «Не вистачає»)
//   []               → [] (модель сказала «блок не обслуговує задач»)
//   пари, частина відкинута → решта
//   пари, відкинуто всі     → null, не []: інакше збій зіставлення виглядав
//     би як свідомо «не обслуговує задач» і сховався б
// Задача при нічиї — перша з рівних із warn: задач три, з одного домену,
// нічия там імовірна, а відкинута пара дала б блок без задачі — прогалину,
// яку не видно (блок без задачі не блокує). Хибну прив'язку дизайнер
// побачить у картці й виправить. Аудиторія при нічиї — відкидається:
// аудиторій дві, і нічия між ними — справді «незрозуміло, кому».
// Аудиторія, що найкраще збігається з droppedAudiences, — теж відкидається:
// її у формі немає, а приписати її сусідній аудиторії — хибна пара.
function resolveLinks(rawLinks, label, tasks, audiences, droppedAudiences, fixes) {
  if (!Array.isArray(rawLinks)) {
    fixes.push(label + ' links ' + JSON.stringify(rawLinks) + ' не масив → null');
    return null;
  }
  if (rawLinks.length === 0) { return []; }

  const taskValues = tasks.map(function (t) { return t.value; });
  const audienceValues = audiences.map(function (a) { return a.value; });
  const droppedValues = droppedAudiences.map(function (a) { return a.value; });
  const resolved = [];

  rawLinks.forEach(function (link, i) {
    const pairLabel = label + ' links[' + i + ']';
    const isObject = link !== null && typeof link === 'object';
    const taskText = asString(isObject ? link.task : undefined);
    const audienceText = asString(isObject ? link.audience : undefined);
    if (taskText === '' || audienceText === '') {
      fixes.push('прив\'язка ' + pairLabel + ' ' + JSON.stringify(link) + ' без задачі чи аудиторії → відкинуто');
      return;
    }

    const task = bestMatch(taskText, taskValues);
    if (task === null) {
      fixes.push('прив\'язка ' + pairLabel + ' задача ' + JSON.stringify(taskText) + ' не зіставилась → відкинуто');
      return;
    }
    if (task.tied) {
      fixes.push('нічия при зіставленні ' + pairLabel + ' задача ' + JSON.stringify(taskText) + ' → перша з рівних ' + JSON.stringify(taskValues[task.index]));
    }

    const audience = bestMatch(audienceText, audienceValues.concat(droppedValues));
    if (audience === null) {
      fixes.push('прив\'язка ' + pairLabel + ' аудиторія ' + JSON.stringify(audienceText) + ' не зіставилась → відкинуто');
      return;
    }
    if (audience.tied) {
      fixes.push('прив\'язка ' + pairLabel + ' аудиторія ' + JSON.stringify(audienceText) + ' — нічия між аудиторіями → відкинуто');
      return;
    }
    if (audience.index >= audienceValues.length) {
      fixes.push('прив\'язка ' + pairLabel + ' аудиторія ' + JSON.stringify(audienceText) + ' — з droppedAudiences, у формі її немає → відкинуто');
      return;
    }

    const pair = { task: taskValues[task.index], audience: audienceValues[audience.index] };
    const duplicate = resolved.some(function (p) { return p.task === pair.task && p.audience === pair.audience; });
    if (duplicate) {
      fixes.push('прив\'язка ' + pairLabel + ' дубль пари → відкинуто');
      return;
    }
    resolved.push(pair);
  });

  if (resolved.length === 0) {
    fixes.push(label + ' links: усі ' + rawLinks.length + ' пар відкинуто → null');
    return null;
  }
  return resolved;
}

// Нормалізація після моделі: усе, що можна порахувати, тримає код, а не
// промпт. "Рівно одна головна" — обчислення, не судження: тип ставиться
// за позицією, а порядок пріоритету лишається прочитаним моделлю. Кожне
// виправлення — окремий console.warn: це дані про те, як часто модель
// порушує правила промпту, не шум. docs — { page, brief }, тексти двох
// документів для перевірки дослівності джерел.
function normalizeParsed(parsed, docs) {
  const fixes = [];

  const audiences = [];
  const droppedAudiences = [];
  const rawAudiences = Array.isArray(parsed.audiences) ? parsed.audiences : [];
  if (!Array.isArray(parsed.audiences)) {
    fixes.push('audiences не масив → []');
  }
  rawAudiences.forEach(function (a) {
    const isObject = a !== null && typeof a === 'object';
    const value = asString(isObject ? a.value : a);
    if (value === '') { return; }
    if (audiences.length < MAX_AUDIENCES) {
      const type = audiences.length === 0 ? 'головна' : 'другорядна';
      const modelType = isObject ? a.type : undefined;
      if (modelType !== type) {
        fixes.push('audiences[' + audiences.length + '] тип ' + JSON.stringify(modelType) + ' → ' + JSON.stringify(type));
      }
      const source = normalizeSource(isObject ? a.source : undefined, value, 'audiences[' + audiences.length + ']', docs, true, fixes);
      audiences.push({ value: value, type: type, source: source });
    } else {
      fixes.push('audiences: ' + JSON.stringify(value) + ' понад ' + MAX_AUDIENCES + ' → droppedAudiences');
      droppedAudiences.push({ value: value });
    }
  });

  const rawDropped = Array.isArray(parsed.droppedAudiences) ? parsed.droppedAudiences : [];
  if (parsed.droppedAudiences !== undefined && !Array.isArray(parsed.droppedAudiences)) {
    fixes.push('droppedAudiences не масив → []');
  }
  rawDropped.forEach(function (a) {
    const value = asString(a !== null && typeof a === 'object' ? a.value : a);
    if (value === '') { return; }
    const duplicate = droppedAudiences.some(function (d) { return d.value === value; });
    if (!duplicate) { droppedAudiences.push({ value: value }); }
  });

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (!Array.isArray(parsed.tasks)) {
    fixes.push('tasks не масив → []');
  }
  // Top Tasks виводяться з ролей блоків — їх у документах дослівно немає
  // за визначенням, тож джерело завжди 'agent'; інша заява моделі — у лог
  const tasks = rawTasks
    .map(function (t) {
      const isObject = t !== null && typeof t === 'object';
      return { value: asString(isObject ? t.value : t), rawSource: isObject ? t.source : undefined };
    })
    .filter(function (t) { return t.value !== ''; })
    .map(function (t, index) {
      if (t.rawSource !== 'agent') {
        fixes.push('джерело tasks[' + index + '] ' + JSON.stringify(t.rawSource) + ' → "agent"');
      }
      return { value: t.value, source: 'agent' };
    });
  // не виправлення — до трьох не добиваємо, — але порушення правила 6,
  // тож у той самий лог
  if (tasks.length !== 3) {
    fixes.push('tasks: ' + tasks.length + ' замість 3 (не виправлено)');
  }

  const blocks = [];
  parsed.blocks.forEach(function (b, index) {
    const isObject = b !== null && typeof b === 'object';
    const name = asString(isObject ? b.name : b);
    if (name === '') {
      fixes.push('blocks[' + index + '] без назви → відкинуто');
      return;
    }
    const count = normalizeCount(isObject ? b.count : undefined);
    if (count.fix) {
      fixes.push('blocks[' + index + '] ' + JSON.stringify(name) + ' count: ' + count.fix);
    }
    const rawCountable = isObject ? b.countable : undefined;
    if (typeof rawCountable !== 'boolean') {
      fixes.push('blocks[' + index + '] ' + JSON.stringify(name) + ' countable ' + JSON.stringify(rawCountable) + ' → false');
    }
    const unit = asString(isObject ? b.unit : '');
    const rawSources = isObject && b.sources !== null && typeof b.sources === 'object' ? b.sources : {};
    const label = 'blocks[' + index + '] ' + JSON.stringify(name);
    blocks.push({
      name: name,
      unit: unit,
      count: count.value,
      // true лише коли модель сказала саме true — те саме значення за
      // замовчуванням, що в міграції app.html
      countable: rawCountable === true,
      // countable — завжди судження моделі, дослівно в описі його не буває:
      // джерело 'agent' без питання до моделі
      sources: {
        name: normalizeSource(rawSources.name, name, label + '.name', docs, true, fixes),
        unit: normalizeSource(rawSources.unit, unit, label + '.unit', docs, true, fixes),
        count: normalizeSource(rawSources.count, count.value, label + '.count', docs, false, fixes),
        countable: 'agent',
        // прив'язки — виведення, не цитата, тож завжди 'agent', як countable.
        // Клієнту це потрібно, щоб [] від розбору лишався питанням, поки
        // дизайнер його не підтвердить (isLinksPending в app.html)
        links: 'agent'
      },
      links: resolveLinks(isObject ? b.links : undefined, label, tasks, audiences, droppedAudiences, fixes)
    });
  });

  // Жодної пари на жодному блоці при наявних задачах — не структура без
  // прив'язок, а збій моделі. [] тут означало б «свідомо не обслуговує» й
  // сховало б збій — тож усі блоки стають null і видні в «Не вистачає»
  const anyPair = blocks.some(function (b) { return Array.isArray(b.links) && b.links.length > 0; });
  if (blocks.length > 0 && tasks.length > 0 && !anyPair) {
    fixes.push('links: жоден з ' + blocks.length + ' блоків не має прив\'язок — збій, не структура → усі null');
    blocks.forEach(function (b) { b.links = null; });
  }

  const rawTopSources = parsed.sources !== null && typeof parsed.sources === 'object' ? parsed.sources : {};
  const category = asString(parsed.category);
  const support = asString(parsed.support);
  const goal = asString(parsed.goal);

  return {
    result: {
      category: category,
      support: support,
      audiences: audiences,
      droppedAudiences: droppedAudiences,
      goal: goal,
      tasks: tasks,
      blocks: blocks,
      sources: {
        category: normalizeSource(rawTopSources.category, category, 'category', docs, true, fixes),
        support: normalizeSource(rawTopSources.support, support, 'support', docs, true, fixes),
        goal: normalizeSource(rawTopSources.goal, goal, 'goal', docs, true, fixes)
      }
    },
    fixes: fixes
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Метод не підтримується' });
    return;
  }

  const { brief, pageDescription } = req.body || {};

  // Опис сторінки обов'язковий: без нього немає блоків, тобто немає чого
  // перевіряти. Бриф — ні: без нього прогін бідніший, але можливий, і
  // порожні поля видно.
  if (typeof pageDescription !== 'string' || pageDescription.trim() === '') {
    console.error('[parse] нема обов’язкового поля', { pageDescription: typeof pageDescription === 'string' ? 'порожній' : typeof pageDescription, brief: !!brief });
    res.status(400).json({ error: 'Не вистачає поля: pageDescription' });
    return;
  }
  const briefText = typeof brief === 'string' ? brief.trim() : '';

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[parse] немає ключа на сервері');
    res.status(500).json({ error: 'Ключ не налаштований на сервері' });
    return;
  }

  // Документи — окремими секціями з межами, не зшиті в один текст: вони
  // різного рівня (бриф про організацію, опис про сторінку), і зшиті
  // дали б моделі однорідне полотно — коли бриф називає одну аудиторію,
  // а опис іншу, модель мусила б вгадувати, яка з них аудиторія сторінки.
  // Прикладів із реального матеріалу в промпті немає навмисно: інакше
  // перевірка на ньому показала б повторений приклад, а не зрозуміле правило.
  const prompt = `Ти розкладаєш два документи дизайнера в поля форми для аудиту структури односторінкового сайту.

Документи різного рівня, не зливай їх в один:
- БРИФ — про організацію й проєкт загалом, один на всі сторінки проєкту.
- ОПИС СТОРІНКИ — про одну конкретну сторінку: її блоки, їхні ролі, одиниці й кількість.

=== БРИФ (про організацію) ===
${briefText || '(бриф не надано)'}
=== КІНЕЦЬ БРИФУ ===

=== ОПИС СТОРІНКИ (про цю сторінку) ===
${pageDescription.trim()}
=== КІНЕЦЬ ОПИСУ СТОРІНКИ ===

Поля:
- category — категорія: тип сторінки плюс тип організації або продукту, одним рядком (правило 4)
- support — чим підкріплюється діяльність: що організація робить і чим це доводиться
- audiences — цільові аудиторії
- droppedAudiences — аудиторії, що не ввійшли в audiences
- goal — бізнес-ціль: що має статися після візиту
- tasks — Top Tasks
- blocks — блоки сторінки; для кожного: name — назва, unit — одиниця, count — кількість одиниць, countable — чи одиницю читають поштучно, links — які задачі й для яких аудиторій блок обслуговує (правило 12)
- sources, source — джерело кожного значення (правило 11): sources для category/support/goal, source у кожної аудиторії й задачі, sources для name/unit/count кожного блоку

Правила:

1. Порожнє замість припущеного. Якщо значення в документах немає — поле порожнє. Зокрема count: якщо кількості в описі не названо, count — порожній рядок. Не підставляй правдоподібного числа: воно стане фактом, від якого рахується поріг.

2. Якщо в описі сторінки є розділ «Відкриті питання» — читай його як авторитет: назване там лишається порожнім, хоч би яке правдоподібне значення можна вивести з решти тексту. Порожнім лишається тільки те поле, яке питання називає. Невідомий вміст одиниць (які саме значення, чиї імена, які зображення) — не те саме, що невідома кількість: якщо кількість у тексті названа, count лишається, навіть коли вміст — відкрите питання. І навпаки: якщо невідома саме кількість, count порожній, навіть коли деінде в тексті є правдоподібне число.

3. Діапазон («3-4 картки») → верхня межа: "4". Аудит помиляється в бік суворості.

4. Набір блоків — з опису сторінки. Підкріплення, аудиторія, бізнес-ціль — з брифу. Чого немає в описі — шукай у брифі. Немає ніде — порожнє. Якщо те саме поле є в обох документах і вони розходяться — виграє опис сторінки.
Категорія — тип сторінки плюс тип організації або продукту (тип, не назва), одним рядком, з уточненнями сфери діяльності й місця, якщо вони є в тексті. Тип сторінки — з опису сторінки; тип організації, сферу й місце, якщо опис їх не називає, — з брифу. Це доповнення з брифу стосується ТІЛЬКИ поля категорії. Для решти полів правило 4 діє, як написано вище, без змін.

5. audiences — максимум дві, у порядку пріоритету з брифу. Рівно одна має type "головна" — перша за пріоритетом; друга — "другорядна". Якщо аудиторій більше двох — в audiences дві перші за пріоритетом, решту поклади в droppedAudiences у тому ж порядку. Нічого не відкидай мовчки. Якщо аудиторій дві або менше, droppedAudiences — порожній масив.

6. tasks — рівно три Top Tasks, виведені з ролей блоків в описі сторінки. Формат кожної: "дієслово + об'єкт" (наприклад: "підтвердити легітимність організації").

7. Кнопки, CTA й точки дії не витягуй. Секцію без власного змісту, крім кнопок, блоком не роби. Якщо в секції є власний зміст (заголовок, текст, зображення) — вона блок, а кнопки в ній не згадуються.

8. unit — вільний текст: те, що повторюється в блоці, іменник в однині, коротко. Зі списку не обирай і до відомих слів не притискай.

9. countable — true, якщо одиницю читають поштучно (картка, пункт списку, посилання: у кожної свій зміст, який читають окремо); false, якщо блок сканують як одне поле (логотип, показник, абзац).

10. count — рядок із цифр. Числівник словом — теж число: «три» → "3".

11. Джерело кожного значення — чесно. "page" — значення стоїть в описі сторінки дослівно. "brief" — стоїть у брифі дослівно. "agent" — усе інше: складене з обох документів, переформульоване, узагальнене чи виведене. Top Tasks — завжди "agent". Кількість, названа в тексті числом чи словом, або верхня межа названого діапазону — джерело той документ, де вона названа. Для порожнього значення джерело — "". Якщо сумніваєшся — "agent".

12. links — для кожного блоку масив пар {task, audience}. task — рівно текст однієї із задач у tasks, audience — рівно текст однієї з аудиторій у audiences; не перефразовуй. Аудиторії з droppedAudiences у пари не став. Блок може обслуговувати кілька задач і кілька аудиторій — тоді кілька пар, по одній на кожну комбінацію, де блок справді дає відповідь. Блок може не обслуговувати жодної задачі — тоді links: [] (порожній масив — правильна відповідь, а не недогляд): типово шапка, футер, смуга партнерів, перше представлення. Прив'язка ставиться там, де блок дає відповідь на задачу, а не там, де тема згадана поруч.

Поверни ТІЛЬКИ JSON, без пояснень і без markdown-огорожі, у форматі:
{"category": "", "support": "", "goal": "", "sources": {"category": "page|brief|agent", "support": "page|brief|agent", "goal": "page|brief|agent"}, "audiences": [{"value": "", "type": "головна", "source": "page|brief|agent"}], "droppedAudiences": [{"value": ""}], "tasks": [{"value": "", "source": "agent"}], "blocks": [{"name": "", "unit": "", "count": "", "countable": true, "sources": {"name": "page|brief|agent", "unit": "page|brief|agent", "count": "page|brief|agent"}, "links": [{"task": "", "audience": ""}]}]}`;

  // ТИМЧАСОВО gemini-3.1-flash-lite: денна квота free tier на 3.8-flash
  // вичерпана (13.09.2026), а правку категорії треба було перевірити
  // одразу. РІШЕННЯ — gemini-3.8-flash: повернути, щойно квота дозволить.
  //
  // Чому 3.8-flash, а не flash-lite, як решта api/: парсер викликається
  // раз на сторінку, а на тому самому промпті й матеріалі Kolo flash-lite
  // позначала логотипи як поштучні (4/5), брала кнопки за одиницю блоку
  // (5/5) і псувала слова (2/5); 3.8-flash — 0/4 по всіх трьох. Це була
  // якість моделі, не формулювання — тому правил під ці випадки в промпті
  // немає. Pro не перевірена: на ключі немає квоти.
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
        console.error('[parse] 429 ліміт Gemini', errText.slice(0, 200));
      } else if (isOverloaded) {
        console.error('[parse] 503 Gemini перевантажений', errText.slice(0, 200));
      } else {
        console.error('[parse] Gemini відповів не-200', response.status, errText.slice(0, 200));
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
      console.error('[parse] порожня відповідь від моделі');
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
      console.error('[parse] JSON.parse rawText упав', rawText.slice(0, 200));
      res.status(502).json({ error: 'Не вдалось розпарсити відповідь моделі', details: String(parseErr) });
      return;
    }

    // blocks — єдине поле, без якого відповідь не має сенсу: форма вимагає
    // хоча б один блок. Порожній масив — легітимна відповідь моделі (опис
    // без блоків), не помилка сервера.
    // String() — бо JSON.stringify(undefined) повертає undefined, не рядок,
    // і .slice() на відсутньому полі кидав TypeError: замість 502 клієнт
    // отримував 500 «Помилка запиту» (BUGS.md, 2026-09-13)
    if (!parsed || !Array.isArray(parsed.blocks)) {
      console.error('[parse] blocks не масив', 'отримано:', String(JSON.stringify(parsed && parsed.blocks)).slice(0, 200));
      res.status(502).json({ error: 'Відповідь не містить blocks' });
      return;
    }

    const normalized = normalizeParsed(parsed, { page: pageDescription, brief: briefText });
    normalized.fixes.forEach(function (fix) {
      console.warn('[parse] нормалізація:', fix);
    });

    res.status(200).json(normalized.result);
  } catch (err) {
    res.status(500).json({ error: 'Помилка запиту', details: String(err) });
  }
}
