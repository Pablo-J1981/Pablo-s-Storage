import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const NODE_COLORS = {
  pick: 0x10b981,
  drop: 0xf37321,
  charge: 0xf43f5e,
  park: 0x8b5cf6,
  waypoint: 0x94a3b8
};

class Renderer3D {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'low-power'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x596579, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(-500, 900, 600);
    this.scene.add(keyLight);

    this.mapGroup = null;
    this.grid = null;
    this.robotGroup = new THREE.Group();
    this.scene.add(this.robotGroup);
    this.robotViews = [];
    this.graphVersion = -1;
    this.darkTheme = null;
    this.bounds = { cx: 0, cz: 0, width: 400, depth: 300 };

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.resize();
    this.fitToContent();
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  zoom(factor) {
    if (factor > 1) this.controls.dollyIn(factor);
    else this.controls.dollyOut(1 / factor);
    this.controls.update();
  }

  fitToContent() {
    const nodes = this.sim.layout.nodes;
    if (nodes.length) {
      const xs = nodes.map((node) => node.x);
      const zs = nodes.map((node) => node.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      this.bounds = {
        cx: (minX + maxX) / 2,
        cz: (minZ + maxZ) / 2,
        width: Math.max(200, maxX - minX),
        depth: Math.max(200, maxZ - minZ)
      };
    }

    const size = Math.max(this.bounds.width, this.bounds.depth);
    const distance = Math.max(360, size * 1.05);
    this.controls.target.set(this.bounds.cx, 0, this.bounds.cz);
    this.camera.position.set(
      this.bounds.cx + distance * 0.82,
      distance * 0.82,
      this.bounds.cz + distance
    );
    this.controls.minDistance = Math.max(40, size * 0.12);
    this.controls.maxDistance = Math.max(1200, size * 6);
    this.camera.far = Math.max(20000, distance * 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  invalidateMap() {
    this.graphVersion = -1;
  }

  draw() {
    this.syncTheme();
    if (this.graphVersion !== this.sim.graph.version) this.rebuildMap();
    this.syncRobots();
    this.updateDynamicState();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  syncTheme() {
    const dark = document.body.classList.contains('theme-dark')
      || document.body.classList.contains('theme-midnight');
    if (this.darkTheme === dark) return;
    this.darkTheme = dark;
    this.scene.background = new THREE.Color(dark ? 0x0b1220 : 0xe7edf5);
  }

  rebuildMap() {
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.disposeObject(this.mapGroup);
    }
    const layout = this.sim.layout;
    const nodes = layout.nodes;
    if (nodes.length) {
      const minX = Math.min(...nodes.map((node) => node.x));
      const maxX = Math.max(...nodes.map((node) => node.x));
      const minZ = Math.min(...nodes.map((node) => node.y));
      const maxZ = Math.max(...nodes.map((node) => node.y));
      this.bounds = {
        cx: (minX + maxX) / 2,
        cz: (minZ + maxZ) / 2,
        width: Math.max(200, maxX - minX),
        depth: Math.max(200, maxZ - minZ)
      };
    } else {
      this.bounds = { cx: 0, cz: 0, width: 400, depth: 300 };
    }

    const margin = Math.max(90, Math.max(this.bounds.width, this.bounds.depth) * 0.12);
    const floorWidth = this.bounds.width + margin * 2;
    const floorDepth = this.bounds.depth + margin * 2;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.92 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(this.bounds.cx, -1.2, this.bounds.cz);
    floor.scale.set(floorWidth, floorDepth, 1);
    this.mapGroup = new THREE.Group();
    this.mapGroup.add(floor);

    const gridSize = Math.max(floorWidth, floorDepth);
    const divisions = Math.min(120, Math.max(10, Math.round(gridSize / 40)));
    this.grid = new THREE.GridHelper(gridSize, divisions, 0x94a3b8, 0xb8c3d1);
    this.grid.position.set(this.bounds.cx, -1.08, this.bounds.cz);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.38;
    this.mapGroup.add(this.grid);

    const stationNodes = nodes.filter((node) => node.type !== 'waypoint');
    this.mapGroup.add(this.createFloorLabels(stationNodes, floorWidth, floorDepth));
    nodes.forEach((node) => {
      if (node.type !== 'waypoint') this.addStation(node);
    });
    this.scene.add(this.mapGroup);
    this.graphVersion = this.sim.graph.version;
    this.fitToContent();
  }

  addStation(node) {
    const group = new THREE.Group();
    group.position.set(node.x, 0, node.y);
    const color = NODE_COLORS[node.type] || NODE_COLORS.waypoint;
    const width = node.type === 'pick' ? 56 : 52;
    const depth = node.type === 'charge' ? 32 : 38;
    const outlineMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92
    });
    const outline = this.createRoundedWireframe(width, 12, depth, 5, outlineMaterial);
    outline.position.y = 0.2;
    group.add(outline);

    this.mapGroup.add(group);
  }

  createRoundedWireframe(width, height, depth, radius, material) {
    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const r = Math.min(radius, halfWidth, halfDepth);
    const corners = [
      { x: halfWidth - r, z: -halfDepth + r, start: -Math.PI / 2, end: 0 },
      { x: halfWidth - r, z: halfDepth - r, start: 0, end: Math.PI / 2 },
      { x: -halfWidth + r, z: halfDepth - r, start: Math.PI / 2, end: Math.PI },
      { x: -halfWidth + r, z: -halfDepth + r, start: Math.PI, end: Math.PI * 1.5 }
    ];
    const points = [];
    corners.forEach((corner) => {
      for (let i = 0; i <= 6; i += 1) {
        const angle = corner.start + (corner.end - corner.start) * i / 6;
        points.push(new THREE.Vector3(
          corner.x + Math.cos(angle) * r,
          0,
          corner.z + Math.sin(angle) * r
        ));
      }
    });

    const frame = new THREE.Group();
    [0, height].forEach((y) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map((point) => new THREE.Vector3(point.x, y, point.z))
      );
      frame.add(new THREE.LineLoop(geometry, material));
    });

    const rails = [];
    corners.forEach((corner) => {
      const angle = (corner.start + corner.end) / 2;
      const x = corner.x + Math.cos(angle) * r;
      const z = corner.z + Math.sin(angle) * r;
      rails.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, height, z));
    });
    frame.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(rails),
      material
    ));
    return frame;
  }

  createRoundedSolidBox(width, height, depth, radius, material) {
    return new THREE.Mesh(
      new RoundedBoxGeometry(width, height, depth, 4, radius),
      material
    );
  }

  createFloorLabels(nodes, floorWidth, floorDepth) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = Math.max(1024, Math.round(canvas.width * floorDepth / floorWidth));
    const ctx = canvas.getContext('2d');
    const fontSize = Math.max(50, Math.round(canvas.height * 48 / floorDepth));
    ctx.font = `600 ${fontSize}px Pretendard, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    nodes.forEach((node) => {
      const x = ((node.x - (this.bounds.cx - floorWidth / 2)) / floorWidth) * canvas.width;
      const labelZ = node.y + 44;
      const y = ((labelZ - (this.bounds.cz - floorDepth / 2)) / floorDepth) * canvas.height;
      const text = node.id || node.name;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
      ctx.fillText(text, x, y, canvas.width * 0.12);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const labels = new THREE.Mesh(
      new THREE.PlaneGeometry(floorWidth, floorDepth),
      new THREE.MeshBasicMaterial({
        map: texture,
        alphaTest: 0.1,
        depthTest: false,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        side: THREE.DoubleSide
      })
    );
    labels.rotation.x = -Math.PI / 2;
    labels.position.set(this.bounds.cx, -1.02, this.bounds.cz);
    labels.renderOrder = 1;
    return labels;
  }

  syncRobots() {
    const robots = this.sim.robots;
    const changed = robots.length !== this.robotViews.length
      || robots.some((robot, index) => this.robotViews[index].id !== robot.id);
    if (!changed) return;

    this.robotGroup.children.forEach((child) => this.disposeObject(child));
    this.robotGroup.clear();
    this.robotViews = robots.map((robot) => {
      const group = new THREE.Group();
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        roughness: 0.42,
        metalness: 0.15
      });
      const body = this.createRoundedSolidBox(28, 8, 19, 4, bodyMaterial);
      body.position.y = 5.5;
      group.add(body);

      const front = this.createRoundedSolidBox(
        2,
        3,
        10,
        0.9,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.1 })
      );
      front.position.set(15, 5.5, 0);
      group.add(front);

      const loadMaterial = new THREE.MeshStandardMaterial({
        color: 0xfbbf24,
        roughness: 0.5,
        metalness: 0.05
      });
      const load = this.createRoundedSolidBox(12, 6, 12, 2.5, loadMaterial);
      load.position.set(0, 13, 0);
      group.add(load);

      const batteryMaterial = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        roughness: 0.45,
        metalness: 0.1
      });
      const battery = this.createRoundedSolidBox(16, 2, 3, 0.9, batteryMaterial);
      battery.position.set(0, 10.5, -8);
      group.add(battery);

      this.robotGroup.add(group);
      return { id: robot.id, group, bodyMaterial, load, batteryMaterial };
    });
  }

  updateDynamicState() {
    const state = window.AMR.STATE;
    this.robotViews.forEach((view, index) => {
      const robot = this.sim.robots[index];
      if (!robot) return;
      const charging = robot.state === state.CHARGING || robot.state === state.TO_CHARGE;
      const faulted = robot.state === state.FAULT;
      const blocked = robot.speed < 0.05
        && (robot.state === state.TO_PICK || robot.state === state.TO_DROP);
      view.bodyMaterial.color.setHex(
        faulted ? 0x7c2d12 : charging ? 0xe11d48 : blocked ? 0xef4444 : robot.cargo > 0 ? 0xf37321 : 0x2563eb
      );
      view.load.visible = robot.cargo > 0;
      view.batteryMaterial.color.setHex(
        robot.soc <= this.sim.params.bat_min ? 0xef4444
          : robot.soc >= this.sim.params.bat_max ? 0x10b981 : 0xf59e0b
      );
      view.group.position.set(robot.x, 0, robot.y);
      view.group.rotation.y = -robot.heading;
    });
  }

  disposeObject(object) {
    object.traverse((child) => {
      if (!child.isMesh && !child.isSprite && !child.isLine) return;
      if (child.geometry) child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
  }
}

export function createRenderer3D(canvas, sim) {
  return new Renderer3D(canvas, sim);
}
