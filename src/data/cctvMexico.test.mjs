import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMexicoSourcesFromCatalog } from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_MEXICO_MAX_SOURCES,
  DEFAULT_MEXICO_SOURCE_FILE,
  DEFAULT_CCTV_MAX_SOURCES,
  CCTV_MAX_SOURCES_CEILING,
} from '../../server/providers/cctv/constants.js';
import { isLikelyMexicoCoordinate } from '../../server/providers/cctv/normalize.js';
import {
  normalizeDirection,
  cameraLabel,
  toCctvSource,
  parseWktPoint,
} from '../../scripts/build-mexico-cctv.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Run the loader with a scoped env, always restoring what was there. */
const withEnv = (patch, run) => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, patch);
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

/** Write a throwaway catalog and hand back its path. */
const writeCatalog = (t, rows) => {
  const file = path.join(
    fs.mkdtempSync(path.join(ROOT, 'node_modules', '.mx-cctv-test-')),
    'catalog.json',
  );
  fs.writeFileSync(file, JSON.stringify(rows), 'utf8');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
};

test('the shipped catalog loads, lands in Mexico, and serves no feed URL', () => {
  const sources = loadMexicoSourcesFromCatalog({ sourceRoot: ROOT });
  assert.ok(sources.length > 100, `expected a populated pack, got ${sources.length}`);

  for (const camera of sources) {
    assert.ok(
      isLikelyMexicoCoordinate(camera.lat, camera.lon),
      `${camera.id} is outside Mexico (${camera.lat}, ${camera.lon})`,
    );
    // The point of this pack: positions without a stream. A URL here would
    // promise video that no Mexican authority publishes.
    assert.equal(camera.url, '', `${camera.id} must not carry an upstream URL`);
    assert.equal(camera.snapshotUrl, '');
    assert.equal(camera.sourceKind, 'osm-mx-surveillance');
    assert.ok(Number.isFinite(camera.headingDeg));
    assert.ok(camera.headingDeg >= 0 && camera.headingDeg < 360);
    // The Valle de Mexico sits above 2,200 m; a sea-level prior would bury
    // every camera in the capital.
    assert.ok(
      camera.groundElevationM > 0,
      `${camera.id} needs a ground-elevation prior`,
    );
  }

  const capital = sources.filter((camera) => camera.cityId === 'cdmx');
  assert.ok(capital.length > 50, 'the capital is the reason the pack exists');
  for (const camera of capital) assert.equal(camera.groundElevationM, 2240);
});

test('the shipped catalog file is the one the constant names', () => {
  assert.ok(fs.existsSync(path.join(ROOT, DEFAULT_MEXICO_SOURCE_FILE)));
});

test('a surveyed facing is kept; an unsurveyed one gets a flagged placeholder', (t) => {
  const file = writeCatalog(t, [
    { id: 'mx-surveyed', lat: 19.4326, lon: -99.1332, headingDeg: 215 },
    { id: 'mx-unknown', lat: 19.4327, lon: -99.1333 },
    // Negative and over-wound values must still land in [0, 360).
    { id: 'mx-negative', lat: 19.4328, lon: -99.1334, headingDeg: -90 },
    { id: 'mx-overwound', lat: 19.4329, lon: -99.1335, headingDeg: 470 },
  ]);

  const byId = new Map(
    withEnv({ CCTV_MEXICO_SOURCES_FILE: file }, () =>
      loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
    ).map((camera) => [camera.id, camera]),
  );

  assert.equal(byId.get('mx-surveyed').headingDeg, 215);
  assert.equal(byId.get('mx-surveyed').headingConfidence, 'high');
  assert.equal(byId.get('mx-negative').headingDeg, 270);
  assert.equal(byId.get('mx-overwound').headingDeg, 110);

  const unknown = byId.get('mx-unknown');
  assert.equal(unknown.headingConfidence, 'low');
  assert.ok(Number.isFinite(unknown.headingDeg));
  // Deterministic, so a reload does not swing the frustum around.
  const again = withEnv({ CCTV_MEXICO_SOURCES_FILE: file }, () =>
    loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
  ).find((camera) => camera.id === 'mx-unknown');
  assert.equal(again.headingDeg, unknown.headingDeg);
});

test('a row outside Mexico or with a swapped axis is dropped', (t) => {
  const file = writeCatalog(t, [
    { id: 'mx-good', lat: 19.4326, lon: -99.1332 },
    { id: 'mx-swapped', lat: -99.1332, lon: 19.4326 },
    { id: 'mx-madrid', lat: 40.4168, lon: -3.7038 },
    { id: 'mx-null-island', lat: 0, lon: 0 },
    { id: 'mx-missing-coords' },
    { id: '', lat: 19.4, lon: -99.1 },
  ]);

  const ids = withEnv({ CCTV_MEXICO_SOURCES_FILE: file }, () =>
    loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
  ).map((camera) => camera.id);
  assert.deepEqual(ids, ['mx-good']);
});

test('a catalog edit cannot smuggle an upstream URL into this pack', (t) => {
  const file = writeCatalog(t, [
    {
      id: 'mx-sneaky',
      lat: 19.4326,
      lon: -99.1332,
      url: 'https://example.test/stream.m3u8',
      snapshotUrl: 'https://example.test/frame.jpg',
      feedType: 'hls',
    },
  ]);

  const [camera] = withEnv({ CCTV_MEXICO_SOURCES_FILE: file }, () =>
    loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
  );
  assert.equal(camera.url, '');
  assert.equal(camera.snapshotUrl, '');
  assert.equal(camera.feedType, 'image');
});

test('a missing or malformed catalog yields an empty pack, never a throw', (t) => {
  assert.deepEqual(
    withEnv({ CCTV_MEXICO_SOURCES_FILE: '/nonexistent/mexico.json' }, () =>
      loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
    ),
    [],
  );

  const broken = writeCatalog(t, []);
  fs.writeFileSync(broken, '{not json', 'utf8');
  assert.deepEqual(
    withEnv({ CCTV_MEXICO_SOURCES_FILE: broken }, () =>
      loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
    ),
    [],
  );
});

test('CCTV_MEXICO_MAX_SOURCES caps the pack, nearest-anchor first', () => {
  const capped = withEnv({ CCTV_MEXICO_MAX_SOURCES: '12' }, () =>
    loadMexicoSourcesFromCatalog({ sourceRoot: ROOT }),
  );
  assert.equal(capped.length, 12);
  // The anchors lead with the Zocalo, so a tight cap keeps the capital.
  assert.ok(
    capped.filter((camera) => camera.cityId === 'cdmx').length >= 6,
    'a tight cap must not thin the capital away',
  );
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  // Same guard the Calgary pack carries. A new region shares the catalog cap
  // round-robin (cap.js) instead of widening it, so adding Mexico must not
  // move this number — and the pack's own cap has to stay inside the ceiling.
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
  assert.ok(DEFAULT_MEXICO_MAX_SOURCES > 0);
  assert.ok(DEFAULT_MEXICO_MAX_SOURCES <= CCTV_MAX_SOURCES_CEILING);
});

// ---------------------------------------------------------------------------
// Catalog builder (scripts/build-mexico-cctv.mjs)
// ---------------------------------------------------------------------------

test('normalizeDirection reads the shapes OSM actually carries', () => {
  assert.equal(normalizeDirection('215'), 215);
  assert.equal(normalizeDirection('-90'), 270);
  assert.equal(normalizeDirection('470'), 110);
  // A camera surveyed as covering two arcs: one served pose, so the first wins.
  assert.equal(normalizeDirection('20;180'), 20);
  assert.equal(normalizeDirection('120°'), 120);
  assert.equal(normalizeDirection('NW'), 315);
  assert.equal(normalizeDirection('n'), 0);
  assert.ok(Number.isNaN(normalizeDirection('')));
  assert.ok(Number.isNaN(normalizeDirection(undefined)));
  assert.ok(Number.isNaN(normalizeDirection('towards the plaza')));
});

test('parseWktPoint reads lon-lat order and rejects junk', () => {
  assert.deepEqual(parseWktPoint('POINT(-99.133209 19.432608)'), {
    lat: 19.432608,
    lon: -99.133209,
  });
  assert.equal(parseWktPoint('LINESTRING(0 0, 1 1)'), null);
  assert.equal(parseWktPoint(''), null);
});

test('cameraLabel degrades from name to operator to a disambiguated place', () => {
  assert.equal(cameraLabel({ name: 'Zócalo Norte' }), 'Zócalo Norte');
  assert.equal(
    cameraLabel({ operator: 'C5 CDMX', street: 'Av. Insurgentes' }),
    'C5 CDMX — Av. Insurgentes',
  );
  assert.equal(
    cameraLabel({ street: 'Eje Central' }),
    'Cámara — Eje Central',
  );
  assert.equal(
    cameraLabel({ suburb: 'Roma Norte' }),
    'Cámara — Roma Norte',
  );
  // Nothing but the metro: the id tail keeps a hundred capital pins apart.
  assert.equal(
    cameraLabel({ city: 'Ciudad de México', osmId: '10958525564' }),
    'Cámara — Ciudad de México ·5564',
  );
  assert.equal(
    cameraLabel({ operator: 'C5 CDMX', city: 'Ciudad de México', osmId: '123456' }),
    'C5 CDMX — Ciudad de México ·3456',
  );
});

test('toCctvSource keeps cameras and refuses what is not one', () => {
  const node = (tags, id = '1234567890') => ({
    osmType: 'node',
    osmId: id,
    wkt: 'POINT(-99.133209 19.432608)',
    tags,
  });

  const camera = toCctvSource(
    node({
      'surveillance:type': 'camera',
      'camera:direction': '215',
      'camera:mount': 'pole',
      operator: 'C5 CDMX',
    }),
  );
  assert.equal(camera.id, 'mx-osm-node-1234567890');
  assert.equal(camera.headingDeg, 215);
  assert.equal(camera.headingConfidence, 'high');
  assert.equal(camera.mountHeightM, 5.5);
  assert.equal(camera.groundElevationM, 2240);
  assert.equal(camera.credit, 'C5 CDMX');
  assert.equal(camera.url, undefined);

  // A guard booth and an acoustic sensor are tagged man_made=surveillance too;
  // serving them would put a camera frustum on neither.
  assert.equal(toCctvSource(node({ 'surveillance:type': 'guard' })), null);
  assert.equal(
    toCctvSource(node({ 'surveillance:type': 'gunshot_detector' })),
    null,
  );
  assert.equal(
    toCctvSource(node({ 'surveillance:type': 'camera', surveillance: 'indoor' })),
    null,
  );
  assert.equal(
    toCctvSource({ osmType: 'node', osmId: '1', wkt: 'POINT(0 0)', tags: {} }),
    null,
  );
  assert.equal(toCctvSource({ osmType: 'node', osmId: '', wkt: '', tags: {} }), null);

  // An unmounted, unsurveyed camera still has to produce a usable pose.
  const bare = toCctvSource(node({ 'surveillance:type': 'camera' }, '999'));
  assert.equal(bare.headingDeg, undefined);
  assert.equal(bare.headingConfidence, 'low');
  assert.equal(bare.mountHeightM, 5);
});

test('a camera far from every metro anchor still gets a label and a prior', () => {
  // Mid-Chihuahua desert: no anchor within 70 km.
  const remote = toCctvSource({
    osmType: 'node',
    osmId: '555',
    wkt: 'POINT(-105.5 27.2)',
    tags: { 'surveillance:type': 'camera' },
  });
  assert.equal(remote.city, 'México');
  assert.equal(remote.cityId, 'mexico');
  assert.equal(remote.groundElevationM, 1200);
  assert.equal(remote.name, 'Cámara — México ·555');
});
