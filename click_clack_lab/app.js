
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Configuration ---
const CONFIG = {
    ballRadius: 1.5,
    ballMass: 5.0,
    stringLength: 10.0,
    ballGap: 0.05, // Small gap to prevent initial overlap jitter
    gravity: -9.8,
    restitution: 0.9, // Energy loss on collision (~0.9 is good for hard plastic)
    friction: 0.1,
    linearDamping: 0.05, // Air resistance
    angularDamping: 0.05,
    fov: 45
};

// --- Globals ---
let camera, scene, renderer, controls;
let physicsWorld;
let clock;
let syncList = []; // Objects to sync graphics with physics
let sceneryList = []; // Static visual objects (no physics sync needed)
let tmpTrans; // Ammo transform helper

// Physics objects
let ball1, ball2; // The two rigid bodies
let anchor1, anchor2; // The fixed points (visual or physical)
let hinge1, hinge2; // The constraints

// Simulation State
// Simulation State
let isSimulating = false;
let releaseAngle = 45;
let currentMode = 'clickclack'; // 'clickclack' or 'pendulum'

// UI Elements
const ui = {
    releaseAngleInput: document.getElementById('releaseAngle'),
    angleVal: document.getElementById('angleVal'),
    vel1: document.getElementById('vel1'),
    vel2: document.getElementById('vel2'),
    energy: document.getElementById('energy'),
    resetBtn: document.getElementById('resetBtn'),
    startBtn: document.getElementById('startBtn'),
    experimentMode: document.getElementById('experimentMode')
};

// --- Ammo.js Initialization ---
// The Ammo() function is global injected by the script tag
if (typeof Ammo === 'function') {
    Ammo().then(function (AmmoLib) {
        if (!window.Ammo) window.Ammo = AmmoLib; // Ensure global access if needed
        tmpTrans = new Ammo.btTransform();
        init();
        animate();
    });
} else {
    console.error("Ammo.js not loaded!");
}

function init() {
    // 1. Setup Three.js
    const container = document.getElementById('container');

    clock = new THREE.Clock();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    camera = new THREE.PerspectiveCamera(CONFIG.fov, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 25);
    camera.lookAt(0, -CONFIG.stringLength / 2, 0);

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -20;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    scene.add(dirLight);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, -CONFIG.stringLength / 2, 0);

    // 2. Setup Physics World
    initPhysics();

    // 3. Create Objects (based on default mode)
    createObjects();

    // 4. UI Listeners
    setupUI();

    // Resize handler
    window.addEventListener('resize', onWindowResize);
}

function initPhysics() {
    const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration();
    const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration);
    const broadphase = new Ammo.btDbvtBroadphase();
    const solver = new Ammo.btSequentialImpulseConstraintSolver();

    physicsWorld = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration);
    physicsWorld.setGravity(new Ammo.btVector3(0, CONFIG.gravity, 0));
}

function createObjects() {
    clearScene();

    // --- Ground (Visual only) ---
    const gridHelper = new THREE.GridHelper(50, 50);
    gridHelper.position.y = -CONFIG.stringLength - CONFIG.ballRadius - 5;
    scene.add(gridHelper);
    // Track grid helper to remove it if needed, or just leave it. 
    // For simplicity, let's treat grid as permanent or add to a clear list if we want full wipe.
    // Actually, clearScene logic below depends on syncList mostly.

    // --- The Anchor Bar ---
    // We can destroy and recreate, or keep. Let's recreate to be clean.
    const barGeo = new THREE.BoxGeometry(10, 0.5, 0.5);
    const barMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(0, 0, 0);
    scene.add(bar);
    // Add to sceneryList instead of syncList
    sceneryList.push(bar);
    sceneryList.push(gridHelper);

    if (currentMode === 'clickclack') {
        createClickClackObjects();
    } else {
        createPendulumObjects();
    }
}

function clearScene() {
    // 1. Remove Scenery (Static visuals)
    for (let i = 0; i < sceneryList.length; i++) {
        const mesh = sceneryList[i];
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
    }
    sceneryList = [];

    // 2. Remove Physics Objects (syncList)
    for (let i = 0; i < syncList.length; i++) {
        const obj = syncList[i];

        // Remove Mesh
        if (obj.mesh) {
            scene.remove(obj.mesh);
            if (obj.mesh.geometry) obj.mesh.geometry.dispose();
            if (obj.mesh.material) obj.mesh.material.dispose();
        }

        // Remove String Line
        if (obj.stringLine) {
            scene.remove(obj.stringLine);
            if (obj.stringLine.geometry) obj.stringLine.geometry.dispose();
            if (obj.stringLine.material) obj.stringLine.material.dispose();
        }

        // Remove Body and Constraint
        if (obj.body) {
            physicsWorld.removeRigidBody(obj.body);
            Ammo.destroy(obj.body);
            // Note: In a full engine we'd destroy motion states, shapes etc too. 
            // For this simple script, relying on GC usually ok but explicit destroy is better for Ammo.
        }

        // Remove Constraint (we didn't store constraint reference directly in syncList, 
        // but we can track them or just know p2p is invalid if body is gone? 
        // Actually we MUST remove constraint from world before removing body)
        // Let's modify creaPendulum/ClickClack to store constraint in syncObj.
        if (obj.constraint) {
            physicsWorld.removeConstraint(obj.constraint);
            Ammo.destroy(obj.constraint);
        }

        // Remove pivot body if any
        if (obj.pivotBody) {
            physicsWorld.removeRigidBody(obj.pivotBody);
            Ammo.destroy(obj.pivotBody);
        }
    }
    syncList = [];
    ball1 = null;
    ball2 = null;
}

function createClickClackObjects() {
    const pivotPos = new THREE.Vector3(0, 0, 0);
    const startXOffset = CONFIG.ballRadius + CONFIG.ballGap;

    // Create Ball 1 (Left)
    ball1 = createPendulum(pivotPos, new THREE.Vector3(-startXOffset, -CONFIG.stringLength, 0), 0xFF0000, "Left");

    // Create Ball 2 (Right)
    ball2 = createPendulum(pivotPos, new THREE.Vector3(startXOffset, -CONFIG.stringLength, 0), 0x0000FF, "Right");
}

function createPendulumObjects() {
    const pivotPos = new THREE.Vector3(0, 0, 0);
    // Center single ball
    ball1 = createPendulum(pivotPos, new THREE.Vector3(0, -CONFIG.stringLength, 0), 0xFF0000, "Center");
    ball2 = null; // No second ball
}

function createPendulum(pivotVec3, startVec3, color, name) {
    // 1. Pivot Body (Static) - Shared or individual, but we create one per pendulum for the constraint anchor
    const pivotShape = new Ammo.btSphereShape(0.1);
    const pivotTransform = new Ammo.btTransform();
    pivotTransform.setIdentity();
    pivotTransform.setOrigin(new Ammo.btVector3(pivotVec3.x, pivotVec3.y, pivotVec3.z));
    const pivotBody = createRigidBody(0, pivotTransform, pivotShape);
    pivotBody.setActivationState(4); // DISABLE_DEACTIVATION

    // 2. Ball Body
    const ballMass = CONFIG.ballMass;
    // const startY = pivotY - CONFIG.stringLength; // OLD

    // Visuals
    const ballGeo = new THREE.SphereGeometry(CONFIG.ballRadius, 32, 32);
    const ballMat = new THREE.MeshStandardMaterial({
        color: color,
        metalness: 0.3,
        roughness: 0.2
    });
    const ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.castShadow = true;
    ballMesh.receiveShadow = true;
    scene.add(ballMesh);

    // Physics
    const ballShape = new Ammo.btSphereShape(CONFIG.ballRadius);
    const ballTransform = new Ammo.btTransform();
    ballTransform.setIdentity();
    ballTransform.setOrigin(new Ammo.btVector3(startVec3.x, startVec3.y, startVec3.z));

    const ballBody = createRigidBody(ballMass, ballTransform, ballShape);
    ballBody.setRestitution(CONFIG.restitution);
    ballBody.setFriction(CONFIG.friction);
    ballBody.setDamping(CONFIG.linearDamping, CONFIG.angularDamping);
    ballBody.setActivationState(4); // DISABLE_DEACTIVATION

    // 3. Constraint (String)
    const p2p = new Ammo.btPoint2PointConstraint(
        ballBody,
        pivotBody,
        new Ammo.btVector3(0, CONFIG.stringLength, 0), // Pivot in Ball Frame (Vector from ball center to pivot)
        new Ammo.btVector3(0, 0, 0) // Pivot in PivotBody Frame
    );

    physicsWorld.addConstraint(p2p);

    // 4. String Visual (Line)
    const stringMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    // Create a standalone line object we update manually
    const globalStringGeo = new THREE.BufferGeometry();
    const globalStringLine = new THREE.Line(globalStringGeo, stringMat);
    scene.add(globalStringLine);

    // Sync Object
    const syncObj = {
        mesh: ballMesh,
        body: ballBody,
        pivotBody: pivotBody, // Store so we can delete
        constraint: p2p,      // Store so we can delete
        pivotPos: pivotVec3.clone(), // Store the pivot
        stringLine: globalStringLine,
        name: name
    };
    syncList.push(syncObj);

    return syncObj;
}

function createRigidBody(mass, transform, shape) {
    const localInertia = new Ammo.btVector3(0, 0, 0);
    if (mass > 0) {
        shape.calculateLocalInertia(mass, localInertia);
    }

    const motionState = new Ammo.btDefaultMotionState(transform);
    const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
    const body = new Ammo.btRigidBody(rbInfo);

    physicsWorld.addRigidBody(body);
    return body;
}

function setupUI() {
    ui.releaseAngleInput.addEventListener('input', (e) => {
        ui.angleVal.textContent = e.target.value;
        releaseAngle = parseFloat(e.target.value);
    });

    ui.startBtn.addEventListener('click', () => {
        startSimulation();
    });

    ui.resetBtn.addEventListener('click', () => {
        resetSimulation();
    });

    ui.experimentMode.addEventListener('change', (e) => {
        currentMode = e.target.value;
        resetSimulation();
        createObjects(); // Recreate scene for new mode
    });
}

function resetSimulation() {
    isSimulating = false;

    syncList.forEach(obj => {
        const body = obj.body;

        // Reset velocities
        const zero = new Ammo.btVector3(0, 0, 0);
        body.setLinearVelocity(zero);
        body.setAngularVelocity(zero);

        // Reset Position
        const newTrans = new Ammo.btTransform();
        newTrans.setIdentity();

        // Reset to "hanging down" but separated to avoid explosion
        let resetX = 0;
        if (currentMode === 'clickclack') {
            const sideMultiplier = (obj.name === "Left") ? -1 : 1;
            resetX = (CONFIG.ballRadius + CONFIG.ballGap) * sideMultiplier;
        } else {
            resetX = 0;
        }

        newTrans.setOrigin(new Ammo.btVector3(
            obj.pivotPos.x + resetX,
            obj.pivotPos.y - CONFIG.stringLength,
            obj.pivotPos.z
        ));

        body.setWorldTransform(newTrans);
        body.getMotionState().setWorldTransform(newTrans);

        // Clear forces
        body.clearForces();
    });

    // Explicitly reset UI
    ui.vel1.textContent = "0.00 m/s";
    ui.vel2.textContent = "0.00 m/s";
    ui.energy.textContent = "0.00 J";
}

function startSimulation() {
    resetSimulation();

    // Apply initial angle to Left Ball (ball1)
    const rad = releaseAngle * Math.PI / 180;

    const obj = ball1; // Left ball
    const body = obj.body;

    // Current pivot pos
    const pivot = obj.pivotPos;

    const newX = pivot.x - CONFIG.stringLength * Math.sin(rad);
    const newY = pivot.y - CONFIG.stringLength * Math.cos(rad);
    const newZ = obj.pivotPos.z;

    const newTrans = new Ammo.btTransform();
    newTrans.setIdentity();
    newTrans.setOrigin(new Ammo.btVector3(newX, newY, newZ));

    body.setWorldTransform(newTrans);
    body.getMotionState().setWorldTransform(newTrans);

    // Activate
    body.setActivationState(1); // ACTIVE

    // If Click-Clack mode, we might want to mirror this to the other ball if we want symmetric start?
    // The user said "Release Ball" (singular) but in Click Clack usually you pull both?
    // The current UI says "Sudut Bola merah (deg)" which implies only Red (Left) ball.
    // So we only move ball1. Ball 2 stays hanging until hit.
    // That matches current "Newton's Cradle" style interaction.

    isSimulating = true;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();

    // Step Physics
    if (physicsWorld && isSimulating) {
        physicsWorld.stepSimulation(deltaTime, 10);
    }

    // Sync Graphics
    for (let i = 0; i < syncList.length; i++) {
        const obj = syncList[i];

        // Sync Mesh
        const body = obj.body;
        const ms = body.getMotionState();
        if (ms) {
            ms.getWorldTransform(tmpTrans);
            const p = tmpTrans.getOrigin();
            const q = tmpTrans.getRotation();

            obj.mesh.position.set(p.x(), p.y(), p.z());
            obj.mesh.quaternion.set(q.x(), q.y(), q.z(), q.w());

            // Sync String Line
            const positions = obj.stringLine.geometry.attributes.position;
            if (!positions) {
                const pts = [
                    obj.pivotPos, // Top
                    obj.mesh.position // Bottom
                ];
                obj.stringLine.geometry.setFromPoints(pts);
            } else {
                positions.setXYZ(0, obj.pivotPos.x, obj.pivotPos.y, obj.pivotPos.z);
                positions.setXYZ(1, obj.mesh.position.x, obj.mesh.position.y, obj.mesh.position.z);
                positions.needsUpdate = true;
            }

            // Update Velocity UI
            if (i === 0) {
                const v = body.getLinearVelocity();
                const speed = v.length();
                ui.vel1.textContent = speed.toFixed(2) + ' m/s';
            } else if (i === 1) {
                const v = body.getLinearVelocity();
                const speed = v.length();
                ui.vel2.textContent = speed.toFixed(2) + ' m/s';
            }
        }
    }

    // Update unused velocity slot if in pendulum mode
    if (currentMode === 'pendulum') {
        ui.vel2.textContent = "-";
    }

    let totalE = 0;
    syncList.forEach(obj => {
        const v = obj.body.getLinearVelocity().length();

        // CORRECTION: In V-shape with touching balls, they cannot reach y = -stringLength.
        // Lowest point (touching) is when x = +/- radius.
        // y_lowest = -sqrt(L^2 - radius^2)
        const L = CONFIG.stringLength;
        const R = CONFIG.ballRadius;
        // relative to pivot
        const y_lowest = -Math.sqrt(Math.max(0, L * L - R * R));
        const currentRefY = obj.mesh.position.y - obj.pivotPos.y;

        const h = currentRefY - y_lowest;

        const ke = 0.5 * CONFIG.ballMass * v * v;
        const pe = CONFIG.ballMass * 9.8 * Math.max(0, h); // prevent negative PE noise

        // Clamp to 0 if effectively stopped
        if (v < 0.05 && h < 0.05) {
            // negligible
        } else {
            totalE += (ke + pe);
        }
    });
    ui.energy.textContent = totalE.toFixed(2) + ' J';

    renderer.render(scene, camera);
    controls.update();
}
