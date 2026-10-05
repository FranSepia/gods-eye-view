/**
 * Build the Mexico surveillance-camera catalog from OpenStreetMap.
 *
 *   node scripts/build-mexico-cctv.mjs [--backend qlever|overpass]
 *                                      [--endpoint URL] [--out PATH]
 *                                      [--limit N] [--dry-run]
 *
 * Mexico publishes no camera VIDEO. The C5 of Mexico City operates on the
 * order of 100,000 cameras and none of them stream publicly; the city's open
 * data portal publishes only the C5/C2 command-centre addresses and per-colonia
 * counts, so there is no official per-camera coordinate either. What does exist
 * is what mappers have surveyed into OpenStreetMap as `man_made=surveillance`
 * — a few hundred cameras nationwide, most of them government-operated and
 * many carrying a real `camera:direction`.
 *
 * So this pack is POSE ONLY: position, facing, mount. It ships no upstream URL,
 * and the CCTV proxy answers each frame request with the Street View fallback
 * (what the camera actually looks at, when a Google key is configured) or the
 * synthetic placeholder. That is an honest ceiling, not a stopgap: adding a
 * `url` here would imply a feed that does not exist.
 *
 * Two backends because the data is the same but the reach is not. QLever is the
 * default: it answers global OSM queries without an account, and the repository
 * deliberately ships no public Overpass endpoint (`OVERPASS_UPSTREAMS` is empty
 * — "use only instances you run or pay for"). Pass `--backend overpass
 * --endpoint <url>` to build from an Overpass instance you control instead.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUT = 'config/cctv_sources.mexico.json';
const QLEVER_ENDPOINT = 'https://qlever.cs.uni-freiburg.de/api/osm-planet';
/** OSM relation for México (admin_level=2), verified by name before use. */
const MEXICO_RELATION = '114686';
const REQUEST_TIMEOUT_MS = 180_000;
const USER_AGENT = 'gods-eye-view-mexico-cctv-build/1.0';

/**
 * Metro anchors: the city label a camera inherits, and the ground-elevation
 * prior it is served with. Elevation is not cosmetic here — the Valle de
 * México sits above 2,200 m, and on a keyless stack (no terrain tileset) the
 * client's ground snap never fires, so this prior is the only height the
 * camera gets. Placing a Mexico City camera at sea level would bury it.
 * Mirrors the TxDOT pack's per-district elevation table.
 * @type {Array<{city:string, cityId:string, lat:number, lon:number, elevationM:number}>}
 */
const METRO_ANCHORS = [
  // prettier-ignore
  { city: 'Ciudad de México', cityId: 'cdmx', lat: 19.4326, lon: -99.1332, elevationM: 2240 },
  // prettier-ignore
  { city: 'Ecatepec', cityId: 'ecatepec', lat: 19.6097, lon: -99.0600, elevationM: 2250 },
  // prettier-ignore
  { city: 'Nezahualcóyotl', cityId: 'nezahualcoyotl', lat: 19.4003, lon: -98.9876, elevationM: 2230 },
  // prettier-ignore
  { city: 'Naucalpan', cityId: 'naucalpan', lat: 19.4785, lon: -99.2396, elevationM: 2300 },
  // prettier-ignore
  { city: 'Toluca', cityId: 'toluca', lat: 19.2826, lon: -99.6557, elevationM: 2667 },
  // prettier-ignore
  { city: 'Cuernavaca', cityId: 'cuernavaca', lat: 18.9242, lon: -99.2216, elevationM: 1510 },
  // prettier-ignore
  { city: 'Pachuca', cityId: 'pachuca', lat: 20.1011, lon: -98.7591, elevationM: 2400 },
  // prettier-ignore
  { city: 'Puebla', cityId: 'puebla', lat: 19.0414, lon: -98.2063, elevationM: 2135 },
  // prettier-ignore
  { city: 'Ciudad Juárez', cityId: 'juarez', lat: 31.6904, lon: -106.4245, elevationM: 1140 },
  // prettier-ignore
  { city: 'Guadalajara', cityId: 'guadalajara', lat: 20.6597, lon: -103.3496, elevationM: 1566 },
  // prettier-ignore
  { city: 'Zapopan', cityId: 'zapopan', lat: 20.7236, lon: -103.3848, elevationM: 1570 },
  // prettier-ignore
  { city: 'Monterrey', cityId: 'monterrey', lat: 25.6866, lon: -100.3161, elevationM: 540 },
  // prettier-ignore
  { city: 'Querétaro', cityId: 'queretaro', lat: 20.5888, lon: -100.3899, elevationM: 1820 },
  // prettier-ignore
  { city: 'Aguascalientes', cityId: 'aguascalientes', lat: 21.8853, lon: -102.2916, elevationM: 1880 },
  // prettier-ignore
  { city: 'Durango', cityId: 'durango', lat: 24.0277, lon: -104.6532, elevationM: 1880 },
  // prettier-ignore
  { city: 'Chihuahua', cityId: 'chihuahua', lat: 28.6330, lon: -106.0691, elevationM: 1440 },
  // prettier-ignore
  { city: 'Hermosillo', cityId: 'hermosillo', lat: 29.0729, lon: -110.9559, elevationM: 210 },
  // prettier-ignore
  { city: 'Tijuana', cityId: 'tijuana', lat: 32.5149, lon: -117.0382, elevationM: 20 },
  // prettier-ignore
  { city: 'Morelia', cityId: 'morelia', lat: 19.7008, lon: -101.1844, elevationM: 1920 },
  // prettier-ignore
  { city: 'León', cityId: 'leon', lat: 21.1219, lon: -101.6833, elevationM: 1815 },
  // prettier-ignore
  { city: 'San Luis Potosí', cityId: 'slp', lat: 22.1565, lon: -100.9855, elevationM: 1860 },
  // prettier-ignore
  { city: 'Veracruz', cityId: 'veracruz', lat: 19.1738, lon: -96.1342, elevationM: 10 },
  // prettier-ignore
  { city: 'Mérida', cityId: 'merida', lat: 20.9674, lon: -89.5926, elevationM: 10 },
  // prettier-ignore
  { city: 'Cancún', cityId: 'cancun', lat: 21.1619, lon: -86.8515, elevationM: 10 },
  // prettier-ignore
  { city: 'Oaxaca', cityId: 'oaxaca', lat: 17.0732, lon: -96.7266, elevationM: 1555 },
  // prettier-ignore
  { city: 'Orizaba', cityId: 'orizaba', lat: 18.8512, lon: -97.0999, elevationM: 1230 },
  // prettier-ignore
  { city: 'Acapulco', cityId: 'acapulco', lat: 16.8531, lon: -99.8237, elevationM: 5 },
  // prettier-ignore
  { city: 'Culiacán', cityId: 'culiacan', lat: 24.8091, lon: -107.3940, elevationM: 55 },
  // prettier-ignore
  { city: 'Torreón', cityId: 'torreon', lat: 25.5428, lon: -103.4068, elevationM: 1120 },
  // prettier-ignore
  { city: 'Tuxtla Gutiérrez', cityId: 'tuxtla', lat: 16.7531, lon: -93.1150, elevationM: 530 },
];
/** Beyond this, a camera is rural: it keeps a state-less label and a mean prior. */
const ANCHOR_MAX_KM = 70;
/** Mexico's mean inhabited elevation, for cameras outside every anchor radius. */
const FALLBACK_ELEVATION_M = 1200;

/**
 * Mount-height priors in metres by `camera:mount`. The tag is the only mount
 * signal OSM carries for most of these nodes, and the monitor plane needs a
 * height to stand on.
 */
const MOUNT_HEIGHT_M = Object.freeze({
  pole: 5.5,
  post: 5.5,
  street_lamp: 7,
  mast: 10,
  tower: 14,
  wall: 4,
  building: 6,
  roof: 8,
  ceiling: 3,
  door: 2.5,
  window: 3.5,
  tree: 5,
});
const DEFAULT_MOUNT_HEIGHT_M = 5;

/** `surveillance:type` values that are not cameras and must not be served. */
const NON_CAMERA_TYPES = new Set(['guard', 'gunshot_detector', 'microphone']);

/** Pose priors. OSM records no optics, and every consumer needs a frustum. */
const DEFAULT_PITCH_DEG = -20;
const DEFAULT_FOV_DEG = 60;
const DEFAULT_RANGE_M = 120;

const LICENSE =
  'Camera positions from OpenStreetMap, © OpenStreetMap contributors (ODbL 1.0). Pose only — no public video feed exists for these cameras.';

// ---------------------------------------------------------------------------
// Geometry and tag helpers
// ---------------------------------------------------------------------------

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse a WKT `POINT(lon lat)` literal into {lat, lon}. */
export function parseWktPoint(value) {
  const match = String(value || '').match(
    /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i,
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Normalize an OSM direction tag to a compass bearing.
 *
 * The tag is messy in practice: negatives (`-90`), multi-value lists
 * (`20;180`, a camera surveyed as covering two arcs), cardinal words (`NW`),
 * and units (`120°`). The first value wins — a single served pose cannot
 * express two arcs — and the result is wrapped into [0, 360).
 *
 * @param {string} value Raw tag value.
 * @returns {number} Bearing in degrees, or NaN when unreadable.
 */
export function normalizeDirection(value) {
  const first = String(value ?? '')
    .split(';')[0]
    .trim();
  if (!first) return NaN;

  const CARDINALS = {
    n: 0,
    nne: 22.5,
    ne: 45,
    ene: 67.5,
    e: 90,
    ese: 112.5,
    se: 135,
    sse: 157.5,
    s: 180,
    ssw: 202.5,
    sw: 225,
    wsw: 247.5,
    w: 270,
    wnw: 292.5,
    nw: 315,
    nnw: 337.5,
  };
  const word = first.toLowerCase().replace(/[^a-z]/g, '');
  if (word && Object.hasOwn(CARDINALS, word)) return CARDINALS[word];

  // Units and stray symbols are stripped ("120°"), but prose is not a bearing:
  // without this guard `Number('')` is 0, and a camera tagged "towards the
  // plaza" would be served facing due north at HIGH confidence — a facing the
  // survey never stated.
  const digits = first.replace(/[^\d.+-]/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(digits)) return NaN;
  const numeric = Number(digits);
  if (!Number.isFinite(numeric)) return NaN;
  return ((numeric % 360) + 360) % 360;
}

/** Nearest metro anchor within ANCHOR_MAX_KM, else null. */
export function nearestAnchor(lat, lon, anchors = METRO_ANCHORS) {
  let best = null;
  for (const anchor of anchors) {
    const km = haversineKm(lat, lon, anchor.lat, anchor.lon);
    if (km <= ANCHOR_MAX_KM && (!best || km < best.km)) best = { anchor, km };
  }
  return best?.anchor ?? null;
}

/**
 * Human label for one camera.
 *
 * OSM almost never names these nodes, so the label is assembled from whatever
 * locates the camera: its own name, then the street or colonia it is addressed
 * to, then the metro. An operator prefix carries who runs it. When nothing but
 * the metro is known, the OSM id's last four digits are appended — otherwise
 * a hundred Mexico City pins would all read "Cámara — Ciudad de México" and
 * the panel list would be unnavigable.
 *
 * @returns {string} Display name.
 */
export function cameraLabel({ name, operator, street, suburb, city, osmId }) {
  const clean = (text) => String(text || '').trim();
  if (clean(name)) return clean(name);

  const who = clean(operator);
  const where = clean(street) || clean(suburb);
  if (who && where) return `${who} — ${where}`;
  if (where) return `Cámara — ${where}`;

  const place = clean(city) || 'México';
  const ref = clean(osmId).slice(-4);
  const base = who ? `${who} — ${place}` : `Cámara — ${place}`;
  return ref ? `${base} ·${ref}` : base;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** SPARQL for the Mexican surveillance nodes, flat (no admin join). */
function qleverQuery(limit) {
  // The admin-area join is deliberately absent: osm2rdf relates a node to
  // EVERY containing boundary, so an OPTIONAL over admin areas multiplies each
  // camera into one row per enclosing polygon. City labels come from the
  // anchor table instead, which also keeps the served vocabulary fixed.
  return `
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT ?s ?wkt ?name ?operator ?stype ?zone ?direction ?cameraDirection ?street ?suburb ?mount ?cameraType WHERE {
  ?s osmkey:man_made "surveillance" .
  ?s ogc:sfIntersects osmrel:${MEXICO_RELATION} .
  ?s geo:hasGeometry/geo:asWKT ?wkt .
  OPTIONAL { ?s osmkey:name ?name }
  OPTIONAL { ?s osmkey:operator ?operator }
  OPTIONAL { ?s osmkey:surveillance ?zone }
  OPTIONAL { ?s osmkey:direction ?direction }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:surveillance:type> ?stype }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:camera:direction> ?cameraDirection }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:camera:mount> ?mount }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:camera:type> ?cameraType }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:addr:street> ?street }
  OPTIONAL { ?s <https://www.openstreetmap.org/wiki/Key:addr:suburb> ?suburb }
}${limit ? `\nLIMIT ${limit}` : ''}`;
}

/** Confirm the relation really is México before a build trusts it as the filter. */
async function assertMexicoRelation(endpoint) {
  const query = `
PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
SELECT ?name ?level WHERE {
  osmrel:${MEXICO_RELATION} osmkey:name ?name .
  osmrel:${MEXICO_RELATION} osmkey:admin_level ?level .
} LIMIT 1`;
  const rows = await sparql(endpoint, query);
  const name = rows[0]?.name?.value;
  const level = rows[0]?.level?.value;
  if (name !== 'México' || level !== '2') {
    throw new Error(
      `relation ${MEXICO_RELATION} is "${name}" (admin_level ${level}), not México — refusing to build`,
    );
  }
}

/** Run a SPARQL query and return the raw bindings. */
async function sparql(endpoint, query) {
  const resp = await fetch(`${endpoint}?${new URLSearchParams({ query })}`, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`SPARQL HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  if (json.exception) {
    throw new Error(`SPARQL error: ${String(json.exception).slice(0, 300)}`);
  }
  return json.results?.bindings ?? [];
}

/** Fetch rows from QLever and flatten them to plain tag records. */
async function fetchFromQlever({ endpoint, limit }) {
  await assertMexicoRelation(endpoint);
  const bindings = await sparql(endpoint, qleverQuery(limit));
  return bindings.map((row) => {
    const subject = row.s?.value || '';
    const match = subject.match(/\/(node|way|relation)\/(\d+)$/);
    return {
      osmType: match?.[1] || 'node',
      osmId: match?.[2] || '',
      wkt: row.wkt?.value || '',
      tags: {
        name: row.name?.value,
        operator: row.operator?.value,
        'surveillance:type': row.stype?.value,
        surveillance: row.zone?.value,
        direction: row.direction?.value,
        'camera:direction': row.cameraDirection?.value,
        'camera:mount': row.mount?.value,
        'camera:type': row.cameraType?.value,
        'addr:street': row.street?.value,
        'addr:suburb': row.suburb?.value,
      },
    };
  });
}

/** Overpass QL for the same set, for operators running their own instance. */
async function fetchFromOverpass({ endpoint, limit }) {
  if (!endpoint) {
    throw new Error(
      '--backend overpass requires --endpoint <url> (this repository ships no public Overpass default)',
    );
  }
  const query = `[out:json][timeout:600];
area["name"="México"]["admin_level"="2"]->.mx;
(
  node["man_made"="surveillance"](area.mx);
  way["man_made"="surveillance"](area.mx);
);
out center tags ${limit ? limit : ''};`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Overpass HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  return (json.elements ?? []).map((element) => {
    // `out center` puts a way's representative point on `center`; a node
    // carries lat/lon directly.
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    return {
      osmType: element.type || 'node',
      osmId: String(element.id ?? ''),
      wkt: Number.isFinite(lat) && Number.isFinite(lon)
        ? `POINT(${lon} ${lat})`
        : '',
      tags: element.tags ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Turn one raw OSM record into a served CCTV source, or null when it is not a
 * usable camera.
 *
 * @param {{osmType:string, osmId:string, wkt:string, tags:Record<string,string|undefined>}} raw
 * @returns {object|null}
 */
export function toCctvSource(raw) {
  if (!raw?.osmId) return null;
  const point = parseWktPoint(raw.wkt);
  if (!point) return null;
  const { lat, lon } = point;
  // Null island and swapped-axis records are the two failure modes that
  // survive a successful parse.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;

  const tags = raw.tags || {};
  const surveillanceType = String(tags['surveillance:type'] || '')
    .toLowerCase()
    .trim();
  // A guard post or an acoustic sensor is tagged man_made=surveillance too.
  // Serving those as cameras would put a frustum on a security booth.
  if (NON_CAMERA_TYPES.has(surveillanceType)) return null;
  if (String(tags.surveillance || '').toLowerCase() === 'indoor') return null;

  const anchor = nearestAnchor(lat, lon);
  const rawHeading =
    tags['camera:direction'] !== undefined
      ? tags['camera:direction']
      : tags.direction;
  const heading = normalizeDirection(rawHeading);
  const hasHeading = Number.isFinite(heading);

  const mount = String(tags['camera:mount'] || '')
    .toLowerCase()
    .trim();

  const operator = String(tags.operator || '').trim();

  return {
    id: `mx-osm-${raw.osmType}-${raw.osmId}`,
    name: cameraLabel({
      name: tags.name,
      operator,
      street: tags['addr:street'],
      suburb: tags['addr:suburb'],
      city: anchor?.city,
      osmId: raw.osmId,
    }),
    city: anchor?.city || 'México',
    cityId: anchor?.cityId || 'mexico',
    provider: 'OpenStreetMap (man_made=surveillance)',
    lat: Number(lat.toFixed(7)),
    lon: Number(lon.toFixed(7)),
    // No heading in OSM means no heading. A deterministic placeholder is
    // supplied by the server loader (fallbackHeadingFromId) rather than
    // invented here, so the catalog file never states a facing it does not
    // know; `headingConfidence` is what the CAL badge reads.
    headingDeg: hasHeading ? Number(heading.toFixed(1)) : undefined,
    headingConfidence: hasHeading ? 'high' : 'low',
    pitchDeg: DEFAULT_PITCH_DEG,
    fovDeg: DEFAULT_FOV_DEG,
    rangeM: DEFAULT_RANGE_M,
    mountHeightM: MOUNT_HEIGHT_M[mount] ?? DEFAULT_MOUNT_HEIGHT_M,
    groundElevationM: anchor?.elevationM ?? FALLBACK_ELEVATION_M,
    feedType: 'image',
    // Intentionally no `url`/`snapshotUrl`: these cameras have no public feed.
    sourceKind: 'osm-mx-surveillance',
    license: LICENSE,
    // The operator rides on `credit` because that is the one per-camera
    // attribution field the served catalog preserves — normalizeSourceItem
    // projects a fixed field set, so any bespoke key here would be dropped
    // silently on its way to the client.
    credit: operator || undefined,
  };
}

/** Drop undefined fields so the committed JSON stays minimal and diff-stable. */
function compact(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    backend: 'qlever',
    endpoint: '',
    out: DEFAULT_OUT,
    limit: 0,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--backend') {
      options.backend = next();
      if (!['qlever', 'overpass'].includes(options.backend)) {
        throw new Error('--backend must be qlever or overpass');
      }
    } else if (arg === '--endpoint') options.endpoint = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--limit') {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--limit requires a non-negative integer');
      }
      options.limit = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const endpoint =
    options.endpoint ||
    (options.backend === 'qlever' ? QLEVER_ENDPOINT : '');

  console.log(`[mx-cctv] backend=${options.backend} endpoint=${endpoint}`);
  const raw =
    options.backend === 'qlever'
      ? await fetchFromQlever({ endpoint, limit: options.limit })
      : await fetchFromOverpass({ endpoint, limit: options.limit });
  console.log(`[mx-cctv] OSM records: ${raw.length}`);

  const seen = new Set();
  const sources = [];
  let skipped = 0;
  for (const record of raw) {
    const source = toCctvSource(record);
    if (!source) {
      skipped++;
      continue;
    }
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    sources.push(compact(source));
  }
  // Sorted so a rebuild produces a reviewable diff rather than a reshuffle.
  sources.sort((a, b) => a.id.localeCompare(b.id));

  // Some mappers reuse one `name` across a whole installation ("CV C5i" on
  // every Pachuca pole). Those share a panel row label, so collisions get the
  // id suffix the generic labels already carry. Done after the sort so the
  // suffix assignment is itself deterministic.
  const nameCounts = sources.reduce((acc, source) => {
    acc.set(source.name, (acc.get(source.name) || 0) + 1);
    return acc;
  }, new Map());
  const takenNames = new Set();
  for (const source of sources) {
    if (nameCounts.get(source.name) > 1 && !/·\d{4}$/.test(source.name)) {
      source.name = `${source.name} ·${source.id.slice(-4)}`;
    }
    // Two ids can still end in the same four digits, so the suffix is widened
    // until the label is actually unique.
    let label = source.name;
    for (let n = 2; takenNames.has(label); n++) label = `${source.name} (${n})`;
    source.name = label;
    takenNames.add(label);
  }

  const withHeading = sources.filter(
    (source) => source.headingConfidence === 'high',
  ).length;
  const byCity = sources.reduce((acc, source) => {
    acc[source.city] = (acc[source.city] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `[mx-cctv] cameras: ${sources.length} (skipped ${skipped} non-camera/unplaceable)`,
  );
  console.log(
    `[mx-cctv] surveyed facing: ${withHeading} of ${sources.length}`,
  );
  console.log(
    '[mx-cctv] by city: ' +
      Object.entries(byCity)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([city, count]) => `${city} ${count}`)
        .join(', '),
  );

  if (options.dryRun) {
    console.log('[mx-cctv] --dry-run: nothing written');
    return;
  }
  if (!sources.length) {
    throw new Error('refusing to write an empty catalog');
  }
  const outPath = path.resolve(ROOT, options.out);
  await writeFile(outPath, `${JSON.stringify(sources, null, 2)}\n`, 'utf8');
  console.log(`[mx-cctv] wrote ${outPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[mx-cctv] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
