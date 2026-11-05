'use strict';
// Place search, reverse geocoding and routing, proxied through the server so that:
//  - requests carry a proper User-Agent/contact, as OpenStreetMap services require;
//  - results are cached (fewer requests, faster repeat searches);
//  - the app can switch providers later without an app update.
// Search: Nominatim first (worldwide, no area restriction), Photon as fallback.
// Routes: OSRM; if unreachable, a straight-line estimate (marked approx).

const cache = new Map();
const MAX_CACHE = 2000;
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return fn().then(v => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value: v });
    return v;
  });
}

function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function createGeo(cfg, log) {
  const UA = `SafeShe-Rides/1.0 (${cfg.contactEmail || 'admin@safeshe.local'})`;
  let lastNominatim = 0; // Nominatim policy: max 1 request per second
  async function getJson(url, ms = 8000) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function nominatim(path) {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
    lastNominatim = Date.now();
    return getJson(`${cfg.nominatimUrl}${path}`);
  }

  function label(parts) { return parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '); }

  async function search(q, near) {
    q = String(q || '').trim().slice(0, 200);
    if (q.length < 2) return [];
    const key = `s|${q.toLowerCase()}|${near ? near.lat.toFixed(1) + ',' + near.lng.toFixed(1) : ''}`;
    return cached(key, 24 * 3600_000, async () => {
      let out = [];
      try {
        // Worldwide search; a viewbox only *prefers* nearby results (bounded=0), it does not restrict them.
        let p = `/search?format=jsonv2&addressdetails=1&limit=10&q=${encodeURIComponent(q)}`;
        if (near) { const d = 0.5; p += `&viewbox=${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}&bounded=0`; }
        const rs = await nominatim(p);
        out = rs.map(r => ({ name: r.name || r.display_name.split(',')[0], address: r.display_name, lat: +r.lat, lng: +r.lon }));
      } catch (e) { log(`[geo] nominatim search failed: ${e.message}`); }
      if (!out.length) {
        try {
          let p = `${cfg.photonUrl}/api/?limit=10&q=${encodeURIComponent(q)}`;
          if (near) p += `&lat=${near.lat}&lon=${near.lng}`;
          const fc = await getJson(p);
          out = (fc.features || []).map(f => {
            const pr = f.properties || {};
            return { name: pr.name || pr.street || q, address: label([pr.name, pr.street, pr.district, pr.city, pr.state, pr.country]), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
          });
        } catch (e) { log(`[geo] photon search failed: ${e.message}`); throw Object.assign(new Error('Place search is unavailable right now. Choose the destination on the map.'), { status: 503 }); }
      }
      if (near) out.forEach(o => { o.distanceKm = +haversineKm(near, o).toFixed(1); });
      return out;
    });
  }

  async function reverse(lat, lng) {
    const key = `r|${lat.toFixed(4)},${lng.toFixed(4)}`;
    return cached(key, 7 * 24 * 3600_000, async () => {
      try {
        const r = await nominatim(`/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`);
        return { name: r.display_name ? r.display_name.split(',').slice(0, 2).join(',').trim() : null, address: r.display_name || null };
      } catch (e) {
        return { name: null, address: null };
      }
    });
  }

  async function route(a, b) {
    const key = `rt|${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    return cached(key, 3600_000, async () => {
      try {
        const r = await getJson(`${cfg.osrmUrl}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`, 8000);
        const rt = r.routes && r.routes[0];
        if (!rt) throw new Error('no route');
        return { km: rt.distance / 1000, min: rt.duration / 60, points: rt.geometry.coordinates.map(c => [c[1], c[0]]), approx: false };
      } catch (e) {
        const km = haversineKm(a, b) * 1.35;               // typical road/straight-line ratio in cities
        return { km, min: km / 20 * 60 + 3, points: [[a.lat, a.lng], [b.lat, b.lng]], approx: true };
      }
    });
  }

  return { search, reverse, route, haversineKm };
}

module.exports = { createGeo, haversineKm };
