const responseCacheCommits = new WeakMap();

export function responseCacheCommit(response) {
  return responseCacheCommits.get(response) || Promise.resolve();
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
    const cached = await cache?.match(target.href);
    if (cached) return cached;
    const response = await upstream(input, init);
    if (cache && response.ok && (!init?.method || String(init.method).toUpperCase() === "GET")) {
      const commit = cache.put(target.href, response.clone()).catch(() => undefined);
      responseCacheCommits.set(response, commit);
    }
    return response;
  };
  return () => { scope.fetch = upstream; };
}
