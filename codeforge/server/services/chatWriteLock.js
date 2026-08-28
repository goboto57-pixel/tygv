// Serializes read-modify-write operations for a chat inside one server process.
// Cloudinary stores JSON as whole documents, so concurrent PATCHes can otherwise
// overwrite fields written by the other request.
const locks = new Map();

export async function withChatWriteLock(chatId, fn) {
  const previous = locks.get(chatId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(chatId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(chatId) === current) locks.delete(chatId);
  }
}
