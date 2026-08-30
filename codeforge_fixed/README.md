# CodeForge — агентный ИИ для кодинга

Веб-приложение уровня Claude Code / OpenCode, работающее поверх **Mistral Codestral**. Агент планирует задачу, показывает ход рассуждений, вызывает инструменты (чтение/запись/поиск по файлам) и возвращает готовые файлы проекта, а не просто фрагменты кода в чате.

## Стек

- **Клиент:** React 18 + Vite, Framer Motion, react-syntax-highlighter
- **Сервер:** Node.js + Express, SSE-стриминг агента
- **LLM:** Mistral Codestral (function calling / tool use)
- **Хранилище:** Cloudinary (файлы проекта, история чатов, снимки версий) — как raw-ассеты
- **Хостинг:** Render (два сервиса: static-сайт + web-сервис)

## Функционал

**Базовый (как у Claude Code / OpenCode):**
- Видимый **ход рассуждений** агента (сворачиваемый блок, стримится в реальном времени)
- **План перед выполнением** — агент обязан сначала предложить план шагов
- Полноценный **набор инструментов**: list_files, read_file, write_file, edit_file, delete_file, search_code, run_command, make_plan
- Возврат результата как **дерево файлов проекта** с вьювером и подсветкой синтаксиса, а не текстовые блоки кода
- Загрузка любых файлов (drag&drop или кнопка), текстовые файлы подключаются в контекст агента
- Плавные анимации, серьёзный тёмный дизайн, полная адаптация под мобильные устройства

**Дополнительно (7 фич сверху):**
1. **Version snapshots** — сохранение и откат состояния проекта на любом этапе работы агента
2. **Live sandbox preview** — превью HTML/CSS/JS-проектов прямо в интерфейсе (iframe); для проектов с package.json — реальный **WebContainer** (Node.js в браузере через WASM, движок StackBlitz): `npm install` + dev-сервер (Vite/React/итд) запускаются прямо в табе, без бэкенда
3. **Token/cost tracker** — счётчик использованных токенов и примерной стоимости в реальном времени
4. **Голосовой ввод задачи** — Web Speech API, кнопка микрофона в поле ввода
5. **Экспорт проекта в ZIP** — скачивание всех сгенерированных файлов одной кнопкой
6. **Быстрые шаблоны старта** — React / Node API / Python-скрипт / рефакторинг в один клик
7. **История чатов с облачным хранением** — все диалоги и файлы сохраняются в Cloudinary и доступны из сайдбара после перезахода

## Локальный запуск

### 1. Сервер

```bash
cd server
cp .env.example .env
# заполните MISTRAL_API_KEY, CLOUDINARY_*
npm install
npm run dev
```

Сервер поднимется на `http://localhost:10000`.

### 2. Клиент

```bash
cd client
cp .env.example .env
npm install
npm run dev
```

Клиент — на `http://localhost:5173`, запросы к `/api` проксируются на сервер через `vite.config.js`.

## Деплой (один сервис)

Проект развёртывается как **один Web Service** — Express-сервер сам собирает и раздаёт React-клиент, поэтому не нужны два отдельных сервиса, Blueprint или файл `render.yaml`.

Подходит для Render, Railway, Cyclic и любого другого хостинга, поддерживающего Node.js.

**Настройки сервиса:**
- Root directory: `server`
- Build command: `npm install && npm run build`
  (устанавливает зависимости сервера, затем устанавливает и собирает клиент в `client/dist`)
- Start command: `npm start`
- Переменные окружения: `MISTRAL_API_KEY`, `MISTRAL_MODEL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `VERCEL_TOKEN` (опционально — включает кнопку «Опубликовать»; если токен командный — также `VERCEL_TEAM_ID`)

После деплоя сервер сам отдаёт и API (`/api/...`), и собранный фронтенд (всё остальные пути) с одного домена — CORS-настройки и синхронизация двух URL не нужны.

## Публикация готового сайта (Vercel)

Кнопка «Опубликовать» (иконка ракеты) в TopBar отправляет текущее дерево файлов проекта напрямую (без ZIP) как статический деплой на Vercel — под аккаунтом, чей `VERCEL_TOKEN` задан на сервере. Пользователь не вводит собственных ключей.

- Требует `index.html` в корне проекта — если его нет, публикация вернёт понятную ошибку вместо пустого сайта.
- Один чат = один проект Vercel: имя проекта сохраняется в записи чата (поле `siteId`), повторная публикация обновляет тот же проект (URL не меняется между итерациями).
- Если `VERCEL_TOKEN` выпущен для Vercel-команды, а не личного аккаунта — обязательно задайте `VERCEL_TEAM_ID` (Team Settings → General), иначе Vercel будет отвечать `403 not authorized` на каждый запрос, несмотря на валидный токен.
- Ограничено 6 публикациями за 5 минут на чат/IP — защищает общий Vercel-аккаунт от исчерпания лимита API одним пользователем.
- Без `VERCEL_TOKEN` кнопка возвращает `503` с понятным сообщением, остальной функционал не затрагивается.
- Перед каждой публикацией автоматически создаётся снимок версии — если опубликованная версия окажется сломанной, откатиться можно из меню снимков.
- Значок ▾ рядом с кнопкой публикации открывает историю прошлых публикаций (до 20 записей) с QR-кодом текущего сайта и кнопкой «Снять с публикации» (удаляет проект на Vercel).
- Статус свежей публикации опрашивается через `GET /api/projects/deploy/:deployId/status`, пока Vercel не пометит её `READY` — кнопка показывает «публикуется…» вместо мгновенного «готово».
- Переменные `BUDGET_TOKEN_WARN`, `BUDGET_TOKEN_HARD`, `BUDGET_TIME_WARN_MS`, `BUDGET_TIME_HARD_MS` в `.env` позволяют настроить лимиты токенов/времени на один агентский прогон без правки кода.

**WebContainer и заголовки изоляции:** сервер выставляет `Cross-Origin-Embedder-Policy: credentialless` и `Cross-Origin-Opener-Policy: same-origin` на все ответы — это нужно превью на базе WebContainer (SharedArrayBuffer требует кросс-происхождённой изоляции страницы). Если стоит CDN/прокси перед сервисом (Cloudflare и т.п.), убедитесь, что эти заголовки не срезаются на пути до браузера. WebContainer работает только в Chromium-браузерах (Chrome/Edge) — в Safari/Firefox превью для npm-проектов покажет сообщение о неподдержке, а HTML/CSS/JS-проекты без package.json по-прежнему используют обычный `iframe.srcDoc`.

### Render (без Blueprint, один Web Service)
1. New → Web Service → выбрать репозиторий
2. Root Directory: `server`
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. Добавить переменные окружения выше
6. Create Web Service

### Railway / Cyclic
Аналогично: указать Root Directory `server`, Build Command `npm install && npm run build`, Start Command `npm start`, добавить те же переменные окружения.

## Получение ключей

- **Mistral API key:** https://console.mistral.ai/ → API Keys. Убедитесь, что доступна модель `codestral-latest`.
- **Cloudinary:** https://cloudinary.com/ → Dashboard → Cloud name / API Key / API Secret (Free tier достаточно для старта).

## Структура проекта

```
codeforge/
├── client/                 # React-фронтенд
│   └── src/
│       ├── components/     # UI-компоненты
│       ├── context/        # Глобальный стейт (чат, файлы, стрим)
│       └── styles/         # Дизайн-система (tokens.css) + app.css
└── server/                 # Express-бэкенд (раздаёт и API, и собранный клиент)
    ├── routes/              # chat (SSE), files (upload), projects (история/снимки/zip)
    └── services/            # mistralClient, cloudinaryService, agentLoop, toolDefinitions, projectFS
```

В продакшене `server/index.js` раздаёт статику из `client/dist` и отдаёт `index.html` для всех не-API маршрутов (SPA fallback), поэтому это один процесс на одном порту.
