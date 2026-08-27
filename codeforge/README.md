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
2. **Live sandbox preview** — превью HTML/CSS/JS-проектов прямо в интерфейсе (iframe)
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
- Переменные окружения: `MISTRAL_API_KEY`, `MISTRAL_MODEL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

После деплоя сервер сам отдаёт и API (`/api/...`), и собранный фронтенд (всё остальные пути) с одного домена — CORS-настройки и синхронизация двух URL не нужны.

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
