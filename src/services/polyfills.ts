/**
 * pdf.js 6 calls Map/WeakMap `getOrInsert` / `getOrInsertComputed` (the TC39
 * "upsert" proposal). Browsers and Electron builds older than that proposal
 * shipping throw "getOrInsertComputed is not a function" the moment a page
 * renders, so install spec-compatible fallbacks before pdf.js runs. Imported
 * first by the app entry, the pdf.js worker entry and every worker that uses
 * pdf.js code.
 */

type Upsertable<K, V> = {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
};

function install(proto: object) {
  if (!('getOrInsert' in proto)) {
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value: function <K, V>(this: Upsertable<K, V>, key: K, value: V): V {
        if (this.has(key)) return this.get(key) as V;
        this.set(key, value);
        return value;
      },
    });
  }
  if (!('getOrInsertComputed' in proto)) {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function <K, V>(this: Upsertable<K, V>, key: K, compute: (key: K) => V): V {
        if (this.has(key)) return this.get(key) as V;
        const value = compute(key);
        this.set(key, value);
        return value;
      },
    });
  }
}

install(Map.prototype);
install(WeakMap.prototype);

export {};
