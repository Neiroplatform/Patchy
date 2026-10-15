const responseCacheCommits = new WeakMap();

export function responseCacheCommit(response) {
  return responseCacheCommits.get(response) || Promise.resolve();
}

export async function evictSameOriginCachedResponse(scope = globalThis, cacheName, input) {
  if (!cacheName || !scope.caches || !scope.location?.href) return false;
  const target = new URL(input, scope.location.href);
  if (target.origin !== new URL(scope.location.href).origin)
    throw Object.assign(new TypeError("Remote inference cache eviction blocked"),
      { code: "REMOTE_FETCH_BLOCKED" });
  return (await scope.caches.open(cacheName)).delete(target.href);
}

export function installSameOriginFetch(scope = globalThis, { cacheName = null } = {}) {
  if (typeof scope.fetch !== "function" || !scope.location?.href) {
    throw new Error("A Worker fetch implementation and location are required");
  }
  const upstream = scope.fetch.bind(scope);
  const origin = new URL(scope.location.href).origin;
  const telemetryUrl = "https://odml.pa.googleapis.com/v1/log";
  scope.fetch = async (input, init) => {
    const value = typeof input === "string" || input instanceof URL ? input : input?.url;
    const target = new URL(value, scope.location.href);
    if (target.origin !== origin) {
      if (target.href === telemetryUrl) {
        return new Response("", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      throw Object.assign(new TypeError("Remote inference fetch blocked"),
        { code: "REMOTE_FETCH_BLOCKED" });
    }
    const cache = cacheName && scope.caches ? await scope.caches.open(cacheName) : null;
    const bypassCache = init?.cache === "reload" || init?.cache === "no-store";
    const cached = bypassCache ? null : await cache?.match(target.href);
    if (cached) return cached;
    const response = await upstream(input, init);
    if (cache && init?.cache !== "no-store" && response.ok &&
        (!init?.method || String(init.method).toUpperCase() === "GET")) {
      const commit = cache.put(target.href, response.clone()).catch(() => undefined);
      responseCacheCommits.set(response, commit);
    }
    return response;
  };
  return () => { scope.fetch = upstream; };
}
