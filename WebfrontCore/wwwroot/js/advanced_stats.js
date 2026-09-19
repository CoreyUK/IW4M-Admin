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
    const camera = new T.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.15, 7.2);

    scene.add(new T.AmbientLight(0xffffff, 0.55));
    const key = new T.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new T.DirectionalLight(0x88aaff, 0.35);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    const rig = new T.Group();
    scene.add(rig);

    const base = new T.Color(0x3b4250);
    const hot = new T.Color(0xef4444);
    const maxPct = Math.max(window.maxPercentage || 0, 0.0001);

    const parts = {};
    function addPart(name, geometry, x, y, z, rx, ry, rz) {
        const pct = hitPercentFor(name);
        const t = Math.min(pct / maxPct, 1);
        const colour = base.clone().lerp(hot, Math.pow(t, 0.75));
        const material = new T.MeshStandardMaterial({
            color: colour,
            roughness: 0.55,
            metalness: 0.1,
            emissive: hot.clone().multiplyScalar(0.35 * t),
        });
        const mesh = new T.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx || 0, ry || 0, rz || 0);
        mesh.userData = { name: name, pct: pct, baseColour: colour.clone(), baseEmissive: material.emissive.clone() };
        rig.add(mesh);
        parts[name] = mesh;
        return mesh;
    }

    // Proportions in metres-ish; the rig is centred on the hips.
    addPart('head', new T.SphereGeometry(0.34, 24, 18), 0, 1.72, 0);
    // helmet shell sits on top of the head and shares the head's tint
    const helmet = addPart('head', new T.SphereGeometry(0.39, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, 1.76, 0);
    helmet.material.color.multiplyScalar(0.85);
    addPart('neck', new T.CylinderGeometry(0.14, 0.17, 0.22, 16), 0, 1.36, 0);
    addPart('torso_upper', new T.BoxGeometry(1.0, 0.78, 0.5, 2, 2, 2), 0, 0.86, 0);
    addPart('torso_lower', new T.BoxGeometry(0.86, 0.6, 0.46, 2, 2, 2), 0, 0.17, 0);

    // arms: the model faces the camera, so its right side is on the viewer's left
    const armX = 0.72;
    addPart('right_arm_upper', new T.CylinderGeometry(0.15, 0.13, 0.62, 14), -armX, 0.88, 0, 0, 0, 0.18);
    addPart('left_arm_upper', new T.CylinderGeometry(0.15, 0.13, 0.62, 14), armX, 0.88, 0, 0, 0, -0.18);
    addPart('right_arm_lower', new T.CylinderGeometry(0.13, 0.11, 0.6, 14), -armX - 0.1, 0.3, 0.05, 0, 0, 0.12);
    addPart('left_arm_lower', new T.CylinderGeometry(0.13, 0.11, 0.6, 14), armX + 0.1, 0.3, 0.05, 0, 0, -0.12);
    addPart('right_hand', new T.SphereGeometry(0.14, 14, 10), -armX - 0.16, -0.08, 0.08);
    addPart('left_hand', new T.SphereGeometry(0.14, 14, 10), armX + 0.16, -0.08, 0.08);

    const legX = 0.24;
    addPart('right_leg_upper', new T.CylinderGeometry(0.2, 0.17, 0.78, 14), -legX, -0.52, 0);
    addPart('left_leg_upper', new T.CylinderGeometry(0.2, 0.17, 0.78, 14), legX, -0.52, 0);
    addPart('right_leg_lower', new T.CylinderGeometry(0.16, 0.13, 0.78, 14), -legX, -1.3, 0);
    addPart('left_leg_lower', new T.CylinderGeometry(0.16, 0.13, 0.78, 14), legX, -1.3, 0);
    addPart('right_foot', new T.BoxGeometry(0.28, 0.18, 0.46), -legX, -1.76, 0.1);
    addPart('left_foot', new T.BoxGeometry(0.28, 0.18, 0.46), legX, -1.76, 0.1);

    rig.position.y = 0.05;

    // ground shadow disc
    const disc = new T.Mesh(new T.CircleGeometry(0.9, 32), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -1.86;
    scene.add(disc);

    // tooltip
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
    let hovered = null;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let spin = 0;          // user-applied yaw
    let tilt = 0;          // user-applied pitch
    let idleSpin = 0.35;   // radians per second while untouched
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
        tip.style.left = (event.clientX - container.getBoundingClientRect().left + 14) + 'px';
        tip.style.top = (event.clientY - container.getBoundingClientRect().top - 10) + 'px';
    }

    function onMove(event) {
        setPointer(event);
        if (dragging) {
            spin += (event.clientX - lastX) * 0.012;
            tilt = Math.max(-0.6, Math.min(0.6, tilt + (event.clientY - lastY) * 0.006));
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

    function prettyName(name) {
        return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function animate() {
        if (disposed) {
            return;
        }
        frame = requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.05);

        // resume the idle spin a couple of seconds after the last drag
        const idle = performance.now() - lastTouch > 2000;
        if (idle && !dragging) {
            spin += idleSpin * dt;
            tilt += (0 - tilt) * Math.min(1, dt * 2);
        }
        rig.rotation.y = spin;
        rig.rotation.x = tilt;

        // hover pick
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(rig.children, false);
        const target = hits.length ? hits[0].object : null;
        if (target !== hovered) {
            if (hovered) {
                hovered.material.color.copy(hovered.userData.baseColour);
                hovered.material.emissive.copy(hovered.userData.baseEmissive);
            }
            hovered = target;
            if (hovered) {
                hovered.material.color.copy(hovered.userData.baseColour).lerp(new T.Color(0xffffff), 0.35);
                hovered.material.emissive.set(0x666666);
                tip.textContent = prettyName(hovered.userData.name) + ' · ' + hovered.userData.pct.toFixed(1) + '%';
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
            rig.children.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
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
