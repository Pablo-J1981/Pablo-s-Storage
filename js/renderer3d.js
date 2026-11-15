import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
    this.edgeViews = [];
    this.stationViews = [];
    this.robotGroup = new THREE.Group();
    this.scene.add(this.robotGroup);
    this.robotViews = [];
    this.graphVersion = -1;
    this.darkTheme = null;
    this.heatLow = new THREE.Color(0x22c55e);
    this.heatMiddle = new THREE.Color(0xfacc15);
    this.heatHigh = new THREE.Color(0xef4444);
    this.heatResult = new THREE.Color();
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
    this.grid.position.set(this.bounds.cx, -0.95, this.bounds.cz);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.38;
    this.mapGroup.add(this.grid);

    this.edgeViews = [];
    layout.edges.forEach((edge) => {
      const a = layout.node(edge.a), b = layout.node(edge.b);
      if (!a || !b) return;
      const dx = b.x - a.x, dz = b.y - a.y;
      const length = Math.hypot(dx, dz);
      const material = new THREE.MeshStandardMaterial({
        color: 0x64748b,
        roughness: 0.85
      });
      const road = new THREE.Mesh(
        new THREE.BoxGeometry(length, 1.4, edge.lanes > 1 ? 34 : 24),
        material
      );
      road.position.set((a.x + b.x) / 2, -0.15, (a.y + b.y) / 2);
      road.rotation.y = -Math.atan2(dz, dx);
      this.mapGroup.add(road);
      const direction = this.sim.graph.effDir(edge);
      if (direction !== 'both') {
        const from = direction === 'ab' ? a : b;
        const to = direction === 'ab' ? b : a;
        const vector = new THREE.Vector3(to.x - from.x, 0, to.y - from.y).normalize();
        const arrow = new THREE.Mesh(
          new THREE.ConeGeometry(6, 14, 3),
          new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.55 })
        );
        arrow.position.set(
          from.x + (to.x - from.x) * 0.68,
          1.2,
          from.y + (to.y - from.y) * 0.68
        );
        arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector);
        this.mapGroup.add(arrow);
      }
      this.edgeViews.push({ material, key: layout.edgeKey(edge.a, edge.b) });
    });

    this.stationViews = [];
    nodes.forEach((node) => this.addStation(node));
    this.scene.add(this.mapGroup);
    this.graphVersion = this.sim.graph.version;
    this.fitToContent();
  }

  addStation(node) {
    const group = new THREE.Group();
    group.position.set(node.x, 0, node.y);
    const color = NODE_COLORS[node.type] || NODE_COLORS.waypoint;

    if (node.type === 'waypoint') {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(4, 5, 7, 12),
        new THREE.MeshStandardMaterial({ color, roughness: 0.65 })
      );
      marker.position.y = 3;
      group.add(marker);
    } else {
      const width = node.type === 'pick' ? 56 : 52;
      const depth = node.type === 'charge' ? 32 : 38;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(width, 14, depth),
        new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.78 })
      );
      base.position.y = 7;
      group.add(base);

      const top = new THREE.Mesh(
        new THREE.BoxGeometry(width - 5, 3, depth - 5),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
      );
      top.position.y = 15.5;
      group.add(top);

      const label = this.createLabel(node.name || node.id, color);
      label.position.y = 34;
      group.add(label);
    }

    this.mapGroup.add(group);
    this.stationViews.push({ node, group });
  }

  createLabel(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.roundRect(8, 12, 496, 104, 24);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 52px Pretendard, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 64, 470);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    }));
    sprite.scale.set(72, 18, 1);
    return sprite;
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
      const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.5 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 8, 19), bodyMaterial);
      body.position.y = 4.6;
      group.add(body);

      const front = new THREE.Mesh(
        new THREE.BoxGeometry(7, 3, 5),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
      );
      front.position.set(15, 5, 0);
      group.add(front);

      const load = new THREE.Mesh(
        new THREE.BoxGeometry(11, 6, 11),
        new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.6 })
      );
      load.position.set(0, 10.6, 0);
      group.add(load);

      const batteryMaterial = new THREE.MeshStandardMaterial({ color: 0x10b981 });
      const battery = new THREE.Mesh(new THREE.BoxGeometry(16, 2, 3), batteryMaterial);
      battery.position.set(0, 10, -9);
      group.add(battery);

      this.robotGroup.add(group);
      return { id: robot.id, group, bodyMaterial, load, batteryMaterial };
    });
  }

  updateDynamicState() {
    const state = window.AMR.STATE;
    this.edgeViews.forEach((view) => {
      const congestion = this.sim.graph.congestion.get(view.key) || 0;
      const occupied = this.sim.edgeOccupancy.get(view.key);
      if (congestion > 0.05) {
        view.material.color.copy(this.heatColor(congestion));
      } else if (occupied && occupied.size) {
        view.material.color.setHex(0xf59e0b);
      } else {
        view.material.color.setHex(0x64748b);
      }
    });

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

  heatColor(value) {
    return value < 0.5
      ? this.heatResult.copy(this.heatLow).lerp(this.heatMiddle, value * 2)
      : this.heatResult.copy(this.heatMiddle).lerp(this.heatHigh, (value - 0.5) * 2);
  }

  disposeObject(object) {
    object.traverse((child) => {
      if (!child.isMesh && !child.isSprite) return;
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
