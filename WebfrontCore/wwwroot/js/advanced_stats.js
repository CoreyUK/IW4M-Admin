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
    if (window.THREE && window.THREE.GLTFLoader) {
        callback();
        return;
    }
    if (window.__threeLoading) {
        window.__threeLoading.push(callback);
        return;
    }
    window.__threeLoading = [callback];
    const script = document.createElement('script');
    script.src = '/js/three.min.js?v=147gltf';
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
    // the API reports fractions (0.25 = 25%)
    return total * 100;
}

// Classify a vertex of a standing, A-posed humanoid into an IW4MAdmin hit
// location from its normalised position: h = height from the feet as a
// fraction of total height, d = sidewards distance from the centre line as a
// fraction of total height, side = which side of the centre line it is on.
// upper chest / abdomen / belt line, matching the game's torso_upper, torso_mid, torso_lower
function torsoZone(h) {
    if (h >= 0.67) return 'torso_upper';
    if (h >= 0.565) return 'torso_mid';
    return 'torso_lower';
}

function hitZoneForPoint(h, d, side, armReach, material) {
    const bodyHalf = 0.115;
    // the model's material names are a much better guide than raw position
    const m = (material || '').toLowerCase();
    if (m.indexOf('glove') >= 0) return side + '_hand';
    if (m.indexOf('shoe') >= 0 || m.indexOf('boot') >= 0) return side + '_foot';
    if (m.indexOf('helmet') >= 0 || m.indexOf('band') >= 0 || m.indexOf('scope') >= 0 || m.indexOf('hair') >= 0) return 'head';
    if (m.indexOf('scarf') >= 0) return 'neck';
    if (m.indexOf('vest') >= 0 || m.indexOf('pouch') >= 0) return torsoZone(h);
    if (m.indexOf('belt') >= 0) return 'torso_lower';
    if (m.indexOf('pant') >= 0 || m.indexOf('trouser') >= 0) {
        if (h >= 0.49) return 'torso_lower';
        return h >= 0.29 ? side + '_leg_upper' : side + '_leg_lower';
    }
    if (m.indexOf('skin') >= 0) {
        if (h >= 0.865) return 'head';
        if (h >= 0.8) return 'neck';
        return side + '_hand';
    }
    if (m.indexOf('shirt') >= 0 && d > 0.095 && h > 0.44 && h < 0.86) {
        const u = (d - 0.095) / Math.max(armReach - 0.095, 0.01);
        return u > 0.45 ? side + '_arm_lower' : side + '_arm_upper';
    }
    if (d > bodyHalf && h > 0.44 && h < 0.86) {
        const u = (d - bodyHalf) / Math.max(armReach - bodyHalf, 0.01);
        if (u > 0.78) return side + '_hand';
        if (u > 0.42) return side + '_arm_lower';
        return side + '_arm_upper';
    }
    if (h >= 0.865) return 'head';
    if (h >= 0.83) return 'neck';
    if (h >= 0.49) return torsoZone(h);
    if (h >= 0.29) return side + '_leg_upper';
    if (h >= 0.075) return side + '_leg_lower';
    return side + '_foot';
}

function buildHitModel3d(canvas, container) {
    if (hitModel3d) {
        hitModel3d.dispose();
        hitModel3d = null;
    }

    const T = window.THREE;
    const renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (T.sRGBEncoding !== undefined) {
        renderer.outputEncoding = T.sRGBEncoding;
    }

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(26, 1, 0.05, 100);

    scene.add(new T.HemisphereLight(0xffffff, 0x2d3a26, 0.5));
    const key = new T.DirectionalLight(0xffffff, 0.8);
    key.position.set(2.5, 4, 3);
    scene.add(key);
    const fill = new T.DirectionalLight(0xbfd4ff, 0.3);
    fill.position.set(-3, 1.5, -2.5);
    scene.add(fill);

    const rig = new T.Group();
    scene.add(rig);

    // "army man" plastic: one flat green, hit share pushes it toward red.
    // Vertex colours reach the shader as linear values, so convert the picks.
    const green = new T.Color(0x2fa35a).convertSRGBToLinear();
    const hot = new T.Color(0xf03c3c).convertSRGBToLinear();
    const white = new T.Color(0xffffff);
    const zonePct = {};
    const zoneT = {};
    const zoneNames = ['head', 'neck', 'torso_upper', 'torso_mid', 'torso_lower', 'left_arm_upper', 'right_arm_upper', 'left_arm_lower', 'right_arm_lower',
        'left_hand', 'right_hand', 'left_leg_upper', 'right_leg_upper', 'left_leg_lower', 'right_leg_lower', 'left_foot', 'right_foot'];
    zoneNames.forEach((z) => { zonePct[z] = hitPercentFor(z); });
    // scale the tint against the busiest zone, so the hottest spot is always full red
    const maxPct = Math.max(0.0001, ...zoneNames.map((z) => zonePct[z]));
    zoneNames.forEach((z) => { zoneT[z] = Math.min(zonePct[z] / maxPct, 1); });

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
        hint.style.cssText = 'position:absolute;right:10px;bottom:8px;font:10px ui-monospace,monospace;color:rgba(255,255,255,.35);pointer-events:none;text-align:right';
        hint.textContent = 'loading model…';
        container.appendChild(hint);
    }

    const painted = [];      // { mesh, zones: Int8Array per vertex }
    let hovered = null;
    let disposed = false;
    let frame = 0;

    function paint(entry, highlightZone) {
        const geom = entry.mesh.geometry;
        const count = geom.attributes.position.count;
        let colours = geom.getAttribute('color');
        if (!colours) {
            colours = new T.BufferAttribute(new Float32Array(count * 3), 3);
            geom.setAttribute('color', colours);
        }
        const c = new T.Color();
        for (let i = 0; i < count; i++) {
            const z = entry.zones[i];
            const name = z >= 0 ? zoneNames[z] : null;
            c.copy(green).lerp(hot, name ? Math.pow(zoneT[name], 1.4) * 0.92 : 0);
            if (name && name === highlightZone) c.lerp(white, 0.4);
            colours.setXYZ(i, c.r, c.g, c.b);
        }
        colours.needsUpdate = true;
    }

    const raycaster = new T.Raycaster();
    const pointer = new T.Vector2(2, 2);
    let pointerInside = false;
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
        pointerInside = true;
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
    function onDown(event) { dragging = true; lastX = event.clientX; lastY = event.clientY; lastTouch = performance.now(); canvas.style.cursor = 'grabbing'; }
    function onUp() { dragging = false; canvas.style.cursor = 'grab'; }
    function onLeave() { pointer.set(2, 2); pointerInside = false; dragging = false; canvas.style.cursor = 'grab'; }
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);

    const loader = new T.GLTFLoader();
    loader.load('/images/stats/soldier.glb?v=2', (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        // this export faces +X; turn it to face the camera (+Z) before measuring
        model.rotation.y = -Math.PI / 2;
        model.updateMatrixWorld(true);

        // measure the figure in world space
        const meshes = [];
        model.traverse((o) => { if (o.isMesh) meshes.push(o); });
        const box = new T.Box3();
        const v = new T.Vector3();
        meshes.forEach((m) => {
            const pos = m.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
                box.expandByPoint(v);
            }
        });
        const size = box.getSize(new T.Vector3());
        const centre = box.getCenter(new T.Vector3());
        const H = size.y;

        // how far the arms reach sideways, for splitting upper arm / forearm / hand
        let armReach = 0;
        meshes.forEach((m) => {
            const pos = m.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
                const h = (v.y - box.min.y) / H;
                if (h > 0.44 && h < 0.86) armReach = Math.max(armReach, Math.abs(v.x - centre.x) / H);
            }
        });

        meshes.forEach((m) => {
            const pos = m.geometry.attributes.position;
            const zones = new Int8Array(pos.count);
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
                const h = (v.y - box.min.y) / H;
                const d = Math.abs(v.x - centre.x) / H;
                // the figure faces +Z, so its right-hand side is on -X
                const side = (v.x - centre.x) < 0 ? 'right' : 'left';
                zones[i] = zoneNames.indexOf(hitZoneForPoint(h, d, side, armReach, m.material && m.material.name));
            }
            m.material = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.05 });
            const entry = { mesh: m, zones: zones };
            painted.push(entry);
            paint(entry, null);
        });

        // centre the figure at the origin with its feet on the ground disc
        model.position.set(-centre.x, -box.min.y, -centre.z);
        model.updateMatrixWorld(true);
        rig.add(model);
        rig.position.y = -H / 2;

        const dist = (H / 2) / Math.tan((camera.fov / 2) * Math.PI / 180) * 1.15;
        camera.position.set(0, 0.04 * H, dist);
        camera.lookAt(0, 0, 0);

        const disc = new T.Mesh(new T.CircleGeometry(Math.max(size.x, size.z) * 0.42, 32), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = 0.002;
        rig.add(disc);
        hint.innerHTML = 'drag to rotate · hover for %<br><span style="opacity:.7">model: madtrollstudio · CC BY</span>';
    }, undefined, (err) => {
        console.warn('soldier model failed to load', err);
        if (hitModel3d) hitModel3d.dispose();
        hitModel3d = null;
        drawPlayerModel2d();
    });

    const clock = new T.Clock();
    let pickTick = 0;

    function prettyName(name) {
        const labels = { torso_upper: 'Upper Torso', torso_mid: 'Mid Torso', torso_lower: 'Lower Torso', head: 'Head', neck: 'Neck' };
        if (labels[name]) return labels[name];
        return name.replace(/_/g, ' ').replace(/\w/g, (c) => c.toUpperCase());
    }

    function animate() {
        if (disposed) return;
        frame = requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);
        const now = performance.now();

        if (!dragging && now - lastTouch > 2000) {
            spin += idleSpin * dt;
            tilt += (0 - tilt) * Math.min(1, dt * 2);
        }
        rig.rotation.y = spin;
        rig.rotation.x = tilt;

        if (pointerInside && painted.length && (pickTick++ % 2 === 0)) {
            raycaster.setFromCamera(pointer, camera);
            const hits = raycaster.intersectObjects(painted.map((p) => p.mesh), false);
            let zone = null;
            if (hits.length && hits[0].face) {
                const entry = painted.find((p) => p.mesh === hits[0].object);
                const f = hits[0].face;
                const votes = [entry.zones[f.a], entry.zones[f.b], entry.zones[f.c]].filter((z) => z >= 0);
                if (votes.length) {
                    votes.sort((a, b) => votes.filter((x) => x === a).length - votes.filter((x) => x === b).length);
                    zone = zoneNames[votes[votes.length - 1]];
                }
            }
            if (zone !== hovered) {
                hovered = zone;
                painted.forEach((p) => paint(p, hovered));
                if (hovered) {
                    tip.textContent = prettyName(hovered) + ' · ' + zonePct[hovered].toFixed(1) + '%';
                    tip.style.opacity = '1';
                } else {
                    tip.style.opacity = '0';
                }
            }
        } else if (!pointerInside && hovered) {
            hovered = null;
            painted.forEach((p) => paint(p, null));
            tip.style.opacity = '0';
        }

        renderer.render(scene, camera);
    }
    animate();

    hitModel3d = {
        resize: resize,
        _dbg: { camera: camera, rig: rig, scene: scene },
        dispose: function () {
            disposed = true;
            cancelAnimationFrame(frame);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointerleave', onLeave);
            rig.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); if (o.material.dispose) o.material.dispose(); } });
            renderer.dispose();
            tip.remove();
            hint.remove();
        },
    };
}

function drawPlayerModel2d() {
    let canvas = document.getElementById('hitlocation_model');
    if (canvas === null) {
        return;
    }
    let context = canvas.getContext('2d');
    if (!context) {
        // the canvas was claimed by a failed WebGL attempt; swap in a fresh one
        const fresh = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(fresh, canvas);
        canvas = fresh;
        context = canvas.getContext('2d');
    }
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
