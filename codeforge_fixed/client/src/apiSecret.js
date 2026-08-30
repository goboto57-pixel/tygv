// Глобально патчит window.fetch так, чтобы каждый запрос к нашему собственному
// /api/* нёс заголовок X-App-Secret. Сервер (см. server/index.js) сверяет его
// со своей переменной окружения APP_SHARED_SECRET и отклоняет запрос, если
// значения не совпадают (и если сам гейт включён на сервере).
//
// Секрет задаётся при сборке через переменную окружения Vite VITE_APP_SECRET
// (см. .env / .env.production). Если она не задана, патч ничего не делает —
// приложение продолжает работать как раньше (полезно для локальной разработки
// без секрета).
//
// ВАЖНО: это НЕ секрет в криптографическом смысле — он неизбежно попадает в
// собранный клиентский бандл и виден любому через DevTools. Смысл этой
// защиты — отсечь ботов и скрипты, которые сканируют и бьют по открытым API
// напрямую, не читая код страницы, а не остановить целенаправленную атаку.

const APP_SECRET = import.meta.env.VITE_APP_SECRET || "";

if (APP_SECRET && typeof window !== "undefined" && window.fetch) {
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    let url = typeof input === "string" ? input : input?.url;
    if (typeof url === "string" && url.includes("/api/")) {
      const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
      headers.set("X-App-Secret", APP_SECRET);
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  };
}
