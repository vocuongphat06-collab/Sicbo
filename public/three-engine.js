// three-engine.js - AAA Showcase 3D Sicbo Engine (Optimized for 60-144 FPS across Brave/Chrome/Edge)
// Features: Procedural Studio PMREM HDRI, Chamfered Clearcoat Ivory Dice with 3D Recessed Pip Bump Maps,
// Translucent Smoked-Crystal Shaker Cloche (switches to Opaque Titanium in Squeeze Mode),
// Sub-stepped Non-Interpenetrating Rigid-Body Dice Physics + Bounce Audio Sync, and X/Z Horizontal "Nặn Bát 3D".

class Sicbo3DEngine {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;

    this.diceGroup = [];
    this.diceBodies = [];
    this.bowlGroup = null;
    this.bowlDomeMat = null;
    this.trayGroup = null;
    this.chipsForegroundGroup = null;
    this.floatingSculptures = [];
    this.bokehMesh = null;
    this.bokehData = [];

    this.squeezeRimLight = null;
    this.innerRimMat = null;

    this.diceSize = 1.24;
    this.trayCenter = { x: 0, z: -0.6 };
    this.floorY = 0.3 + 0.14 + (1.24 * 0.5);

    this.isRolling = false;
    this.isAnimatingBowl = false;
    this._bowlOpenedAtTime = 0;
    this.physicsState = null;

    this.isBowlClosed = false;
    this.isDraggingBowl = false;
    this.dragStart = { x: 0, y: 0 };
    this.bowlOffset = { x: 0, z: 0 };
    this.dragStartOffset = { x: 0, z: 0 };
    this.squeezeZoom = 0;
    this.isSqueezeOpaque = false;
    this.keyLight = null;
    this._bokehDummy = new THREE.Object3D();
    this.bokehMaxCount = 150;
    this.cameraFraming = { fov: 34, baseY: 11.4, baseZ: 16.0, lookY: 0.4, lookZ: -0.42 };

    this.rafId = null;
    this.isPaused = (typeof document !== 'undefined') ? Boolean(document.hidden) : false;
    this.graphicsQuality = 'high';
    this._maxDpr = 1.5;
    this.minFrameIntervalMs = 0;
    this.activeMinFrameIntervalMs = 0;
    this.lastRenderTime = 0;

    this.callbacks = {};

    this.mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    this.clock = new THREE.Clock();
    this.frameCount = 0;
    this.lastFpsTime = performance.now();

    this.init();
  }

  init() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. Scene with Deep Velvet-Obsidian Salon Fog
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x131017, 0.019);

    // 2. Cinematic 35mm Camera (auto-adapts framing for portrait mobile viewports)
    this.cameraFraming = this.computeCameraFraming(width, height);
    this.camera = new THREE.PerspectiveCamera(this.cameraFraming.fov, Math.max(0.25, width / Math.max(1, height)), 0.1, 100);
    this.camera.position.set(0, this.cameraFraming.baseY, this.cameraFraming.baseZ);
    this.camera.lookAt(0, this.cameraFraming.lookY, this.cameraFraming.lookZ);

    // 3. Renderer (Capped at 1.5x DPR for buttery-smooth 60-144 FPS in Brave & Chrome)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.sRGBEncoding !== undefined) {
      this.renderer.outputEncoding = THREE.sRGBEncoding;
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.container.appendChild(this.renderer.domElement);

    // 4. Procedural Studio HDRI Environment Map (PMREMGenerator)
    this.setupStudioEnvironment();

    // 5. Dramatic Private Salon Direct Lighting
    this.setupLights();

    // 6. Architectural Salon Table & Obsidian-Gold Turntable
    this.buildTray();

    // 7. 3 Chamfered Ivory-Porcelain Dice with Recessed 3D Bump Pips
    this.buildDice();

    // 8. Smoked Crystal / Titanium Shaker Dome + Rim Leak Light
    this.buildBowl();

    // 9. Foreground 3D Chip Stacks & Background Beveled Gold Dice
    this.buildSalonProps();

    // 10. 150 Golden Spotlight Bokeh & Dust Motes
    this.buildGoldenBokeh();

    let savedQuality = 'high';
    try {
      const q = localStorage.getItem('sicbo_graphics_quality');
      if (q === 'high' || q === 'balanced' || q === 'eco') savedQuality = q;
    } catch (_) {}
    this.setGraphicsQuality(savedQuality);

    // 11. Interaction Events
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.setupBowlDrag();

    // 12. Main Render & Physics Loop
    this.animate = this.animate.bind(this);
    this._onVisibilityChange = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    if (!document.hidden) {
      this.rafId = requestAnimationFrame(this.animate);
    }
  }

  setupStudioEnvironment() {
    if (!THREE.PMREMGenerator) return;
    try {
      const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      if (pmremGenerator.compileEquirectangularShader) {
        pmremGenerator.compileEquirectangularShader();
      }

      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0x120f16);

      const tempDisposables = [];
      const addStudioPanel = (w, h, colorRGB, pos, lookAtPos) => {
        const geo = new THREE.PlaneGeometry(w, h);
        const col = new THREE.Color();
        col.setRGB(colorRGB[0], colorRGB[1], colorRGB[2]);
        const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos[0], pos[1], pos[2]);
        mesh.lookAt(lookAtPos[0], lookAtPos[1], lookAtPos[2]);
        envScene.add(mesh);
        tempDisposables.push(geo, mat);
      };

      addStudioPanel(14, 14, [3.1, 2.75, 2.25], [0, 13, 2], [0, 0, 0]);
      addStudioPanel(16, 2.2, [4.0, 3.7, 3.3], [0, 11, -6], [0, 0, 0]);
      addStudioPanel(5, 11, [2.6, 1.75, 0.95], [-13, 5, 2], [0, 1, 0]);
      addStudioPanel(5, 11, [0.75, 2.05, 1.5], [13, 4.5, -1], [0, 1, 0]);
      addStudioPanel(10, 4, [2.1, 0.65, 0.85], [0, 6, -13], [0, 1, 0]);
      addStudioPanel(12, 5, [1.5, 1.38, 1.25], [0, 5.5, 14], [0, 1, 0]);
      addStudioPanel(22, 22, [0.22, 0.18, 0.16], [0, -8, 0], [0, 0, 0]);

      const envRT = pmremGenerator.fromScene(envScene, 0.035);
      this.scene.environment = envRT.texture;

      tempDisposables.forEach(item => item.dispose());
      pmremGenerator.dispose();
    } catch (e) {
      console.warn('PMREM fallback:', e);
    }
  }

  setupLights() {
    const hemiLight = new THREE.HemisphereLight(0xffe9cf, 0x11131a, 0.92);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff2dc, 2.2);
    this.keyLight = keyLight;
    keyLight.position.set(6.5, 21, 11.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 42;
    keyLight.shadow.camera.left = -9;
    keyLight.shadow.camera.right = 9;
    keyLight.shadow.camera.top = 9;
    keyLight.shadow.camera.bottom = -9;
    keyLight.shadow.bias = -0.0005;
    this.scene.add(keyLight);

    const goldRim = new THREE.PointLight(0xffb86c, 2.1, 28);
    goldRim.position.set(-9, 6, 3);
    this.scene.add(goldRim);

    const emeraldRim = new THREE.PointLight(0x45c496, 1.45, 26);
    emeraldRim.position.set(9, 5, -3);
    this.scene.add(emeraldRim);

    const crimsonBack = new THREE.PointLight(0xe0485d, 1.35, 22);
    crimsonBack.position.set(0, 7, -8);
    this.scene.add(crimsonBack);

    this.squeezeRimLight = new THREE.PointLight(0xffbe66, 0, 9.5, 1.8);
    this.squeezeRimLight.position.set(0, 1.3, -0.6);
    this.scene.add(this.squeezeRimLight);
  }

  createRoundedBoxGeometry(size = 1.24, radius = 0.175, segments = 8) {
    const geo = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const half = size * 0.5;
    const inner = Math.max(0.001, half - radius);

    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);

      const cx = Math.max(-inner, Math.min(inner, vx));
      const cy = Math.max(-inner, Math.min(inner, vy));
      const cz = Math.max(-inner, Math.min(inner, vz));

      const dx = vx - cx;
      const dy = vy - cy;
      const dz = vz - cz;
      const len = Math.hypot(dx, dy, dz);

      if (len > 1e-6) {
        const nx = dx / len;
        const ny = dy / len;
        const nz = dz / len;
        pos.setXYZ(i, cx + nx * radius, cy + ny * radius, cz + nz * radius);
        norm.setXYZ(i, nx, ny, nz);
      }
    }

    pos.needsUpdate = true;
    norm.needsUpdate = true;
    return geo;
  }

  createDiceFaceMaps(number) {
    const S = 512;
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = S;
    colorCanvas.height = S;
    const cctx = colorCanvas.getContext('2d');

    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = S;
    bumpCanvas.height = S;
    const bctx = bumpCanvas.getContext('2d');

    const grad = cctx.createRadialGradient(240, 230, 30, 256, 256, 360);
    grad.addColorStop(0, '#fffdf9');
    grad.addColorStop(0.68, '#f5efe4');
    grad.addColorStop(1, '#e2d7c3');
    cctx.fillStyle = grad;
    cctx.fillRect(0, 0, S, S);

    cctx.strokeStyle = 'rgba(180, 160, 130, 0.045)';
    cctx.lineWidth = 2;
    for (let r = 45; r < 340; r += 26) {
      cctx.beginPath();
      cctx.ellipse(256, 256, r * 1.08, r * 0.94, 0.35, 0, Math.PI * 2);
      cctx.stroke();
    }

    bctx.fillStyle = '#eaeaea';
    bctx.fillRect(0, 0, S, S);

    const CINNABAR = '#c9243b';
    const INK = '#17161d';

    const drawRecessedPip = (x, y, radius, color, hasGoldRing = false) => {
      cctx.save();
      if (hasGoldRing) {
        cctx.beginPath();
        cctx.arc(x, y, radius + 7, 0, Math.PI * 2);
        cctx.strokeStyle = 'rgba(198, 154, 98, 0.55)';
        cctx.lineWidth = 3.5;
        cctx.stroke();
      }

      const ao = cctx.createRadialGradient(x + radius * 0.12, y + radius * 0.14, radius * 0.2, x, y, radius * 1.08);
      ao.addColorStop(0, color);
      ao.addColorStop(0.82, color);
      ao.addColorStop(0.95, 'rgba(30, 22, 20, 0.45)');
      ao.addColorStop(1, 'rgba(255, 253, 248, 0)');
      cctx.fillStyle = ao;
      cctx.beginPath();
      cctx.arc(x, y, radius * 1.08, 0, Math.PI * 2);
      cctx.fill();

      cctx.beginPath();
      cctx.arc(x, y, radius * 0.94, 0, Math.PI * 2);
      cctx.fillStyle = color;
      cctx.fill();

      const hl = cctx.createRadialGradient(
        x + radius * 0.28, y + radius * 0.28, radius * 0.05,
        x, y, radius * 0.95
      );
      hl.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
      hl.addColorStop(0.45, 'rgba(255, 255, 255, 0.08)');
      hl.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
      cctx.fillStyle = hl;
      cctx.beginPath();
      cctx.arc(x, y, radius * 0.94, 0, Math.PI * 2);
      cctx.fill();
      cctx.restore();

      bctx.save();
      const bg = bctx.createRadialGradient(x, y, 1, x, y, radius * 1.14);
      bg.addColorStop(0, '#080808');
      bg.addColorStop(0.55, '#383838');
      bg.addColorStop(0.88, '#bababa');
      bg.addColorStop(0.97, '#ffffff');
      bg.addColorStop(1, '#eaeaea');
      bctx.fillStyle = bg;
      bctx.beginPath();
      bctx.arc(x, y, radius * 1.14, 0, Math.PI * 2);
      bctx.fill();
      bctx.restore();
    };

    if (number === 1) {
      drawRecessedPip(256, 256, 72, CINNABAR, true);
    } else if (number === 2) {
      drawRecessedPip(158, 158, 38, INK);
      drawRecessedPip(354, 354, 38, INK);
    } else if (number === 3) {
      drawRecessedPip(146, 146, 35, INK);
      drawRecessedPip(256, 256, 35, INK);
      drawRecessedPip(366, 366, 35, INK);
    } else if (number === 4) {
      drawRecessedPip(158, 158, 38, CINNABAR);
      drawRecessedPip(354, 158, 38, CINNABAR);
      drawRecessedPip(158, 354, 38, CINNABAR);
      drawRecessedPip(354, 354, 38, CINNABAR);
    } else if (number === 5) {
      drawRecessedPip(150, 150, 35, INK);
      drawRecessedPip(362, 150, 35, INK);
      drawRecessedPip(256, 256, 38, CINNABAR);
      drawRecessedPip(150, 362, 35, INK);
      drawRecessedPip(362, 362, 35, INK);
    } else if (number === 6) {
      drawRecessedPip(160, 138, 34, INK);
      drawRecessedPip(352, 138, 34, INK);
      drawRecessedPip(160, 256, 34, INK);
      drawRecessedPip(352, 256, 34, INK);
      drawRecessedPip(160, 374, 34, INK);
      drawRecessedPip(352, 374, 34, INK);
    }

    const maxAniso = this.renderer ? Math.min(4, this.renderer.capabilities.getMaxAnisotropy()) : 2;

    const colorTex = new THREE.CanvasTexture(colorCanvas);
    if (THREE.sRGBEncoding !== undefined) colorTex.encoding = THREE.sRGBEncoding;
    colorTex.anisotropy = maxAniso;
    colorTex.generateMipmaps = true;

    const bumpTex = new THREE.CanvasTexture(bumpCanvas);
    bumpTex.anisotropy = maxAniso;
    bumpTex.generateMipmaps = true;

    return { colorTex, bumpTex };
  }

  createChipTexture(primaryColor, accentColor, label) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = primaryColor;
    ctx.beginPath();
    ctx.arc(128, 128, 126, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 18;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.arc(128, 128, 114, a - 0.14, a + 0.14);
      ctx.stroke();
    }

    ctx.strokeStyle = '#e5c19e';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(128, 128, 84, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#18161c';
    ctx.beginPath();
    ctx.arc(128, 128, 76, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f5f2eb';
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 128, 128);

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  buildTray() {
    this.trayGroup = new THREE.Group();

    const tableGeo = new THREE.CylinderGeometry(16, 16, 0.2, 64);
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x141718,
      roughness: 0.86,
      metalness: 0.08,
      envMapIntensity: 0.45
    });
    const tableMesh = new THREE.Mesh(tableGeo, tableMat);
    tableMesh.position.y = -0.65;
    tableMesh.receiveShadow = true;
    this.trayGroup.add(tableMesh);

    [6.2, 8.8, 11.8].forEach(radius => {
      const rGeo = new THREE.RingGeometry(radius, radius + 0.035, 72);
      const rMat = new THREE.MeshBasicMaterial({
        color: 0xe5c19e,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide
      });
      const rMesh = new THREE.Mesh(rGeo, rMat);
      rMesh.rotation.x = -Math.PI / 2;
      rMesh.position.y = -0.53;
      this.trayGroup.add(rMesh);
    });

    const baseGeo = new THREE.CylinderGeometry(4.62, 5.15, 0.65, 64);
    const lacquerMat = new THREE.MeshPhysicalMaterial({
      color: 0x17141a,
      roughness: 0.14,
      metalness: 0.45,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.35
    });
    const trayBase = new THREE.Mesh(baseGeo, lacquerMat);
    trayBase.position.y = -0.25;
    trayBase.castShadow = true;
    trayBase.receiveShadow = true;
    this.trayGroup.add(trayBase);

    const feltGeo = new THREE.CylinderGeometry(4.26, 4.26, 0.12, 64);
    const feltMat = new THREE.MeshStandardMaterial({
      color: 0x12261f,
      roughness: 0.92,
      metalness: 0.04,
      envMapIntensity: 0.35
    });
    const felt = new THREE.Mesh(feltGeo, feltMat);
    felt.position.y = 0.08;
    felt.receiveShadow = true;
    this.trayGroup.add(felt);

    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xe8c6a0,
      roughness: 0.16,
      metalness: 0.96,
      envMapIntensity: 1.45
    });

    const ringGeo = new THREE.TorusGeometry(4.36, 0.085, 16, 64);
    const goldRing = new THREE.Mesh(ringGeo, goldMat);
    goldRing.rotation.x = Math.PI / 2;
    goldRing.position.y = 0.14;
    this.trayGroup.add(goldRing);

    const innerFilletGeo = new THREE.TorusGeometry(3.85, 0.022, 12, 64);
    const innerFillet = new THREE.Mesh(innerFilletGeo, goldMat);
    innerFillet.rotation.x = Math.PI / 2;
    innerFillet.position.y = 0.145;
    this.trayGroup.add(innerFillet);

    this.trayGroup.position.set(this.trayCenter.x, 0.3, this.trayCenter.z);
    this.scene.add(this.trayGroup);
  }

  buildDice() {
    const maps = [];
    for (let i = 1; i <= 6; i++) {
      maps.push(this.createDiceFaceMaps(i));
    }

    const faceOrder = [0, 5, 1, 4, 2, 3];
    const diceMaterials = faceOrder.map(idx => new THREE.MeshPhysicalMaterial({
      map: maps[idx].colorTex,
      bumpMap: maps[idx].bumpTex,
      bumpScale: 0.045,
      roughness: 0.14,
      metalness: 0.02,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      reflectivity: 0.92,
      envMapIntensity: 1.38
    }));

    const diceGeo = this.createRoundedBoxGeometry(this.diceSize, this.diceSize * 0.145, 8);

    const cx = this.trayCenter.x;
    const cz = this.trayCenter.z;
    const initPos = [
      { x: cx - 1.18, z: cz - 0.58, y: this.floorY },
      { x: cx + 1.18, z: cz - 0.58, y: this.floorY },
      { x: cx + 0.0,  z: cz + 1.08, y: this.floorY }
    ];

    this.diceGroup = [];
    this.diceBodies = [];

    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(diceGeo, diceMaterials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(initPos[i].x, initPos[i].y, initPos[i].z);

      mesh.userData = {
        homePos: { ...initPos[i] },
        currentValue: 4 + i
      };

      this.scene.add(mesh);
      this.diceGroup.push(mesh);
      this.diceBodies.push({
        mesh,
        pos: mesh.position,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        targetQuat: new THREE.Quaternion(),
        lastBounceMs: 0
      });
    }

    this.setDiceFacesInstant([4, 5, 6]);
  }

  buildBowl() {
    this.bowlGroup = new THREE.Group();

    const points = [];
    for (let i = 0; i <= 24; i++) {
      const theta = (i / 24) * (Math.PI / 2);
      const r = Math.sin(theta) * 4.22;
      const y = Math.cos(theta) * 3.45;
      points.push(new THREE.Vector2(r, y));
    }
    const bowlGeo = new THREE.LatheGeometry(points, 56);
    // Translucent Smoked-Crystal Cloche during normal rolls so players SEE the dice bounce inside;
    // switches to Opaque Titanium (opacity 0.97) when "Nặn Bát 3D" is checked!
    this.bowlDomeMat = new THREE.MeshPhysicalMaterial({
      color: 0x1c1824,
      roughness: 0.14,
      metalness: 0.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.6,
      transparent: true,
      opacity: 0.36,
      side: THREE.DoubleSide
    });
    const dome = new THREE.Mesh(bowlGeo, this.bowlDomeMat);
    dome.castShadow = false;
    dome.receiveShadow = true;
    this.bowlGroup.add(dome);

    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xeac9a4,
      roughness: 0.14,
      metalness: 0.97,
      envMapIntensity: 1.55
    });

    const trimGeo = new THREE.TorusGeometry(4.23, 0.08, 16, 64);
    const trim = new THREE.Mesh(trimGeo, goldMat);
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 0.05;
    this.bowlGroup.add(trim);

    this.innerRimMat = new THREE.MeshStandardMaterial({
      color: 0xffcf87,
      emissive: 0xffa63b,
      emissiveIntensity: 0,
      roughness: 0.25,
      metalness: 0.8
    });
    const innerLipGeo = new THREE.TorusGeometry(4.11, 0.045, 12, 64);
    const innerLip = new THREE.Mesh(innerLipGeo, this.innerRimMat);
    innerLip.rotation.x = Math.PI / 2;
    innerLip.position.y = 0.08;
    this.bowlGroup.add(innerLip);

    const midRingGeo = new THREE.TorusGeometry(3.41, 0.038, 14, 64);
    const midRing = new THREE.Mesh(midRingGeo, goldMat);
    midRing.rotation.x = Math.PI / 2;
    midRing.position.y = 2.0;
    this.bowlGroup.add(midRing);

    const crownRingGeo = new THREE.TorusGeometry(1.15, 0.03, 12, 48);
    const crownRing = new THREE.Mesh(crownRingGeo, goldMat);
    crownRing.rotation.x = Math.PI / 2;
    crownRing.position.y = 3.34;
    this.bowlGroup.add(crownRing);

    const stemGeo = new THREE.CylinderGeometry(0.32, 0.56, 0.58, 24);
    const stem = new THREE.Mesh(stemGeo, goldMat);
    stem.position.y = 3.66;
    this.bowlGroup.add(stem);

    const knobGeo = new THREE.SphereGeometry(0.42, 24, 18);
    const knob = new THREE.Mesh(knobGeo, goldMat);
    knob.scale.set(1, 0.68, 1);
    knob.position.y = 4.02;
    this.bowlGroup.add(knob);

    this.bowlGroup.position.set(0, 6.9, -4.2);
    this.bowlGroup.rotation.set(-0.38, 0, 0);
    this.isBowlClosed = false;

    this.scene.add(this.bowlGroup);
  }

  setBowlOpaqueForSqueeze(isOpaque) {
    if (!this.bowlDomeMat) return;
    gsap.to(this.bowlDomeMat, {
      opacity: isOpaque ? 0.98 : 0.34,
      metalness: isOpaque ? 0.78 : 0.32,
      duration: 0.25
    });
  }

  buildSalonProps() {
    this.chipsForegroundGroup = new THREE.Group();

    const chipConfigs = [
      { color: '#b83346', accent: '#f5f2eb', label: '500K', x: -5.8, z: 2.2, count: 7 },
      { color: '#266b54', accent: '#e5c19e', label: '1M',   x: -4.6, z: 2.8, count: 4 },
      { color: '#24222c', accent: '#e5c19e', label: '5M',   x: 5.6,  z: 2.0, count: 6 },
      { color: '#c98e4b', accent: '#18161c', label: '100K', x: 4.5,  z: 2.9, count: 3 }
    ];

    const chipGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.14, 32);
    const sideMat = new THREE.MeshStandardMaterial({
      color: 0xe5c19e,
      roughness: 0.24,
      metalness: 0.82,
      envMapIntensity: 1.25
    });

    chipConfigs.forEach(stack => {
      const topTex = this.createChipTexture(stack.color, stack.accent, stack.label);
      const topMat = new THREE.MeshPhysicalMaterial({
        map: topTex,
        roughness: 0.28,
        metalness: 0.12,
        clearcoat: 0.55,
        clearcoatRoughness: 0.18,
        envMapIntensity: 1.1
      });

      for (let i = 0; i < stack.count; i++) {
        const chipMesh = new THREE.Mesh(chipGeo, [sideMat, topMat, topMat]);
        chipMesh.castShadow = true;
        chipMesh.receiveShadow = true;
        const jitterX = (Math.random() - 0.5) * 0.08;
        const jitterZ = (Math.random() - 0.5) * 0.08;
        chipMesh.position.set(
          stack.x + jitterX,
          -0.18 + i * 0.145,
          stack.z + jitterZ
        );
        chipMesh.rotation.y = Math.random() * Math.PI * 2;
        this.chipsForegroundGroup.add(chipMesh);
      }
    });

    this.scene.add(this.chipsForegroundGroup);

    this.floatingSculptures = [];
    const sculpGeo = this.createRoundedBoxGeometry(0.95, 0.15, 5);
    const sculpMat = new THREE.MeshStandardMaterial({
      color: 0xe8c7a3,
      roughness: 0.16,
      metalness: 0.95,
      envMapIntensity: 1.4
    });

    const sculpPositions = [
      { x: -7.5, y: 4.2, z: -5.5, scale: 0.85 },
      { x: 7.8,  y: 5.0, z: -6.0, scale: 1.05 },
      { x: -5.2, y: 6.8, z: -8.0, scale: 0.65 },
      { x: 6.2,  y: 2.2, z: -4.8, scale: 0.72 }
    ];

    sculpPositions.forEach((p, idx) => {
      const mesh = new THREE.Mesh(sculpGeo, sculpMat);
      mesh.position.set(p.x, p.y, p.z);
      mesh.scale.set(p.scale, p.scale, p.scale);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      mesh.userData = {
        baseY: p.y,
        phase: idx * 1.7,
        rotSpeed: 0.004 + idx * 0.0015
      };
      this.scene.add(mesh);
      this.floatingSculptures.push(mesh);
    });
  }

  buildGoldenBokeh() {
    const count = 150;
    const geo = new THREE.PlaneGeometry(0.28, 0.28);

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255, 240, 210, 0.95)');
    grad.addColorStop(0.45, 'rgba(232, 197, 150, 0.52)');
    grad.addColorStop(1, 'rgba(232, 197, 150, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();

    const bokehTex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({
      map: bokehTex,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.bokehMesh = new THREE.InstancedMesh(geo, mat, count);
    this.bokehData = [];

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 30;
      const y = Math.random() * 15 - 1;
      const z = (Math.random() - 0.5) * 18;
      const scale = 0.35 + Math.random() * 1.25;

      dummy.position.set(x, y, z);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      this.bokehMesh.setMatrixAt(i, dummy.matrix);

      this.bokehData.push({
        x, y, z, scale,
        speedY: 0.005 + Math.random() * 0.011,
        swayPhase: Math.random() * Math.PI * 2
      });
    }

    this.bokehMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.bokehMesh);
  }

  updateBokehAndProps(time) {
    if (this.bokehMesh && this.bokehMesh.visible && this.bokehMaxCount > 0) {
      const dummy = this._bokehDummy;
      const limit = Math.min(this.bokehMaxCount, this.bokehData.length);
      for (let i = 0; i < limit; i++) {
        const b = this.bokehData[i];
        b.y += b.speedY;
        if (b.y > 14) {
          b.y = -1;
          b.x = (Math.random() - 0.5) * 30;
        }
        b.x += Math.sin(time * 0.8 + b.swayPhase) * 0.007 + (this.mouse.x * 0.0035);

        dummy.position.set(b.x, b.y, b.z);
        dummy.scale.set(b.scale, b.scale, b.scale);
        dummy.updateMatrix();
        this.bokehMesh.setMatrixAt(i, dummy.matrix);
      }
      this.bokehMesh.instanceMatrix.needsUpdate = true;
    }

    this.floatingSculptures.forEach(s => {
      s.rotation.x += s.userData.rotSpeed;
      s.rotation.y += s.userData.rotSpeed * 1.2;
      s.position.y = s.userData.baseY + Math.sin(time * 1.1 + s.userData.phase) * 0.25;
    });
  }

  onMouseMove(e) {
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.mouse.targetX = x * 2.1;
    this.mouse.targetY = y * 1.15;
  }

  computeCameraFraming(width, height) {
    const safeH = Math.max(1, height);
    const aspect = width / safeH;
    if (aspect >= 1) {
      return { fov: 34, baseY: 11.4, baseZ: 16.0, lookY: 0.4, lookZ: -0.42 };
    }
    // Smoothly widen FOV and pull back + aim slightly below tray center so the 3D bowl & tray
    // sit cleanly inside the top viewport window on narrow portrait phones without horizontal clipping.
    const t = Math.min(1, Math.max(0, (1.0 - aspect) / 0.58));
    return {
      fov: 34 + t * 14,
      baseY: 11.4 + t * 3.4,
      baseZ: 16.0 + t * 6.2,
      lookY: 0.4 - t * 3.1,
      lookZ: -0.42 + t * 0.42
    };
  }

  getAlignmentQuaternionForFace(number) {
    const UP = new THREE.Vector3(0, 1, 0);
    const localNormals = {
      1: new THREE.Vector3(1, 0, 0),
      6: new THREE.Vector3(-1, 0, 0),
      2: new THREE.Vector3(0, 1, 0),
      5: new THREE.Vector3(0, -1, 0),
      3: new THREE.Vector3(0, 0, 1),
      4: new THREE.Vector3(0, 0, -1)
    };
    const n = localNormals[number] || localNormals[1];
    const qAlign = new THREE.Quaternion();
    if (number === 5) {
      qAlign.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      qAlign.setFromUnitVectors(n, UP);
    }
    return qAlign;
  }

  getQuaternionForFace(number, yawAngle = null) {
    const UP = new THREE.Vector3(0, 1, 0);
    const qAlign = this.getAlignmentQuaternionForFace(number);
    const yaw = yawAngle !== null
      ? yawAngle
      : (Math.random() * Math.PI * 2);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    return qYaw.multiply(qAlign);
  }

  /**
   * Swing-twist projection onto the world Y axis so a spinning die settles onto `number`
   * using the nearest horizontal yaw without an unnatural snap on the final frame.
   */
  getClosestQuaternionForFace(number, currentQuat) {
    const qAlign = this.getAlignmentQuaternionForFace(number);
    if (!currentQuat) return qAlign;
    const qRem = currentQuat.clone().multiply(qAlign.clone().invert());
    const qTwistY = new THREE.Quaternion(0, qRem.y, 0, qRem.w);
    if (qTwistY.lengthSq() < 1e-6) {
      return qAlign;
    }
    qTwistY.normalize();
    return qTwistY.multiply(qAlign);
  }

  computeDeterministicYaw(seed, index) {
    const s = Number(seed) || 0;
    const raw = Math.sin((s + 1) * 12.9898 + (index + 1) * 78.233) * 43758.5453;
    return (raw - Math.floor(raw)) * Math.PI * 2;
  }

  setDiceFacesInstant(diceValues, opts = {}) {
    const { preserveYaw = true, yawSeed = null } = (opts && typeof opts === 'object')
      ? opts
      : { yawSeed: opts };
    diceValues.forEach((val, i) => {
      const die = this.diceGroup[i];
      if (!die) return;
      if (preserveYaw && die.userData.currentValue === val) {
        return;
      }
      let q;
      if (yawSeed !== null && yawSeed !== undefined) {
        q = this.getQuaternionForFace(val, this.computeDeterministicYaw(yawSeed, i));
      } else if (preserveYaw) {
        q = this.getClosestQuaternionForFace(val, die.quaternion);
      } else {
        q = this.getQuaternionForFace(val);
      }
      die.quaternion.copy(q);
      die.userData.currentValue = val;
    });
  }

  setContainerTouchLock(locked) {
    if (this.container) {
      this.container.style.touchAction = locked ? 'none' : '';
      this.container.classList.toggle('is-squeezing', Boolean(locked));
    }
  }

  setGraphicsQuality(mode) {
    const valid = (mode === 'high' || mode === 'balanced' || mode === 'eco') ? mode : 'high';
    this.graphicsQuality = valid;
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.graphicsQuality = valid;
    }

    const dpr = window.devicePixelRatio || 1;
    let maxDpr = 1.5;
    let shadowsOn = true;
    let bokehCount = 150;
    let idleIntervalMs = 0;
    let activeIntervalMs = 0;

    if (valid === 'balanced') {
      maxDpr = 1.15;
      shadowsOn = true;
      bokehCount = 60;
      idleIntervalMs = 1000 / 45;
      activeIntervalMs = 0;
    } else if (valid === 'eco') {
      maxDpr = 1.0;
      shadowsOn = false;
      bokehCount = 0;
      idleIntervalMs = 1000 / 30;
      activeIntervalMs = 1000 / 30;
    }

    this._maxDpr = maxDpr;
    this.minFrameIntervalMs = idleIntervalMs;
    this.activeMinFrameIntervalMs = activeIntervalMs;
    this.bokehMaxCount = bokehCount;

    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(dpr, maxDpr));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.shadowMap.enabled = shadowsOn;
      if (shadowsOn) this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.keyLight) {
      this.keyLight.castShadow = shadowsOn;
    }
    if (this.bokehMesh) {
      this.bokehMesh.visible = bokehCount > 0;
      this.bokehMesh.count = bokehCount;
      this.bokehMesh.instanceMatrix.needsUpdate = true;
    }
  }

  closeBowl(callback, isSqueezeOpaque = false) {
    this.isBowlClosed = true;
    this.isAnimatingBowl = true;
    this.isSqueezeOpaque = Boolean(isSqueezeOpaque);
    this.setContainerTouchLock(this.isSqueezeOpaque);
    this.bowlOffset = { x: 0, z: 0 };
    if (this.squeezeRimLight) this.squeezeRimLight.intensity = 0;
    if (this.innerRimMat) this.innerRimMat.emissiveIntensity = 0;

    this.setBowlOpaqueForSqueeze(isSqueezeOpaque);

    gsap.killTweensOf(this.bowlGroup.position);
    gsap.killTweensOf(this.bowlGroup.rotation);

    gsap.to(this.bowlGroup.position, {
      x: this.trayCenter.x,
      y: 0.35,
      z: this.trayCenter.z,
      duration: 0.38,
      ease: 'power2.inOut'
    });
    gsap.to(this.bowlGroup.rotation, {
      x: 0,
      y: 0,
      z: 0,
      duration: 0.38,
      ease: 'power2.inOut',
      onComplete: () => {
        this.isAnimatingBowl = false;
        if (callback) callback();
      }
    });
  }

  shakeAndRoll(targetDice, onShakeSound, onComplete, onBounceSound, isSqueezeMode = false) {
    this.isRolling = true;

    this.closeBowl(() => {
      if (onShakeSound) onShakeSound();

      const baseAngles = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
      const spinOffset = Math.random() * Math.PI * 2;

      this.diceBodies.forEach((b, i) => {
        const a = baseAngles[i] + spinOffset;
        const r = 1.22 + Math.random() * 0.35;
        b.pos.set(
          this.trayCenter.x + Math.cos(a) * r,
          this.floorY + 0.4 + i * 0.25,
          this.trayCenter.z + Math.sin(a) * r
        );
        b.vel.set(
          -Math.sin(a) * (4.8 + Math.random() * 3.5) + (Math.random() - 0.5) * 3,
          8.2 + Math.random() * 4.0,
          Math.cos(a) * (4.8 + Math.random() * 3.5) + (Math.random() - 0.5) * 3
        );
        b.angVel.set(
          (Math.random() - 0.5) * 28,
          (Math.random() - 0.5) * 26,
          (Math.random() - 0.5) * 28
        );
        b.targetQuat = null;
        b.settleStartQuat = null;
        b.settleStartPos = null;
        b.restPos = null;
        b.mesh.userData.currentValue = targetDice[i];
        b.lastBounceMs = 0;
      });

      this.physicsState = {
        elapsed: 0,
        agitationEnd: 0.68,
        settleStart: 0.88,
        totalDuration: 1.55,
        settleTargetsLocked: false,
        nextKickIndex: 0,
        kickTimes: [0.20, 0.44],
        targetDice,
        onBounceSound: onBounceSound || ((amp) => {
          if (window.soundFX && window.soundFX.playDiceBounce) {
            window.soundFX.playDiceBounce(amp);
          }
        }),
        onComplete
      };
    }, isSqueezeMode);
  }

  stepDicePhysics(dt) {
    const ps = this.physicsState;
    if (!ps) return;

    ps.elapsed += dt;
    const t = ps.elapsed;

    if (t < ps.agitationEnd) {
      const env = Math.sin((t / ps.agitationEnd) * Math.PI);
      this.bowlGroup.position.x = this.trayCenter.x + Math.sin(t * 72) * 0.26 * env;
      this.bowlGroup.position.z = this.trayCenter.z + Math.cos(t * 62) * 0.22 * env;
      this.bowlGroup.position.y = 0.35 + Math.abs(Math.sin(t * 52)) * 0.36 * env;
      this.bowlGroup.rotation.z = Math.sin(t * 64) * 0.075 * env;
      this.bowlGroup.rotation.x = Math.cos(t * 56) * 0.065 * env;

      if (ps.nextKickIndex < ps.kickTimes.length && t >= ps.kickTimes[ps.nextKickIndex]) {
        ps.nextKickIndex++;
        this.diceBodies.forEach(b => {
          b.vel.y = Math.max(b.vel.y, 6.2 + Math.random() * 3.8);
          b.vel.x += (Math.random() - 0.5) * 6.0;
          b.vel.z += (Math.random() - 0.5) * 6.0;
          b.angVel.x += (Math.random() - 0.5) * 22;
          b.angVel.z += (Math.random() - 0.5) * 22;
        });
      }
    } else {
      this.bowlGroup.position.x += (this.trayCenter.x - this.bowlGroup.position.x) * 0.32;
      this.bowlGroup.position.z += (this.trayCenter.z - this.bowlGroup.position.z) * 0.32;
      this.bowlGroup.position.y += (0.35 - this.bowlGroup.position.y) * 0.32;
      this.bowlGroup.rotation.x *= 0.7;
      this.bowlGroup.rotation.z *= 0.7;
    }

    const settleStart = ps.settleStart || 0.88;
    const isSettling = t >= settleStart;

    if (!isSettling) {
      const SUBSTEPS = 4;
      const subDt = Math.min(dt, 0.04) / SUBSTEPS;
      const GRAVITY = -36.0;
      const MAX_CEIL_Y = this.floorY + 1.9;

      const qStep = new THREE.Quaternion();
      const axisTmp = new THREE.Vector3();
      const deltaTmp = new THREE.Vector3();

      for (let step = 0; step < SUBSTEPS; step++) {
        for (let i = 0; i < 3; i++) {
          const b = this.diceBodies[i];
          b.vel.y += GRAVITY * subDt;

          b.vel.multiplyScalar(1 - 0.45 * subDt);
          b.angVel.multiplyScalar(1 - 1.1 * subDt);

          b.pos.x += b.vel.x * subDt;
          b.pos.y += b.vel.y * subDt;
          b.pos.z += b.vel.z * subDt;

          if (b.pos.y > MAX_CEIL_Y) {
            b.pos.y = MAX_CEIL_Y;
            if (b.vel.y > 0) {
              triggerClack(b, b.vel.y * 0.7);
              b.vel.y = -b.vel.y * 0.45;
            }
          }

          if (b.pos.y < this.floorY) {
            const impact = -b.vel.y;
            b.pos.y = this.floorY;
            if (impact > 1.2) {
              triggerClack(b, impact);
              b.vel.y = impact * 0.44;
              b.angVel.x += (Math.random() - 0.5) * impact * 1.6;
              b.angVel.z += (Math.random() - 0.5) * impact * 1.6;
            } else {
              b.vel.y = 0;
            }
            const floorFriction = t > ps.agitationEnd ? (1 - 7.5 * subDt) : (1 - 2.5 * subDt);
            b.vel.x *= Math.max(0, floorFriction);
            b.vel.z *= Math.max(0, floorFriction);
            b.angVel.multiplyScalar(Math.max(0, 1 - 6.0 * subDt));
          }

          const rx = b.pos.x - this.trayCenter.x;
          const rz = b.pos.z - this.trayCenter.z;
          const distR = Math.hypot(rx, rz);
          if (distR > MAX_WALL_R) {
            const nx = rx / distR;
            const nz = rz / distR;
            b.pos.x = this.trayCenter.x + nx * MAX_WALL_R;
            b.pos.z = this.trayCenter.z + nz * MAX_WALL_R;
            const vDotN = b.vel.x * nx + b.vel.z * nz;
            if (vDotN > 0) {
              triggerClack(b, vDotN * 0.85);
              b.vel.x -= (1 + 0.52) * vDotN * nx;
              b.vel.z -= (1 + 0.52) * vDotN * nz;
            }
          }

          const wLen = b.angVel.length();
          if (wLen > 0.001) {
            axisTmp.copy(b.angVel).divideScalar(wLen);
            qStep.setFromAxisAngle(axisTmp, wLen * subDt);
            b.mesh.quaternion.premultiply(qStep).normalize();
          }
        }

        for (let i = 0; i < 3; i++) {
          for (let j = i + 1; j < 3; j++) {
            const A = this.diceBodies[i];
            const B = this.diceBodies[j];
            deltaTmp.subVectors(B.pos, A.pos);
            let dist = deltaTmp.length();

            if (dist < MIN_DICE_SEP) {
              if (dist < 1e-4) {
                deltaTmp.set(1, 0, 0);
                dist = 1e-4;
              } else {
                deltaTmp.divideScalar(dist);
              }

              const overlap = (MIN_DICE_SEP - dist) * 0.52;
              A.pos.addScaledVector(deltaTmp, -overlap);
              B.pos.addScaledVector(deltaTmp, overlap);

              if (A.pos.y < this.floorY) A.pos.y = this.floorY;
              if (B.pos.y < this.floorY) B.pos.y = this.floorY;

              const rvx = B.vel.x - A.vel.x;
              const rvy = B.vel.y - A.vel.y;
              const rvz = B.vel.z - A.vel.z;
              const velAlongNormal = rvx * deltaTmp.x + rvy * deltaTmp.y + rvz * deltaTmp.z;

              if (velAlongNormal < 0) {
                const restitution = 0.54;
                const jImp = -(1 + restitution) * velAlongNormal * 0.5;
                A.vel.addScaledVector(deltaTmp, -jImp);
                B.vel.addScaledVector(deltaTmp, jImp);

                triggerClack(A, Math.abs(velAlongNormal));

                A.angVel.x += (Math.random() - 0.5) * jImp * 2.2;
                A.angVel.z += (Math.random() - 0.5) * jImp * 2.2;
                B.angVel.x -= (Math.random() - 0.5) * jImp * 2.2;
                B.angVel.z -= (Math.random() - 0.5) * jImp * 2.2;
              }
            }
          }
        }
      }
    } else {
      if (!ps.settleTargetsLocked) {
        ps.settleTargetsLocked = true;
        // Compute non-overlapping rest positions & closest-yaw orientations once so the settle arc
        // arrives smoothly at rest with zero teleport/snap on the final frame.
        const restCoords = this.diceBodies.map((b, i) => ({
          x: b.pos.x + b.vel.x * 0.06,
          z: b.pos.z + b.vel.z * 0.06,
          startPos: b.pos.clone(),
          startQuat: b.mesh.quaternion.clone(),
          targetQuat: this.getClosestQuaternionForFace(ps.targetDice[i], b.mesh.quaternion)
        }));
        for (let iter = 0; iter < 4; iter++) {
          for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) {
              const dx = restCoords[j].x - restCoords[i].x;
              const dz = restCoords[j].z - restCoords[i].z;
              const d = Math.hypot(dx, dz) || 0.001;
              if (d < MIN_DICE_SEP) {
                const push = (MIN_DICE_SEP - d) * 0.52;
                restCoords[i].x -= (dx / d) * push;
                restCoords[i].z -= (dz / d) * push;
                restCoords[j].x += (dx / d) * push;
                restCoords[j].z += (dz / d) * push;
              }
            }
            const rx = restCoords[i].x - this.trayCenter.x;
            const rz = restCoords[i].z - this.trayCenter.z;
            const rLen = Math.hypot(rx, rz);
            if (rLen > MAX_WALL_R) {
              restCoords[i].x = this.trayCenter.x + (rx / rLen) * MAX_WALL_R;
              restCoords[i].z = this.trayCenter.z + (rz / rLen) * MAX_WALL_R;
            }
          }
        }
        this.diceBodies.forEach((b, i) => {
          b.settleStartPos = restCoords[i].startPos;
          b.settleStartQuat = restCoords[i].startQuat;
          b.targetQuat = restCoords[i].targetQuat;
          b.restPos = new THREE.Vector3(restCoords[i].x, this.floorY, restCoords[i].z);
          b.vel.set(0, 0, 0);
          b.angVel.set(0, 0, 0);
        });
      }

      const settleProgress = Math.min(1, (t - settleStart) / (ps.totalDuration - settleStart));
      const posEase = 1 - Math.pow(1 - settleProgress, 3);
      const rotEase = 1 - Math.pow(1 - settleProgress, 3);
      this.diceBodies.forEach((b) => {
        b.pos.lerpVectors(b.settleStartPos, b.restPos, posEase);
        b.mesh.quaternion.copy(b.settleStartQuat).slerp(b.targetQuat, rotEase);
      });
    }

    if (t >= ps.totalDuration) {
      this.bowlGroup.position.set(this.trayCenter.x, 0.35, this.trayCenter.z);
      this.bowlGroup.rotation.set(0, 0, 0);

      this.diceBodies.forEach(b => {
        if (b.restPos) b.pos.copy(b.restPos);
        b.pos.y = this.floorY;
        b.vel.set(0, 0, 0);
        b.angVel.set(0, 0, 0);
        if (b.targetQuat) b.mesh.quaternion.copy(b.targetQuat);
      });

      const doneCb = ps.onComplete;
      this.physicsState = null;
      this.isRolling = false;
      if (doneCb) doneCb();
    }
  }

  openBowlQuick(callback) {
    this.isBowlClosed = false;
    this.isAnimatingBowl = true;
    this.isDraggingBowl = false;
    this.isSqueezeOpaque = false;
    this.setContainerTouchLock(false);
    this.bowlOffset = { x: 0, z: 0 };

    this.setBowlOpaqueForSqueeze(false);

    if (window.soundFX && window.soundFX.playBowlRevealPop) {
      window.soundFX.playBowlRevealPop();
    }

    if (this.squeezeRimLight) {
      gsap.to(this.squeezeRimLight, { intensity: 0, duration: 0.4 });
    }
    if (this.innerRimMat) {
      gsap.to(this.innerRimMat, { emissiveIntensity: 0, duration: 0.4 });
    }

    gsap.killTweensOf(this.bowlGroup.position);
    gsap.killTweensOf(this.bowlGroup.rotation);

    gsap.to(this.bowlGroup.position, {
      x: 0,
      y: 6.9,
      z: -4.2,
      duration: 0.72,
      ease: 'back.out(1.18)'
    });
    gsap.to(this.bowlGroup.rotation, {
      x: -0.38,
      y: 0,
      z: 0,
      duration: 0.72,
      ease: 'power2.out',
      onComplete: () => {
        this.isAnimatingBowl = false;
        this._bowlOpenedAtTime = this.clock ? this.clock.elapsedTime : 0;
        if (callback) callback();
      }
    });
  }

  setupBowlDrag() {
    const REVEAL_RADIUS = 2.85;

    const getPt = (e) => {
      if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: e.clientX, y: e.clientY };
    };

    const isBlockedTarget = (target) => {
      if (typeof document !== 'undefined' && document.body.classList.contains('modal-open')) return true;
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest(
        'button, a, input, textarea, select, label, ' +
        '.bet-spot, .zen-chip, ' +
        '.matrix-drawer-backdrop, .matrix-drawer-card, ' +
        '#authModal, #adminModal, #leaderboardModal, #rulesModal, ' +
        '.modal-backdrop, .modal-card, ' +
        '.top-pill-nav, .bottom-hud-bar, .hud-center-dock, .hud-left-meta, .hud-right-eq, ' +
        '.sanctuary-bet-deck, .alabaster-card, .fairness-commit-bar, ' +
        '.squeeze-glass-toast, .center-live-banner, #toastContainer, #roundResultBanner'
      ));
    };

    const onPointerDown = (e) => {
      if (!this.isBowlClosed || this.isRolling) return;
      if (e.touches && e.touches.length > 1) return;
      if (isBlockedTarget(e.target)) return;

      this.isDraggingBowl = true;
      this.setContainerTouchLock(true);
      const pt = getPt(e);
      this.dragStart.x = pt.x;
      this.dragStart.y = pt.y;
      this.dragStartOffset.x = this.bowlOffset.x;
      this.dragStartOffset.z = this.bowlOffset.z;
    };

    const onPointerMove = (e) => {
      if (!this.isDraggingBowl || !this.isBowlClosed) return;
      if (e.cancelable) e.preventDefault();
      const pt = getPt(e);
      const dx = (pt.x - this.dragStart.x) * 0.026;
      const dz = (pt.y - this.dragStart.y) * 0.026;

      const ox = Math.max(-4.5, Math.min(4.5, this.dragStartOffset.x + dx));
      const oz = Math.max(-4.5, Math.min(4.5, this.dragStartOffset.z + dz));
      this.bowlOffset.x = ox;
      this.bowlOffset.z = oz;

      const slideDist = Math.hypot(ox, oz);
      const progress = Math.min(1, slideDist / REVEAL_RADIUS);

      this.bowlGroup.position.x = this.trayCenter.x + ox;
      this.bowlGroup.position.z = this.trayCenter.z + oz;
      this.bowlGroup.position.y = 0.35 + Math.pow(progress, 1.2) * 0.65;
      this.bowlGroup.rotation.z = -ox * 0.055;
      this.bowlGroup.rotation.x = oz * 0.055;

      if (this.squeezeRimLight) {
        this.squeezeRimLight.position.set(
          this.trayCenter.x + ox * 0.28,
          1.35,
          this.trayCenter.z + oz * 0.28
        );
        this.squeezeRimLight.intensity = progress * 5.2;
      }
      if (this.innerRimMat) {
        this.innerRimMat.emissiveIntensity = progress * 1.6;
      }

      if (this.callbacks.onSqueezeProgress) {
        this.callbacks.onSqueezeProgress(progress);
      }

      if (slideDist >= REVEAL_RADIUS) {
        this.isDraggingBowl = false;
        this.openBowlQuick(this.callbacks.onBowlOpened);
      }
    };

    const onPointerUp = () => {
      if (!this.isDraggingBowl) return;
      this.isDraggingBowl = false;
      const slideDist = Math.hypot(this.bowlOffset.x, this.bowlOffset.z);
      if (slideDist >= REVEAL_RADIUS * 0.68) {
        this.openBowlQuick(this.callbacks.onBowlOpened);
      } else {
        this.setContainerTouchLock(this.isSqueezeOpaque && this.isBowlClosed);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    window.addEventListener('touchstart', onPointerDown, { passive: true });
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('touchend', onPointerUp);
    window.addEventListener('touchcancel', onPointerUp);
  }

  onResize() {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.cameraFraming = this.computeCameraFraming(width, height);
    this.camera.fov = this.cameraFraming.fov;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._maxDpr || 1.5));
      this.renderer.setSize(width, height);
    }
  }

  pause() {
    this.isPaused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume() {
    if (typeof document !== 'undefined' && document.hidden) return;
    this.isPaused = false;
    const perfNow = (typeof performance !== 'undefined' ? performance : Date).now();
    if (this.clock) {
      this.clock.oldTime = perfNow;
    }
    this.lastFpsTime = perfNow;
    this.frameCount = 0;
    this.lastRenderTime = 0;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.animate);
    }
  }

  animate(rafTime) {
    if (this.isPaused || (typeof document !== 'undefined' && document.hidden)) {
      this.rafId = null;
      return;
    }
    this.rafId = requestAnimationFrame(this.animate);

    const frameNow = typeof rafTime === 'number' ? rafTime : performance.now();
    const minInterval = (this.physicsState || this.isDraggingBowl)
      ? this.activeMinFrameIntervalMs
      : this.minFrameIntervalMs;

    if (minInterval > 0 && this.lastRenderTime > 0 && (frameNow - this.lastRenderTime) < minInterval) {
      return;
    }
    this.lastRenderTime = frameNow;

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      const fpsEl = document.getElementById('hudFps');
      if (fpsEl) fpsEl.textContent = `${this.frameCount} FPS`;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    if (this.physicsState) {
      this.stepDicePhysics(dt);
    }

    const targetZoom = (this.isBowlClosed && (this.isDraggingBowl || Math.hypot(this.bowlOffset.x, this.bowlOffset.z) > 0.2)) ? 1 : 0;
    this.squeezeZoom += (targetZoom - this.squeezeZoom) * 0.06;

    this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.048;
    this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.048;

    const framing = this.cameraFraming || { fov: 34, baseY: 11.4, baseZ: 16.0, lookY: 0.4, lookZ: -0.42 };
    this.camera.position.x = this.mouse.x * (1 - this.squeezeZoom * 0.35);
    this.camera.position.y = (framing.baseY - this.squeezeZoom * 1.45) + this.mouse.y * (1 - this.squeezeZoom * 0.35);
    this.camera.position.z = framing.baseZ - this.squeezeZoom * 2.1;
    this.camera.lookAt(0, framing.lookY, framing.lookZ);

    this.updateBokehAndProps(time);

    if (!this.isBowlClosed && !this.isRolling && !this.isAnimatingBowl && this.bowlGroup) {
      const bobPhase = Math.max(0, time - (this._bowlOpenedAtTime || 0));
      this.bowlGroup.position.y = 6.9 + Math.sin(bobPhase * 1.6) * 0.11;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
