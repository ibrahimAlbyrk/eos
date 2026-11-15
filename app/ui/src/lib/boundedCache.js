// A Map that forgets its oldest entries (insertion order) past `maxEntries`
// entries or `maxChars` of `sizeOf(key, value)` in total — so a few huge
// entries cannot hold more memory than many small ones. The newest entry is
// always kept.
export function boundedCache({ maxEntries, maxChars, sizeOf }) {
  const map = new Map();
  let chars = 0;
  return {
    has: (key) => map.has(key),
    get: (key) => map.get(key),
    set(key, value) {
      if (map.has(key)) {
        chars -= sizeOf(key, map.get(key));
        map.delete(key);
      }
      map.set(key, value);
      chars += sizeOf(key, value);
      while (map.size > 1 && (map.size > maxEntries || chars > maxChars)) {
        const [oldKey, oldValue] = map.entries().next().value;
        map.delete(oldKey);
        chars -= sizeOf(oldKey, oldValue);
      }
    },
    get size() { return map.size; },
    get chars() { return chars; },
  };
}
