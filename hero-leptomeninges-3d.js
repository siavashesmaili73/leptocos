/**
 * LeptoCOS neuroanatomical hero renderer.
 *
 * Static-site integration:
 *   <script type="module" src="./hero-leptomeninges-3d.js"></script>
 *
 * The renderer creates and owns one canvas inside #lcHero3D. The existing
 * #stars canvas remains untouched and visible unless a valid Three.js frame
 * adds .is-three-ready to .hero.
 */
(function () {
  "use strict";

  const THREE_MODULE_PATH = "./assets/vendor/three-r184/three.module.min.js";
  const HOST_ID = "lcHero3D";
  const READY_CLASS = "is-three-ready";
  const API_KEY = "LeptoHero3D";
  const MOTION_SPEED = 0.35;
  const REQUESTED_MODE = new URLSearchParams(window.location.search).get("hero");
  const HERO_MODE = ["anatomical", "constellation", "network", "original", "hybrid"].includes(REQUESTED_MODE)
    ? REQUESTED_MODE
    : "hybrid";

  const COLORS = {
    pia: 0x2f6fb8,
    arachnoid: 0x12897b,
    tissue: 0x3d4453,
    disease: 0xc65d2e,
    depth: 0xc79a2e,
  };

  const SULCI = [
    {
      name: "central",
      depth: 0.115,
      width: 0.062,
      field: (azimuth, y) => [azimuth - (0.2 + y * 0.11), -0.72, 0.84, y],
    },
    {
      name: "precentral",
      depth: 0.073,
      width: 0.052,
      field: (azimuth, y) => [azimuth - (0.015 + y * 0.09), -0.62, 0.82, y],
    },
    {
      name: "postcentral",
      depth: 0.078,
      width: 0.054,
      field: (azimuth, y) => [azimuth - (0.405 + y * 0.08), -0.64, 0.8, y],
    },
    {
      name: "lateral",
      depth: 0.105,
      width: 0.058,
      field: (azimuth, y) => [y - (-0.1 + Math.sin(azimuth * 1.7) * 0.07), 0.02, 1.18, azimuth],
    },
    {
      name: "superior frontal",
      depth: 0.068,
      width: 0.052,
      field: (azimuth, y) => [y - (0.48 + Math.sin((azimuth + 0.16) * 2.1) * 0.055), -0.48, 0.36, azimuth],
    },
    {
      name: "superior temporal",
      depth: 0.072,
      width: 0.05,
      field: (azimuth, y) => [y - (-0.35 + Math.cos(azimuth * 2.15) * 0.045), 0.06, 1.16, azimuth],
    },
  ];

  const disposers = [];
  let destroyed = false;
  let failed = false;
  let heroElement = null;
  let ownedCanvas = null;

  function on(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    disposers.push(() => target.removeEventListener(type, listener, options));
  }

  function seededRandom(seed) {
    return function random() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function smoothstep(minimum, maximum, value) {
    const t = clamp((value - minimum) / (maximum - minimum), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function rangeGate(value, minimum, maximum, feather = 0.14) {
    return (
      smoothstep(minimum - feather, minimum + feather, value) *
      (1 - smoothstep(maximum - feather, maximum + feather, value))
    );
  }

  function markNotReady() {
    if (heroElement) heroElement.classList.remove(READY_CLASS);
  }

  function hasWebGL2() {
    try {
      const probe = document.createElement("canvas");
      return Boolean(
        window.WebGL2RenderingContext &&
          probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true })
      );
    } catch (_error) {
      return false;
    }
  }

  function validThree(candidate) {
    return Boolean(
      candidate &&
        candidate.REVISION === "184" &&
        candidate.WebGLRenderer &&
        candidate.BufferGeometry &&
        candidate.CatmullRomCurve3
    );
  }

  async function loadThree() {
    const module = await import(THREE_MODULE_PATH);
    if (!validThree(module)) {
      throw new Error("The pinned Three.js r184 module did not initialize.");
    }
    return module;
  }

  function qualityFor(width) {
    const cores = navigator.hardwareConcurrency || 4;
    if (width < 860 || cores <= 4) {
      return {
        key: "compact",
        longitude: 34,
        latitude: 22,
        tubeSegments: 42,
        radialSegments: 7,
        trabeculaStride: 4,
        particles: 58,
        caudaRoots: 8,
        dpr: 1.35,
      };
    }
    if (width < 1100 || cores <= 8) {
      return {
        key: "balanced",
        longitude: 46,
        latitude: 30,
        tubeSegments: 62,
        radialSegments: 9,
        trabeculaStride: 3,
        particles: 92,
        caudaRoots: 10,
        dpr: 1.7,
      };
    }
    return {
      key: "high",
      longitude: 58,
      latitude: 38,
      tubeSegments: 82,
      radialSegments: 11,
      trabeculaStride: 2,
      particles: 128,
      caudaRoots: 11,
      dpr: 2,
    };
  }

  function sulcalDepth(normal, side) {
    const azimuth = Math.atan2(side * normal.x, normal.z);
    const frontGate = smoothstep(-0.38, 0.18, normal.z);
    const named = {};
    let total = 0;

    SULCI.forEach((sulcus) => {
      const [distance, gateMin, gateMax, gateValue] = sulcus.field(
        azimuth,
        normal.y
      );
      const gaussian = Math.exp(
        -0.5 * Math.pow(distance / sulcus.width, 2)
      );
      const weight =
        gaussian * rangeGate(gateValue, gateMin, gateMax) * frontGate;
      named[sulcus.name] = weight;
      total += weight * sulcus.depth;
    });

    return {
      depth: Math.min(total, 0.17),
      emphasis: Math.min(
        1,
        Math.max(...Object.values(named)) + Math.min(total * 2.5, 0.35)
      ),
      named,
    };
  }

  function corticalPoint(THREE, side, u, v, layer) {
    const longitude = u * Math.PI * 2;
    const latitude = -Math.PI / 2 + v * Math.PI;
    const cosine = Math.cos(latitude);
    const normal = new THREE.Vector3(
      cosine * Math.cos(longitude),
      Math.sin(latitude),
      cosine * Math.sin(longitude)
    );
    const sulci = sulcalDepth(normal, side);

    const frontalFullness =
      1 + 0.055 * smoothstep(0.18, 0.88, normal.z) * smoothstep(-0.7, 0.2, normal.y);
    const occipitalTaper = 1 - 0.045 * smoothstep(0.35, 0.95, -normal.z);
    const temporalDrop =
      1 + 0.045 * smoothstep(0.05, 0.8, side * normal.x) * smoothstep(-0.15, -0.85, normal.y);
    const lobarScale = frontalFullness * occipitalTaper * temporalDrop;
    const interhemisphericNarrowing =
      1 - 0.08 * smoothstep(0.55, 0.98, -side * normal.x);

    let surfaceScale = 1;
    if (layer === "pia") surfaceScale = 1 - sulci.depth;
    if (layer === "arachnoid") {
      const broadBridge =
        0.012 * Math.cos(latitude * 4) * Math.cos(longitude * 3);
      surfaceScale = 1.055 + broadBridge;
    }
    if (layer === "tissue") surfaceScale = 0.962 - sulci.depth * 0.34;

    const centerZ = side * 0.18;
    return {
      point: new THREE.Vector3(
        normal.x * 1.58 * lobarScale * interhemisphericNarrowing * surfaceScale,
        normal.y * 0.96 * lobarScale * surfaceScale,
        centerZ + normal.z * 0.68 * lobarScale * surfaceScale
      ),
      sulci,
    };
  }

  function createCorticalGeometry(THREE, side, quality, layer) {
    const longitudeSegments = quality.longitude;
    const latitudeSegments = quality.latitude;
    const positions = [];
    const points = [];
    const sulcalWeights = [];
    const indices = [];

    for (let y = 0; y <= latitudeSegments; y += 1) {
      const v = y / latitudeSegments;
      for (let x = 0; x <= longitudeSegments; x += 1) {
        const u = x / longitudeSegments;
        const sample = corticalPoint(THREE, side, u, v, layer);
        positions.push(sample.point.x, sample.point.y, sample.point.z);
        points.push(sample.point);
        sulcalWeights.push(sample.sulci.emphasis);
      }
    }

    const row = longitudeSegments + 1;
    for (let y = 0; y < latitudeSegments; y += 1) {
      for (let x = 0; x < longitudeSegments; x += 1) {
        const a = y * row + x;
        const b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.userData.layer = layer;
    geometry.userData.sulci = SULCI.map((sulcus) => sulcus.name);
    return { geometry, points, sulcalWeights };
  }

  function createTrabeculae(
    THREE,
    arachnoidPoints,
    pialPoints,
    sulcalWeights,
    stride
  ) {
    const positions = [];
    const colors = [];
    const arachnoidColor = new THREE.Color(COLORS.arachnoid);
    const piaColor = new THREE.Color(COLORS.pia);

    for (let index = 0; index < pialPoints.length; index += stride) {
      const emphasis = sulcalWeights[index];
      const sparseBridge = (index * 37) % 97 === 0;
      if (emphasis < 0.22 && !sparseBridge) continue;

      const outer = arachnoidPoints[index];
      const inner = pialPoints[index];
      if (outer.distanceToSquared(inner) < 0.0008) continue;

      positions.push(outer.x, outer.y, outer.z, inner.x, inner.y, inner.z);
      colors.push(
        arachnoidColor.r,
        arachnoidColor.g,
        arachnoidColor.b,
        piaColor.r,
        piaColor.g,
        piaColor.b
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3)
    );
    geometry.userData.structure = "arachnoid trabeculae";

    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.2,
        depthTest: false,
        depthWrite: false,
      })
    );
  }

  function createVariableTubeGeometry(
    THREE,
    curve,
    segments,
    radialSegments,
    radiusAt
  ) {
    const frames = curve.computeFrenetFrames(segments, false);
    const positions = [];
    const indices = [];

    for (let index = 0; index <= segments; index += 1) {
      const t = index / segments;
      const center = curve.getPointAt(t);
      const radius = radiusAt(t);
      const normal = frames.normals[index];
      const binormal = frames.binormals[index];

      for (let radial = 0; radial < radialSegments; radial += 1) {
        const angle = (radial / radialSegments) * Math.PI * 2;
        const offset = new THREE.Vector3()
          .copy(normal)
          .multiplyScalar(Math.cos(angle) * radius)
          .addScaledVector(binormal, Math.sin(angle) * radius);
        positions.push(
          center.x + offset.x,
          center.y + offset.y,
          center.z + offset.z
        );
      }
    }

    for (let index = 0; index < segments; index += 1) {
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const nextRadial = (radial + 1) % radialSegments;
        const a = index * radialSegments + radial;
        const b = (index + 1) * radialSegments + radial;
        const c = (index + 1) * radialSegments + nextRadial;
        const d = index * radialSegments + nextRadial;
        indices.push(a, b, d, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  function makeCurve(THREE, points, tension = 0.5) {
    return new THREE.CatmullRomCurve3(
      points.map((point) => new THREE.Vector3(...point)),
      false,
      "catmullrom",
      tension
    );
  }

  function tubeMesh(
    THREE,
    curve,
    radius,
    material,
    quality,
    segmentScale = 1
  ) {
    return new THREE.Mesh(
      new THREE.TubeGeometry(
        curve,
        Math.max(12, Math.round(quality.tubeSegments * segmentScale)),
        radius,
        quality.radialSegments,
        false
      ),
      material
    );
  }

  function createSulcalGuides(THREE, quality, material) {
    const group = new THREE.Group();
    group.name = "principal-pial-sulci";
    const paths = [
      [[-0.08, 0.82, 0.78], [-0.02, 0.48, 0.82], [0.08, 0.12, 0.84], [0.04, -0.28, 0.8], [0.12, -0.58, 0.72]],
      [[-1.18, -0.03, 0.66], [-0.82, 0.02, 0.76], [-0.42, -0.02, 0.82], [0.02, -0.12, 0.83], [0.46, -0.2, 0.74], [0.86, -0.18, 0.62]],
      [[-0.36, 0.75, 0.73], [-0.3, 0.42, 0.8], [-0.24, 0.06, 0.84], [-0.31, -0.32, 0.77]],
      [[0.27, 0.76, 0.72], [0.34, 0.44, 0.8], [0.42, 0.08, 0.82], [0.46, -0.3, 0.74]],
      [[-1.17, 0.43, 0.65], [-0.87, 0.5, 0.75], [-0.56, 0.44, 0.82], [-0.26, 0.36, 0.83]],
      [[-0.88, -0.38, 0.66], [-0.52, -0.34, 0.77], [-0.14, -0.4, 0.82], [0.25, -0.46, 0.76], [0.62, -0.43, 0.66]],
      [[0.64, 0.55, 0.66], [0.83, 0.3, 0.7], [0.92, 0.02, 0.68], [0.82, -0.28, 0.61]],
    ];
    paths.forEach((points, index) => {
      const curve = makeCurve(THREE, points, 0.38);
      const guide = tubeMesh(
        THREE,
        curve,
        index === 1 ? 0.011 : 0.008,
        material,
        quality,
        0.46
      );
      guide.userData.structure = "pia following named cerebral sulcus";
      group.add(guide);
    });
    return group;
  }

  function createCerebellumGeometry(THREE, quality) {
    const longitude = Math.max(28, quality.longitude - 8);
    const latitude = Math.max(18, quality.latitude - 6);
    const positions = [];
    const indices = [];

    for (let y = 0; y <= latitude; y += 1) {
      const v = y / latitude;
      const phi = -Math.PI / 2 + v * Math.PI;
      for (let x = 0; x <= longitude; x += 1) {
        const u = x / longitude;
        const theta = u * Math.PI * 2;
        const cosine = Math.cos(phi);
        const lobule = 1 + 0.055 * Math.cos(phi * 15) * Math.pow(cosine, 2);
        positions.push(
          0.75 + Math.cos(theta) * cosine * 0.56 * lobule,
          Math.sin(phi) * 0.4 * lobule - 0.78,
          Math.sin(theta) * cosine * 0.46 * lobule - 0.08
        );
      }
    }

    const row = longitude + 1;
    for (let y = 0; y < latitude; y += 1) {
      for (let x = 0; x < longitude; x += 1) {
        const a = y * row + x;
        const b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.userData.structure = "cerebellum with folia";
    return geometry;
  }

  function createMaterials(THREE) {
    const common = {
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    };
    return {
      tissue: new THREE.MeshPhongMaterial({
        ...common,
        color: COLORS.tissue,
        opacity: HERO_MODE === "constellation" ? 0.012 : 0.028,
        shininess: 62,
      }),
      tissueLine: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.tissue,
        opacity: HERO_MODE === "constellation" ? 0.006 : 0.09,
        wireframe: true,
      }),
      pia: new THREE.MeshPhongMaterial({
        ...common,
        color: COLORS.pia,
        opacity: HERO_MODE === "constellation" ? 0.016 : 0.045,
        shininess: 96,
      }),
      piaLine: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.pia,
        opacity: HERO_MODE === "constellation" ? 0.01 : 0.2,
        wireframe: true,
      }),
      arachnoid: new THREE.MeshPhongMaterial({
        ...common,
        color: COLORS.arachnoid,
        opacity: HERO_MODE === "constellation" ? 0.01 : 0.028,
        shininess: 105,
      }),
      arachnoidLine: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.arachnoid,
        opacity: HERO_MODE === "constellation" ? 0.005 : 0.07,
        wireframe: true,
      }),
      sulcus: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.pia,
        opacity: HERO_MODE === "constellation" ? 0.045 : 0.38,
        depthTest: false,
      }),
      root: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.pia,
        opacity: 0.36,
      }),
      filum: new THREE.MeshBasicMaterial({
        ...common,
        color: COLORS.tissue,
        opacity: 0.4,
      }),
    };
  }

  function addCerebralHemisphere(
    THREE,
    group,
    side,
    quality,
    materials
  ) {
    const tissue = createCorticalGeometry(THREE, side, quality, "tissue");
    const pia = createCorticalGeometry(THREE, side, quality, "pia");
    const arachnoid = createCorticalGeometry(
      THREE,
      side,
      quality,
      "arachnoid"
    );

    const tissueMesh = new THREE.Mesh(tissue.geometry, materials.tissue);
    const piaMesh = new THREE.Mesh(pia.geometry, materials.pia);
    const piaLines = new THREE.Mesh(pia.geometry.clone(), materials.piaLine);
    const arachnoidMesh = new THREE.Mesh(
      arachnoid.geometry,
      materials.arachnoid
    );
    const arachnoidLines = new THREE.Mesh(
      arachnoid.geometry.clone(),
      materials.arachnoidLine
    );
    const trabeculae = createTrabeculae(
      THREE,
      arachnoid.points,
      pia.points,
      pia.sulcalWeights,
      quality.trabeculaStride
    );

    [tissueMesh, piaMesh, piaLines, arachnoidMesh, arachnoidLines].forEach(
      (mesh) => {
        mesh.userData.hemisphere = side < 0 ? "left" : "right";
      }
    );
    group.add(
      tissueMesh,
      piaMesh,
      piaLines,
      arachnoidMesh,
      arachnoidLines,
      trabeculae
    );
  }

  function createBrainstemAndCistern(THREE, quality, materials) {
    const group = new THREE.Group();
    group.name = "brainstem-and-cisterna-magna";

    const brainstemCurve = makeCurve(THREE, [
      [0.24, -0.56, -0.12],
      [0.3, -0.84, -0.08],
      [0.36, -1.16, -0.02],
      [0.3, -1.55, 0],
    ]);
    const brainstem = new THREE.Mesh(
      createVariableTubeGeometry(
        THREE,
        brainstemCurve,
        Math.round(quality.tubeSegments * 0.65),
        quality.radialSegments,
        (t) => 0.21 - t * 0.075
      ),
      materials.tissue
    );
    brainstem.userData.structure = "midbrain pons medulla";

    const pons = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.28,
        Math.max(18, quality.longitude / 2),
        Math.max(12, quality.latitude / 2)
      ),
      materials.tissue
    );
    pons.scale.set(1.18, 0.9, 1.05);
    pons.position.set(0.32, -0.96, 0.04);
    pons.userData.structure = "pons";

    const cisternaMagna = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.47,
        Math.max(20, quality.longitude / 2),
        Math.max(14, quality.latitude / 2)
      ),
      materials.arachnoidLine
    );
    cisternaMagna.scale.set(1.42, 0.84, 1.08);
    cisternaMagna.position.set(0.58, -1.14, -0.12);
    cisternaMagna.userData.structure = "enlarged cisterna magna";

    group.add(cisternaMagna, brainstem, pons);
    return group;
  }

  function spinalAxisPoints() {
    return [
      [0.3, -1.48, 0],
      [0.4, -1.88, 0.04],
      [0.44, -2.28, 0.07], // cervical lordosis
      [0.3, -2.72, 0],
      [0.07, -3.25, -0.06],
      [-0.03, -3.82, -0.09], // thoracic kyphosis
      [0.12, -4.28, -0.03],
      [0.39, -4.72, 0.06],
      [0.51, -5.12, 0.09], // lumbar lordosis
      [0.45, -5.5, 0.04],
      [0.34, -5.92, 0], // S2 termination of arachnoid sac
    ];
  }

  function createSpinalAxis(THREE, quality, materials) {
    const group = new THREE.Group();
    group.name = "spinal-axis";
    const sacCurve = makeCurve(THREE, spinalAxisPoints(), 0.42);

    const sac = new THREE.Mesh(
      createVariableTubeGeometry(
        THREE,
        sacCurve,
        quality.tubeSegments,
        quality.radialSegments,
        (t) => {
          const lumbarCistern = 0.1 * Math.exp(-Math.pow((t - 0.73) / 0.2, 2));
          const s2Taper = 1 - smoothstep(0.9, 1, t) * 0.77;
          return (0.18 + lumbarCistern) * s2Taper;
        }
      ),
      materials.arachnoidLine
    );
    sac.userData.structure = "outer spinal arachnoid sac";
    sac.userData.termination = "S2";

    const cordCurve = makeCurve(THREE, spinalAxisPoints().slice(0, 8), 0.42);
    const cord = new THREE.Mesh(
      createVariableTubeGeometry(
        THREE,
        cordCurve,
        Math.round(quality.tubeSegments * 0.7),
        quality.radialSegments,
        (t) => {
          const cervicalEnlargement = 0.018 * Math.exp(-Math.pow((t - 0.2) / 0.18, 2));
          const conus = 1 - smoothstep(0.78, 1, t) * 0.86;
          return (0.095 + cervicalEnlargement) * conus;
        }
      ),
      materials.tissue
    );
    cord.userData.structure = "solid spinal cord and conus medullaris";
    cord.userData.termination = "L1-L2";

    const cordPia = new THREE.Mesh(
      createVariableTubeGeometry(
        THREE,
        cordCurve,
        Math.round(quality.tubeSegments * 0.7),
        quality.radialSegments,
        (t) => {
          const conus = 1 - smoothstep(0.76, 1, t) * 0.84;
          return 0.112 * conus;
        }
      ),
      materials.piaLine
    );
    cordPia.userData.structure = "spinal pia";

    group.add(sac, cord, cordPia);

    const conusPoint = cordCurve.getPointAt(1);
    const rootCount = quality.caudaRoots;
    for (let index = 0; index < rootCount; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const depthBand = Math.floor(index / 2);
      const targetT = clamp(0.67 + depthBand * 0.07, 0.67, 0.97);
      const target = sacCurve.getPointAt(targetT);
      const lateral = side * (0.045 + (depthBand % 3) * 0.018);
      const rootCurve = makeCurve(
        THREE,
        [
          [conusPoint.x, conusPoint.y, conusPoint.z],
          [conusPoint.x + lateral * 0.45, conusPoint.y - 0.24, side * 0.025],
          [target.x + lateral, target.y, target.z + side * 0.035],
        ],
        0.36
      );
      const root = tubeMesh(
        THREE,
        rootCurve,
        0.009,
        materials.root,
        quality,
        0.58
      );
      root.userData.structure = "cauda equina root";
      group.add(root);
    }

    const s2Point = sacCurve.getPointAt(0.99);
    const filumCurve = makeCurve(THREE, [
      [conusPoint.x, conusPoint.y, conusPoint.z],
      [0.38, -5.12, 0.015],
      [s2Point.x, s2Point.y, s2Point.z],
    ]);
    const filum = tubeMesh(
      THREE,
      filumCurve,
      0.0065,
      materials.filum,
      quality,
      0.7
    );
    filum.userData.structure = "filum terminale";
    group.add(filum);

    group.userData.sacCurve = sacCurve;
    return group;
  }

  function createAccents(THREE, quality, spinalCurve) {
    const random = seededRandom(3224);
    const positions = new Float32Array(quality.particles * 3);
    const colors = new Float32Array(quality.particles * 3);
    const color = new THREE.Color();

    for (let index = 0; index < quality.particles; index += 1) {
      let point;
      if (index < quality.particles * 0.76) {
        const side = random() < 0.5 ? -1 : 1;
        const sample = corticalPoint(
          THREE,
          side,
          random(),
          0.08 + random() * 0.84,
          random() < 0.55 ? "pia" : "arachnoid"
        );
        point = sample.point;
      } else {
        point = spinalCurve.getPointAt(random());
        point.x += (random() - 0.5) * 0.2;
        point.z += (random() - 0.5) * 0.12;
      }

      positions.set([point.x, point.y, point.z], index * 3);
      const roll = random();
      const semanticColor =
        roll < 0.43
          ? COLORS.pia
          : roll < 0.78
            ? COLORS.arachnoid
            : roll < 0.94
              ? COLORS.tissue
              : roll < 0.975
                ? COLORS.disease
                : COLORS.depth;
      color.setHex(semanticColor);
      colors.set([color.r, color.g, color.b], index * 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.userData.structure = "COMET semantic accents";

    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: quality.key === "compact" ? 0.035 : 0.041,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.48,
        vertexColors: true,
        depthWrite: false,
      })
    );
  }

  function createConstellationLayer(THREE, quality, spinalCurve) {
    const group = new THREE.Group();
    group.name = "anatomical-constellation-grid";
    const positions = [];
    const colors = [];
    const phases = [];
    const edges = [];
    const color = new THREE.Color();
    const palette = [
      COLORS.pia,
      COLORS.arachnoid,
      COLORS.pia,
      COLORS.arachnoid,
      COLORS.tissue,
      COLORS.depth,
      COLORS.pia,
      COLORS.disease,
    ];
    const longitude = quality.key === "compact" ? 9 : quality.key === "balanced" ? 11 : 14;
    const latitude = quality.key === "compact" ? 6 : quality.key === "balanced" ? 7 : 9;

    function addNode(point, colorHex, phase) {
      const index = positions.length / 3;
      positions.push(point.x, point.y, point.z);
      color.setHex(colorHex);
      colors.push(color.r, color.g, color.b);
      phases.push(phase);
      return index;
    }

    function addEdge(a, b) {
      edges.push(a, b);
    }

    [-1, 1].forEach((side, hemisphereIndex) => {
      const rows = [];
      for (let y = 1; y < latitude; y += 1) {
        const v = y / latitude;
        const row = [];
        for (let x = 0; x < longitude; x += 1) {
          const u = x / longitude;
          const layer = (x + y) % 5 === 0 ? "arachnoid" : "pia";
          const sample = corticalPoint(THREE, side, u, v, layer);
          const paletteIndex = (x * 3 + y * 2 + hemisphereIndex) % palette.length;
          row.push(
            addNode(
              sample.point,
              palette[paletteIndex],
              u * Math.PI * 4 + v * Math.PI * 2 + side
            )
          );
        }
        rows.push(row);
      }

      rows.forEach((row, y) => {
        row.forEach((node, x) => {
          addEdge(node, row[(x + 1) % longitude]);
          if (y + 1 < rows.length) {
            addEdge(node, rows[y + 1][x]);
            if ((x + y) % 3 === 0) {
              addEdge(node, rows[y + 1][(x + 1) % longitude]);
            }
          }
        });
      });
    });

    const spineRows = [];
    const spineSegments = quality.key === "compact" ? 17 : quality.key === "balanced" ? 23 : 29;
    const ringCount = 3;
    for (let segment = 0; segment <= spineSegments; segment += 1) {
      const t = segment / spineSegments;
      const center = spinalCurve.getPointAt(t);
      const radius = 0.075 + Math.sin(t * Math.PI) * 0.018;
      const row = [];
      for (let ring = 0; ring < ringCount; ring += 1) {
        const angle = (ring / ringCount) * Math.PI * 2 + segment * 0.16;
        const point = center.clone();
        point.x += Math.cos(angle) * radius;
        point.z += Math.sin(angle) * radius;
        row.push(
          addNode(
            point,
            ring % 2 ? COLORS.arachnoid : COLORS.pia,
            t * Math.PI * 8 + angle
          )
        );
      }
      spineRows.push(row);
    }

    spineRows.forEach((row, segment) => {
      row.forEach((node, ring) => {
        addEdge(node, row[(ring + 1) % ringCount]);
        if (segment + 1 < spineRows.length) {
          addEdge(node, spineRows[segment + 1][ring]);
          if ((segment + ring) % 3 === 0) {
            addEdge(node, spineRows[segment + 1][(ring + 1) % ringCount]);
          }
        }
      });
    });

    const base = new Float32Array(positions);
    const linePositions = new Float32Array(base);
    const pointPositions = new Float32Array(base);
    const colorArray = new Float32Array(colors);

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
    lineGeometry.setAttribute("color", new THREE.BufferAttribute(colorArray, 3));
    lineGeometry.setIndex(edges);
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NormalBlending,
      })
    );

    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
    pointGeometry.setAttribute("color", new THREE.BufferAttribute(colorArray.slice(), 3));
    const points = new THREE.Points(
      pointGeometry,
      new THREE.PointsMaterial({
        size: quality.key === "compact" ? 0.064 : 0.086,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.78,
        depthTest: false,
        depthWrite: false,
      })
    );

    group.add(lines, points);
    group.userData.update = (time) => {
      for (let index = 0; index < phases.length; index += 1) {
        const offset = index * 3;
        const wave = Math.sin(time * 1.15 + phases[index]);
        const ripple = Math.cos(time * 0.72 + phases[index] * 0.63);
        const x = base[offset] + ripple * 0.006;
        const y = base[offset + 1] + wave * 0.009;
        const z = base[offset + 2] + wave * 0.014;
        linePositions[offset] = pointPositions[offset] = x;
        linePositions[offset + 1] = pointPositions[offset + 1] = y;
        linePositions[offset + 2] = pointPositions[offset + 2] = z;
      }
      lineGeometry.attributes.position.needsUpdate = true;
      pointGeometry.attributes.position.needsUpdate = true;
      points.material.opacity = 0.7 + Math.sin(time * 0.9) * 0.1;
    };
    return group;
  }

  function createAnatomy(THREE, quality) {
    const anatomy = new THREE.Group();
    anatomy.name = "leptomeningeal-neuroaxis";
    const materials = createMaterials(THREE);
    const cerebrum = new THREE.Group();
    cerebrum.name = "cerebrum";

    addCerebralHemisphere(THREE, cerebrum, -1, quality, materials);
    addCerebralHemisphere(THREE, cerebrum, 1, quality, materials);
    cerebrum.add(createSulcalGuides(THREE, quality, materials.sulcus));

    const cerebellumGeometry = createCerebellumGeometry(THREE, quality);
    const cerebellum = new THREE.Mesh(cerebellumGeometry, materials.tissue);
    const cerebellarFolia = new THREE.Mesh(
      cerebellumGeometry.clone(),
      materials.tissueLine
    );
    const brainstemAndCistern = createBrainstemAndCistern(
      THREE,
      quality,
      materials
    );
    const spinalAxis = createSpinalAxis(THREE, quality, materials);
    const accents = createAccents(THREE, quality, spinalAxis.userData.sacCurve);
    const constellation =
      HERO_MODE === "constellation"
        ? createConstellationLayer(THREE, quality, spinalAxis.userData.sacCurve)
        : null;

    anatomy.add(
      cerebrum,
      cerebellum,
      cerebellarFolia,
      brainstemAndCistern,
      spinalAxis,
      accents
    );
    if (constellation) anatomy.add(constellation);
    anatomy.userData.quality = quality.key;
    anatomy.userData.mode = HERO_MODE;
    anatomy.userData.constellation = constellation;
    anatomy.userData.motion = "coherent rigid-body drift";
    return anatomy;
  }

  function disposeObject(root) {
    const geometries = new Set();
    const materials = new Set();
    root.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => materials.add(material));
      } else if (object.material) {
        materials.add(object.material);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }

  function fail(error) {
    if (failed || destroyed) return;
    failed = true;
    markNotReady();
    console.warn(
      "LeptoCOS Three.js hero unavailable; retaining the #stars fallback.",
      error
    );
    destroy();
  }

  function initThree(THREE, host) {
    if (destroyed) return;

    const canvas = document.createElement("canvas");
    canvas.className = "lc-hero-3d-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.tabIndex = -1;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.pointerEvents = "none";
    host.appendChild(canvas);
    ownedCanvas = canvas;
    disposers.push(() => {
      if (canvas.parentNode === host) host.removeChild(canvas);
      ownedCanvas = null;
    });

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
        premultipliedAlpha: true,
      });
    } catch (error) {
      fail(error);
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50);
    camera.position.set(0.4, 0.12, 14);
    camera.lookAt(0, -1.65, 0);
    scene.add(new THREE.HemisphereLight(0xf7fbff, 0x65717f, 1.75));
    const rim = new THREE.DirectionalLight(COLORS.pia, 1.15);
    rim.position.set(4, 5, 8);
    scene.add(rim);

    let quality = qualityFor(Math.max(1, host.clientWidth));
    let anatomy = createAnatomy(THREE, quality);
    scene.add(anatomy);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = motionQuery.matches;
    let pageVisible = !document.hidden;
    let inViewport = true;
    let frame = 0;
    let startTime = 0;
    let firstValidFrame = false;

    function renderFrame(elapsed) {
      if (destroyed || failed) return false;
      const time = elapsed * 0.001 * MOTION_SPEED;
      const constellation = anatomy.userData.constellation;
      if (constellation && constellation.userData.update) {
        constellation.userData.update(time);
      }
      if (reduceMotion) {
        anatomy.rotation.set(-0.018, -0.035, 0);
        if (HERO_MODE === "constellation") {
          anatomy.position.set(
            anatomy.userData.anchorX || 0,
            anatomy.userData.anchorY || 0,
            0
          );
        }
      } else {
        anatomy.rotation.set(
          -0.018 + Math.sin(time * 0.41) * (HERO_MODE === "constellation" ? 0.025 : 0.014),
          -0.035 + Math.sin(time * 0.62) * (HERO_MODE === "constellation" ? 0.12 : 0.072),
          Math.sin(time * 0.29) * (HERO_MODE === "constellation" ? 0.018 : 0.009)
        );
        if (HERO_MODE === "constellation") {
          anatomy.position.set(
            (anatomy.userData.anchorX || 0) + Math.sin(time * 0.34) * 0.28,
            (anatomy.userData.anchorY || 0) + Math.cos(time * 0.27) * 0.16,
            Math.sin(time * 0.22) * 0.08
          );
        }
      }

      try {
        renderer.render(scene, camera);
        const context = renderer.getContext();
        const valid =
          canvas.width > 1 &&
          canvas.height > 1 &&
          !context.isContextLost() &&
          renderer.info.render.calls > 0;
        if (valid && !firstValidFrame) {
          firstValidFrame = true;
          heroElement.classList.add(READY_CLASS);
        }
        return valid;
      } catch (error) {
        fail(error);
        return false;
      }
    }

    function layout() {
      if (destroyed || failed) return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      const nextQuality = qualityFor(width);
      const aspect = width / height;
      const frustumHeight = 10;
      const frustumWidth = frustumHeight * aspect;

      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, nextQuality.dpr)
      );
      renderer.setSize(width, height, false);
      camera.left = -frustumWidth / 2;
      camera.right = frustumWidth / 2;
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
      camera.updateProjectionMatrix();

      if (nextQuality.key !== quality.key) {
        scene.remove(anatomy);
        disposeObject(anatomy);
        quality = nextQuality;
        anatomy = createAnatomy(THREE, quality);
        scene.add(anatomy);
      }
      canvas.dataset.quality = quality.key;

      const compact = quality.key === "compact";
      const scale = compact
        ? HERO_MODE === "constellation" ? 0.44 : 0.29
        : Math.min(
            HERO_MODE === "constellation" ? 2.05 : 1.12,
            (HERO_MODE === "constellation" ? 1.68 : 0.93) + width / 8000
          );
      anatomy.scale.setScalar(scale);
      const anchorX = compact
        ? frustumWidth * (HERO_MODE === "constellation" ? 0.34 : 0.4)
        : frustumWidth * (HERO_MODE === "constellation" ? 0.22 : 0.315);
      const anchorY = compact
        ? HERO_MODE === "constellation" ? 1.95 : 2.15
        : HERO_MODE === "constellation" ? 1.45 : 1.23;
      anatomy.userData.anchorX = anchorX;
      anatomy.userData.anchorY = anchorY;
      anatomy.position.set(anchorX, anchorY, 0);
      renderFrame(0);
    }

    function animate(now) {
      frame = 0;
      if (
        destroyed ||
        failed ||
        reduceMotion ||
        !pageVisible ||
        !inViewport
      ) {
        return;
      }
      if (!startTime) startTime = now;
      if (renderFrame(now - startTime)) {
        frame = requestAnimationFrame(animate);
      }
    }

    function syncAnimation() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      startTime = 0;
      if (!reduceMotion && pageVisible && inViewport && !failed) {
        frame = requestAnimationFrame(animate);
      } else if (!failed) {
        renderFrame(0);
      }
    }

    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(host);
    disposers.push(() => resizeObserver.disconnect());

    if ("IntersectionObserver" in window) {
      const intersectionObserver = new IntersectionObserver(
        (entries) => {
          inViewport = entries[0] ? entries[0].isIntersecting : true;
          syncAnimation();
        },
        { rootMargin: "80px" }
      );
      intersectionObserver.observe(host);
      disposers.push(() => intersectionObserver.disconnect());
    }

    const onMotionChange = (event) => {
      reduceMotion = event.matches;
      syncAnimation();
    };
    if (motionQuery.addEventListener) {
      on(motionQuery, "change", onMotionChange);
    } else {
      motionQuery.addListener(onMotionChange);
      disposers.push(() => motionQuery.removeListener(onMotionChange));
    }

    on(document, "visibilitychange", () => {
      pageVisible = !document.hidden;
      syncAnimation();
    });
    on(canvas, "webglcontextlost", (event) => {
      event.preventDefault();
      firstValidFrame = false;
      markNotReady();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    });
    on(canvas, "webglcontextrestored", () => {
      firstValidFrame = false;
      layout();
      syncAnimation();
    });

    disposers.push(() => {
      if (frame) cancelAnimationFrame(frame);
      markNotReady();
      disposeObject(scene);
      renderer.dispose();
      canvas.removeAttribute("data-renderer");
      canvas.removeAttribute("data-quality");
    });

    canvas.dataset.renderer = `three-r184-leptomeninges-${HERO_MODE}`;
    canvas.dataset.quality = quality.key;
    layout();
    syncAnimation();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    markNotReady();
    while (disposers.length) {
      try {
        disposers.pop()();
      } catch (_error) {
        // Cleanup remains best-effort during navigation or context teardown.
      }
    }
    if (globalThis[API_KEY] && globalThis[API_KEY].destroy === destroy) {
      delete globalThis[API_KEY];
    }
  }

  async function boot() {
    heroElement = document.querySelector(".hero");
    const host = document.getElementById(HOST_ID);
    if (!(heroElement instanceof HTMLElement) || !(host instanceof HTMLElement)) {
      markNotReady();
      return;
    }

    heroElement.classList.toggle("is-hybrid", HERO_MODE === "hybrid");

    if (HERO_MODE === "network" || HERO_MODE === "original" || HERO_MODE === "hybrid") {
      markNotReady();
      return;
    }

    if (globalThis[API_KEY] && globalThis[API_KEY].destroy) {
      globalThis[API_KEY].destroy();
    }
    globalThis[API_KEY] = {
      destroy,
      motionSpeed: MOTION_SPEED,
      mode: HERO_MODE,
      renderer: "three-r184",
      version: "2.0.0",
    };

    if (!hasWebGL2()) {
      fail(new Error("WebGL2 is unavailable."));
      return;
    }

    try {
      const THREE = await loadThree();
      if (!destroyed) initThree(THREE, host);
    } catch (error) {
      fail(error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
