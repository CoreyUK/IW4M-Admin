window.onresize = function () {
    if (hitModel3d) {
        hitModel3d.resize();
    } else if (window.hitLocationData) {
        drawPlayerModel();
    }
}

window.initAdvancedStats = function (history, hitLocations, maxPct, performanceText) {
    // Store globally for resize event
    window.hitLocationData = hitLocations;
    window.maxPercentage = maxPct;
    window.performanceHistory = history;

    // Setup Performance
    const chart = document.getElementById('client_performance_history');
    if (chart) {
        renderPerformanceChart(performanceText);
    }

    // Setup Hitmodel
    drawPlayerModel();
}

// ---------------------------------------------------------------------------
// 3D hit-location model
//
// Builds a low-poly soldier out of primitives, one mesh per hit location, and
// tints each part from grey to red by its share of the player's hits. Slow
// auto-rotate, drag to spin, hover a part to read the figure. three.js is
// fetched on demand (only the stats page needs it); if WebGL is unavailable
// the old 2D silhouette is drawn instead.
// ---------------------------------------------------------------------------

let hitModel3d = null;

function loadThree(callback) {
    if (window.THREE) {
        callback();
        return;
    }
    if (window.__threeLoading) {
        window.__threeLoading.push(callback);
        return;
    }
    window.__threeLoading = [callback];
    const script = document.createElement('script');
    script.src = '/js/three.min.js';
    script.onload = () => {
        const pending = window.__threeLoading;
        window.__threeLoading = null;
        pending.forEach((cb) => cb());
    };
    script.onerror = () => {
        window.__threeLoading = null;
        drawPlayerModel2d();
    };
    document.head.appendChild(script);
}

function webglAvailable() {
    try {
        const probe = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (probe.getContext('webgl') || probe.getContext('experimental-webgl')));
    } catch (e) {
        return false;
    }
}

function drawPlayerModel() {
    const canvas = document.getElementById('hitlocation_model');
    const container = document.getElementById('hitlocation_container');
    if (!canvas || !container) {
        return;
    }
    if (!webglAvailable()) {
        drawPlayerModel2d();
        return;
    }
    loadThree(() => {
        if (!document.getElementById('hitlocation_model')) {
            return; // navigated away while loading
        }
        try {
            buildHitModel3d(canvas, container);
        } catch (e) {
            console.warn('3D hit model failed, falling back to 2D', e);
            drawPlayerModel2d();
        }
    });
}

function hitPercentFor(name) {
    const data = window.hitLocationData || [];
    let total = 0;
    data.forEach((hit) => {
        // the helmet is drawn as part of the head
        if (hit.name === name || (name === 'head' && hit.name === 'helmet')) {
            total += hit.percentage;
        }
    });
    return total;
}

function buildHitModel3d(canvas, container) {
    if (hitModel3d) {
        hitModel3d.dispose();
        hitModel3d = null;
    }

    const T = window.THREE;
    const renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0.1, 7.6);

    scene.add(new T.HemisphereLight(0xdfe7ff, 0x2a2420, 0.4));
    const key = new T.DirectionalLight(0xfff1dc, 0.7);
    key.position.set(3, 6, 5);
    scene.add(key);
    const rim = new T.DirectionalLight(0x7fa6ff, 0.3);
    rim.position.set(-5, 3, -4);
    scene.add(rim);

    const rig = new T.Group();
    scene.add(rig);

    // palette
    const uniform = new T.Color(0x4a5640);   // olive fatigues
    const gear = new T.Color(0x23272e);      // vest, pouches, boots
    const metal = new T.Color(0x171a1f);     // rifle, helmet rail
    const skin = new T.Color(0x9a7358);
    const hot = new T.Color(0xf03c3c);
    const maxPct = Math.max(window.maxPercentage || 0, 0.0001);

    // one group per hit location; every mesh inside is tinted by that zone's share
    const zones = {};
    function zone(name) {
        if (!zones[name]) {
            const g = new T.Group();
            const pct = hitPercentFor(name);
            g.userData = { name: name, pct: pct, t: Math.min(pct / maxPct, 1) };
            rig.add(g);
            zones[name] = g;
        }
        return zones[name];
    }

    function tinted(baseColour, t, shade) {
        const c = baseColour.clone().multiplyScalar(shade === undefined ? 1 : shade);
        return c.lerp(hot, Math.pow(t, 1.6) * 0.9);
    }

    function part(zoneName, geometry, baseColour, x, y, z, rx, ry, rz, shade, rough) {
        const g = zone(zoneName);
        const t = g.userData.t;
        const material = new T.MeshStandardMaterial({
            color: tinted(baseColour, t, shade),
            roughness: rough === undefined ? 0.7 : rough,
            metalness: 0.08,
            emissive: hot.clone().multiplyScalar(0.22 * Math.pow(t, 1.6)),
        });
        const mesh = new T.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx || 0, ry || 0, rz || 0);
        mesh.userData.baseColour = material.color.clone();
        mesh.userData.baseEmissive = material.emissive.clone();
        mesh.userData.zone = zoneName;
        g.add(mesh);
        return mesh;
    }

    // prop meshes that belong to no zone (rifle) - drawn but not hit-tinted
    const props = new T.Group();
    rig.add(props);
    function prop(geometry, colour, x, y, z, rx, ry, rz, rough) {
        const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ color: colour, roughness: rough === undefined ? 0.5 : rough, metalness: 0.35 }));
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx || 0, ry || 0, rz || 0);
        props.add(mesh);
        return mesh;
    }

    const cap = (r, len, seg) => new T.CapsuleGeometry(r, len, 6, seg || 14);
    const box = (w, h, d) => new T.BoxGeometry(w, h, d);
    const cyl = (rt, rb, h, seg) => new T.CylinderGeometry(rt, rb, h, seg || 16);

    // ---------------- head ----------------
    part('head', new T.SphereGeometry(0.3, 26, 20), skin, 0, 1.78, 0.02);            // face/skull
    part('head', new T.SphereGeometry(0.36, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.6), gear, 0, 1.84, -0.02, 0, 0, 0, 1.15, 0.55); // helmet dome
    part('head', cyl(0.37, 0.39, 0.09, 26), gear, 0, 1.72, -0.02, 0, 0, 0, 1.0, 0.55);   // helmet brim
    part('head', box(0.4, 0.06, 0.2), gear, 0, 1.63, 0.16, 0.25, 0, 0, 0.7);             // chin strap / NVG mount shadow
    part('head', box(0.34, 0.09, 0.05), metal, 0, 1.6, 0.27, 0, 0, 0, 1.2, 0.3);         // eye pro
    part('neck', cyl(0.12, 0.15, 0.24, 16), skin, 0, 1.44, 0);

    // ---------------- torso ----------------
    part('torso_upper', cap(0.42, 0.55, 18), uniform, 0, 0.98, 0, 0, 0, 0, 1, 0.75);   // chest
    part('torso_upper', box(0.78, 0.62, 0.34), gear, 0, 0.95, 0.12, 0, 0, 0, 1, 0.8);   // plate carrier front
    part('torso_upper', box(0.78, 0.58, 0.16), gear, 0, 0.95, -0.24, 0, 0, 0, 0.85, 0.8); // back panel
    part('torso_upper', box(0.16, 0.34, 0.1), gear, -0.22, 1.0, 0.31, 0, 0, 0, 1.25);     // magazine pouches
    part('torso_upper', box(0.16, 0.34, 0.1), gear, 0, 1.0, 0.31, 0, 0, 0, 1.25);
    part('torso_upper', box(0.16, 0.34, 0.1), gear, 0.22, 1.0, 0.31, 0, 0, 0, 1.25);
    part('torso_upper', new T.SphereGeometry(0.2, 16, 12), uniform, -0.5, 1.28, 0, 0, 0, 0, 0.95); // shoulders
    part('torso_upper', new T.SphereGeometry(0.2, 16, 12), uniform, 0.5, 1.28, 0, 0, 0, 0, 0.95);
    part('torso_lower', cap(0.36, 0.3, 18), uniform, 0, 0.36, 0, 0, 0, 0, 0.95, 0.75);  // abdomen
    part('torso_lower', cyl(0.42, 0.42, 0.14, 20), gear, 0, 0.16, 0, 0, 0, 0, 1.1);      // belt
    part('torso_lower', box(0.18, 0.2, 0.14), gear, -0.32, 0.12, 0.28, 0, 0.5, 0, 1.3);  // hip pouches
    part('torso_lower', box(0.18, 0.2, 0.14), gear, 0.32, 0.12, 0.28, 0, -0.5, 0, 1.3);
    part('torso_lower', box(0.2, 0.28, 0.12), gear, 0.36, 0.1, -0.22, 0, 0, 0, 1.2);     // holster

    // ---------------- arms (model faces the camera: its right = viewer's left) ----------------
    // relaxed pose, elbows slightly bent, hands forward as if holding the rifle low
    function arm(side) {
        const s = side === 'right' ? -1 : 1;
        const up = s * 0.62;
        const g1 = part(side + '_arm_upper', cap(0.13, 0.5, 16), uniform, up, 0.98, 0.02, 0.35, 0, s * -0.18);
        part(side + '_arm_upper', cyl(0.16, 0.14, 0.14, 16), uniform, up + s * 0.02, 1.2, 0, 0, 0, s * -0.18, 0.9); // sleeve roll
        part(side + '_arm_lower', new T.SphereGeometry(0.12, 14, 10), uniform, up + s * 0.06, 0.66, 0.16, 0, 0, 0, 0.9);    // elbow
        part(side + '_arm_lower', cap(0.11, 0.42, 16), uniform, up + s * 0.05, 0.5, 0.42, 1.25, 0, s * -0.1);              // forearm forward
        part(side + '_hand', new T.SphereGeometry(0.13, 14, 10), gear, up + s * 0.02, 0.44, 0.7, 0, 0, 0, 0.9);              // glove
        part(side + '_hand', box(0.14, 0.1, 0.16), gear, up + s * 0.02, 0.4, 0.78, 0, 0, 0, 0.8);                           // fingers
        return g1;
    }
    arm('right');
    arm('left');

    // ---------------- legs ----------------
    function leg(side) {
        const s = side === 'right' ? -1 : 1;
        const x = s * 0.24;
        part(side + '_leg_upper', cap(0.19, 0.5, 16), uniform, x, -0.42, 0, 0.04, 0, s * -0.03);
        part(side + '_leg_upper', box(0.2, 0.22, 0.16), uniform, x + s * 0.12, -0.42, 0.06, 0, 0, 0, 0.85);          // cargo pocket
        part(side + '_leg_lower', new T.SphereGeometry(0.17, 14, 10), gear, x, -0.86, 0.06, 0, 0, 0, 1.2);          // knee pad
        part(side + '_leg_lower', cap(0.15, 0.5, 16), uniform, x, -1.24, 0, -0.02, 0, 0);
        part(side + '_foot', box(0.26, 0.24, 0.3), gear, x, -1.66, -0.02, 0, 0, 0, 1.0, 0.6);                        // boot upper
        part(side + '_foot', box(0.28, 0.14, 0.5), gear, x, -1.78, 0.1, 0, 0, 0, 0.8, 0.6);                         // boot sole/toe
    }
    leg('right');
    leg('left');

    // ---------------- rifle, held low across the body ----------------
    const rifle = new T.Group();
    rifle.position.set(0.05, 0.42, 0.72);
    rifle.rotation.set(0, 0, -0.35);
    rifle.rotation.y = 0.25;
    props.add(rifle);
    function rpart(geometry, colour, x, y, z, rx, ry, rz) {
        const m = new T.Mesh(geometry, new T.MeshStandardMaterial({ color: colour, roughness: 0.45, metalness: 0.5 }));
        m.position.set(x, y, z);
        m.rotation.set(rx || 0, ry || 0, rz || 0);
        rifle.add(m);
    }
    rpart(box(1.0, 0.11, 0.09), metal, 0.1, 0, 0);                 // upper receiver
    rpart(box(0.6, 0.1, 0.08), metal, -0.1, -0.1, 0);              // lower receiver
    rpart(cyl(0.028, 0.028, 0.7, 10), metal, 0.85, 0.01, 0, 0, 0, Math.PI / 2); // barrel
    rpart(box(0.42, 0.09, 0.09), gear, 0.5, 0.0, 0, 0, 0, 0);       // handguard
    rpart(box(0.08, 0.26, 0.06), metal, -0.05, -0.26, 0, 0, 0, 0.15); // magazine
    rpart(box(0.08, 0.16, 0.05), gear, -0.28, -0.2, 0, 0, 0, 0.35);   // grip
    rpart(box(0.42, 0.1, 0.07), gear, -0.62, -0.04, 0, 0, 0, 0);      // stock
    rpart(box(0.16, 0.06, 0.06), metal, 0.05, 0.09, 0);               // optic
    rpart(cyl(0.035, 0.035, 0.18, 10), metal, 0.05, 0.14, 0, 0, 0, Math.PI / 2);

    rig.position.y = 0.05;

    const disc = new T.Mesh(new T.CircleGeometry(0.95, 32), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -1.86;
    scene.add(disc);

    // ---------------- overlay elements ----------------
    let tip = container.querySelector('.hitmodel-tip');
    if (!tip) {
        tip = document.createElement('div');
        tip.className = 'hitmodel-tip';
        tip.style.cssText = 'position:absolute;pointer-events:none;padding:4px 8px;border-radius:6px;background:rgba(15,19,24,.92);border:1px solid rgba(255,255,255,.12);font:600 11px/1.3 ui-monospace,monospace;color:#fff;white-space:nowrap;opacity:0;transition:opacity .12s;z-index:5';
        container.appendChild(tip);
    }
    let hint = container.querySelector('.hitmodel-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'hitmodel-hint';
        hint.style.cssText = 'position:absolute;right:10px;bottom:8px;font:10px ui-monospace,monospace;color:rgba(255,255,255,.35);pointer-events:none';
        hint.textContent = 'drag to rotate · hover for %';
        container.appendChild(hint);
    }

    const raycaster = new T.Raycaster();
    const pointer = new T.Vector2(2, 2);
    let hoveredZone = null;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let spin = 0.35;
    let tilt = 0;
    const idleSpin = 0.3;
    let lastTouch = 0;

    function resize() {
        const width = Math.max(container.clientWidth - 16, 120);
        const height = Math.max(container.clientHeight - 16, 120);
        renderer.setSize(width, height, false);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    resize();

    function setPointer(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const crect = container.getBoundingClientRect();
        tip.style.left = (event.clientX - crect.left + 14) + 'px';
        tip.style.top = (event.clientY - crect.top - 10) + 'px';
    }
    function onMove(event) {
        setPointer(event);
        if (dragging) {
            spin += (event.clientX - lastX) * 0.012;
            tilt = Math.max(-0.5, Math.min(0.5, tilt + (event.clientY - lastY) * 0.006));
            lastX = event.clientX;
            lastY = event.clientY;
            lastTouch = performance.now();
        }
    }
    function onDown(event) {
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        lastTouch = performance.now();
        canvas.style.cursor = 'grabbing';
    }
    function onUp() {
        dragging = false;
        canvas.style.cursor = 'grab';
    }
    function onLeave() {
        pointer.set(2, 2);
        dragging = false;
        canvas.style.cursor = 'grab';
    }
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);

    const clock = new T.Clock();
    let frame = 0;
    let disposed = false;
    const zoneGroups = Object.values(zones);
    const pickables = [];
    zoneGroups.forEach((g) => g.children.forEach((m) => pickables.push(m)));

    function prettyName(name) {
        return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    function setZoneHighlight(g, on) {
        g.children.forEach((m) => {
            if (on) {
                m.material.color.copy(m.userData.baseColour).lerp(new T.Color(0xffffff), 0.3);
                m.material.emissive.set(0x555555);
            } else {
                m.material.color.copy(m.userData.baseColour);
                m.material.emissive.copy(m.userData.baseEmissive);
            }
        });
    }

    function animate() {
        if (disposed) {
            return;
        }
        frame = requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);
        const now = performance.now();

        if (!dragging && now - lastTouch > 2000) {
            spin += idleSpin * dt;
            tilt += (0 - tilt) * Math.min(1, dt * 2);
        }
        rig.rotation.y = spin;
        rig.rotation.x = tilt;
        rig.position.y = 0.05 + Math.sin(now / 900) * 0.012; // breathing

        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(pickables, false);
        const target = hits.length ? zones[hits[0].object.userData.zone] : null;
        if (target !== hoveredZone) {
            if (hoveredZone) {
                setZoneHighlight(hoveredZone, false);
            }
            hoveredZone = target;
            if (hoveredZone) {
                setZoneHighlight(hoveredZone, true);
                tip.textContent = prettyName(hoveredZone.userData.name) + ' · ' + hoveredZone.userData.pct.toFixed(1) + '%';
                tip.style.opacity = '1';
            } else {
                tip.style.opacity = '0';
            }
        }

        renderer.render(scene, camera);
    }
    animate();

    hitModel3d = {
        resize: resize,
        dispose: function () {
            disposed = true;
            cancelAnimationFrame(frame);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointerleave', onLeave);
            rig.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
            disc.geometry.dispose();
            disc.material.dispose();
            renderer.dispose();
            tip.remove();
            hint.remove();
        },
    };
}

function drawPlayerModel2d() {
    const canvas = document.getElementById('hitlocation_model');
    if (canvas === null) {
        return;
    }
    const context = canvas.getContext('2d');
    const container = document.getElementById('hitlocation_container');
    if (!container) {
        return;
    }
    const background = new Image();
    background.onload = () => {
        const backgroundRatioX = background.width / background.height;

        canvas.height = container.clientHeight - 28;
        canvas.width = (canvas.height * backgroundRatioX);

        const scalar = canvas.height / background.height;

        drawHitLocationChart(context, background, scalar, canvas.width, canvas.height);
    }
    background.src = '/images/stats/hit_location_model.jpg';
}

function buildHitLocationPosition() {
    // Ultra-precise multi-point polygon coordinates for hit_location_model.jpg (300x441)
    // Refined for exact silhouette alignment, zero gaps at joints, and smooth curves
    let hitLocations = {};

    // Head - refined helmet/head shape
    hitLocations['head'] = {
        points: [
            { x: 150, y: 22 }, { x: 138, y: 25 }, { x: 128, y: 35 }, { x: 124, y: 50 },
            { x: 124, y: 65 }, { x: 130, y: 78 }, { x: 140, y: 84 }, { x: 150, y: 86 },
            { x: 160, y: 84 }, { x: 170, y: 78 }, { x: 176, y: 65 }, { x: 176, y: 50 },
            { x: 172, y: 35 }, { x: 162, y: 25 }
        ],
        type: 'polygon'
    };

    // Torso upper - shoulders, chest, joints with arms
    hitLocations['torso_upper'] = {
        points: [
            { x: 140, y: 84 }, { x: 125, y: 75 }, { x: 105, y: 85 }, { x: 90, y: 115 },
            { x: 105, y: 145 }, { x: 115, y: 175 }, { x: 185, y: 175 }, { x: 195, y: 145 },
            { x: 210, y: 115 }, { x: 195, y: 85 }, { x: 175, y: 75 }, { x: 160, y: 84 }
        ],
        type: 'polygon'
    };

    // Torso lower - belly, hips, utility belt
    hitLocations['torso_lower'] = {
        points: [
            { x: 115, y: 175 }, { x: 95, y: 200 }, { x: 98, y: 228 }, { x: 150, y: 235 },
            { x: 202, y: 228 }, { x: 205, y: 200 }, { x: 185, y: 175 }
        ],
        type: 'polygon'
    };

    // Right arm upper (viewer's left)
    hitLocations['right_arm_upper'] = {
        points: [
            { x: 90, y: 115 }, { x: 105, y: 145 }, { x: 78, y: 165 }, { x: 45, y: 142 }, { x: 65, y: 105 }
        ],
        type: 'polygon'
    };

    // Left arm upper (viewer's right)
    hitLocations['left_arm_upper'] = {
        points: [
            { x: 210, y: 115 }, { x: 195, y: 145 }, { x: 222, y: 165 }, { x: 255, y: 142 }, { x: 235, y: 105 }
        ],
        type: 'polygon'
    };

    // Right arm lower (viewer's left)
    hitLocations['right_arm_lower'] = {
        points: [
            { x: 45, y: 142 }, { x: 78, y: 165 }, { x: 45, y: 192 }, { x: 15, y: 168 }
        ],
        type: 'polygon'
    };

    // Left arm lower (viewer's right)
    hitLocations['left_arm_lower'] = {
        points: [
            { x: 255, y: 142 }, { x: 222, y: 165 }, { x: 255, y: 192 }, { x: 285, y: 168 }
        ],
        type: 'polygon'
    };

    // Right hand (viewer's left)
    hitLocations['right_hand'] = {
        points: [
            { x: 15, y: 168 }, { x: 45, y: 192 }, { x: 40, y: 210 }, { x: 18, y: 215 }, { x: 0, y: 200 }, { x: 5, y: 170 }
        ],
        type: 'polygon'
    };

    // Left hand (viewer's right)
    hitLocations['left_hand'] = {
        points: [
            { x: 285, y: 168 }, { x: 255, y: 192 }, { x: 260, y: 210 }, { x: 282, y: 215 }, { x: 300, y: 200 }, { x: 295, y: 170 }
        ],
        type: 'polygon'
    };

    // Right leg upper (viewer's left) - thigh
    hitLocations['right_leg_upper'] = {
        points: [
            { x: 98, y: 228 }, { x: 150, y: 235 }, { x: 150, y: 310 }, { x: 95, y: 310 }, { x: 98, y: 260 }
        ],
        type: 'polygon'
    };

    // Left leg upper (viewer's right) - thigh
    hitLocations['left_leg_upper'] = {
        points: [
            { x: 202, y: 228 }, { x: 150, y: 235 }, { x: 150, y: 310 }, { x: 205, y: 310 }, { x: 202, y: 260 }
        ],
        type: 'polygon'
    };

    // Right leg lower (viewer's left) - shin
    hitLocations['right_leg_lower'] = {
        points: [
            { x: 95, y: 310 }, { x: 150, y: 310 }, { x: 150, y: 400 }, { x: 105, y: 400 }, { x: 100, y: 360 }
        ],
        type: 'polygon'
    };

    // Left leg lower (viewer's right) - shin
    hitLocations['left_leg_lower'] = {
        points: [
            { x: 205, y: 310 }, { x: 150, y: 310 }, { x: 150, y: 400 }, { x: 195, y: 400 }, { x: 200, y: 360 }
        ],
        type: 'polygon'
    };

    // Right foot (viewer's left)
    hitLocations['right_foot'] = {
        points: [
            { x: 105, y: 400 }, { x: 150, y: 400 }, { x: 150, y: 438 }, { x: 95, y: 438 }, { x: 92, y: 425 }
        ],
        type: 'polygon'
    };

    // Left foot (viewer's right)
    hitLocations['left_foot'] = {
        points: [
            { x: 195, y: 400 }, { x: 150, y: 400 }, { x: 150, y: 438 }, { x: 205, y: 438 }, { x: 208, y: 425 }
        ],
        type: 'polygon'
    };

    return hitLocations;
}

function drawHitLocationChart(context, background, scalar, width, height) {
    context.drawImage(background, 0, 0, background.width, background.height, 0, 0, width, height);

    const hitLocations = buildHitLocationPosition();

    window.hitLocationData.forEach((hit) => {
        let scaledPercentage = hit.percentage / window.maxPercentage;
        let red;
        let green = 255;

        if (scaledPercentage < 0.5) {
            red = Math.round(scaledPercentage * 255 * 2);
        } else {
            red = 255;
            green = Math.round((1 - scaledPercentage) * 255 * 2);
        }

        red = red.toString(16).padStart(2, '0');
        green = green.toString(16).padStart(2, '0');

        const color = '#' + red + green + '0077';
        const location = hitLocations[hit.name];

        if (location === undefined) {
            return;
        }

        // All locations are now polygons with variable point counts
        drawPolygon(context, scalar, location.points, color);
    });
}

function drawPolygon(context, scalar, points, color) {
    if (!points || points.length < 3) return;

    // Scale each point
    const scaledPoints = points.map(p => ({
        x: p.x * scalar,
        y: p.y * scalar
    }));

    context.beginPath();
    context.fillStyle = color;
    context.moveTo(scaledPoints[0].x, scaledPoints[0].y);

    for (let i = 1; i < scaledPoints.length; i++) {
        context.lineTo(scaledPoints[i].x, scaledPoints[i].y);
    }

    context.closePath();
    context.fill();
}

function renderPerformanceChart(performanceText) {
    const id = 'client_performance_history';
    const data = window.performanceHistory;

    if (data === undefined || data === null) {
        return;
    }

    getStatsChart(id, performanceText, data);
}
