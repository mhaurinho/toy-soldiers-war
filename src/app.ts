import { Sfx } from './audio';
import {
  BY_ID,
  CAPS,
  CATALOG,
  PRESETS,
  ROLE_LABEL,
  TEAMS,
  cloneLoadout,
  loadoutCost,
  roleCounts,
  validateLoadout,
  type Role,
  type UnitDef,
} from './data/catalog';
import { GameView } from './render/view';
import { BUDGET, CAPTURE_SECONDS, INPUT_DELAY_TICKS } from './sim/constants';
import {
  buildSpecs,
  immobileQueue,
  placementValid,
  type ManualPlacement,
  type SpawnSpec,
} from './sim/deploy';
import { generateTerrain, sampleHeight, type Terrain } from './sim/terrain';
import type { Command, Snapshot, UnitSnap } from './sim/types';

type PlayMode = 'ai' | 'hotseat';
type Screen = 'boot' | 'menu' | 'builder' | 'handoff' | 'deploy' | 'battle' | 'result' | 'error';
type Handoff = 'builder' | 'deploy0' | 'deploy1';

const ROLES: Role[] = ['infantry', 'car', 'tank', 'helicopter', 'jet', 'heavy', 'emplacement'];

type PlayerCommand =
  | { type: 'move'; ids: number[]; x: number; z: number; attackMove: boolean }
  | { type: 'attack'; ids: number[]; target: number }
  | { type: 'ground'; ids: number[]; x: number; z: number }
  | { type: 'ability'; ids: number[]; x: number; z: number }
  | { type: 'stop'; ids: number[] };

interface WorkerInit {
  type: 'init';
  seed: number;
  specs: SpawnSpec[];
  aiTeams: number[];
  openingPush: boolean;
  fastForward: number;
}

export class App {
  private readonly view: GameView;
  private readonly sfx = new Sfx();
  private readonly groups = new Map<number, number[]>();
  private readonly marquee: HTMLDivElement;

  private screen: Screen = 'boot';
  private ready = false;
  private errorText = '';
  private play: PlayMode = 'ai';
  private step: 0 | 1 = 0;
  private focus = 'fuzileiro';
  private handoff: Handoff = 'builder';
  private seed = 20261022;
  private terrain: Terrain | null = null;
  private armies: [Record<string, number>, Record<string, number>] = [
    cloneLoadout(PRESETS[0].counts),
    cloneLoadout(PRESETS[2].counts),
  ];
  private spawns: [number | null, number | null] = [null, null];
  private placed: [ManualPlacement[], ManualPlacement[]] = [[], []];
  private autoFill: [boolean, boolean] = [false, false];
  private worker: Worker | null = null;
  private snap: Snapshot | null = null;
  private paused = false;
  private armed: 'attack' | 'barrage' | null = null;
  private demo = false;
  private hoverSpawn = -1;
  private lastBoom = 0;
  private lastPick = { id: -1, at: 0 };
  private drag: { x: number; y: number; lastX: number; lastY: number; moved: boolean; touch: boolean } | null = null;
  private fingers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; ang: number; x: number; y: number } | null = null;
  private gesture: 'none' | 'pan' | 'pinch' = 'none';
  private boxArmed = false;

  constructor(private readonly root: HTMLElement, private readonly canvas: HTMLCanvasElement, fx: HTMLCanvasElement) {
    this.view = new GameView(canvas, fx);
    this.marquee = document.createElement('div');
    this.marquee.id = 'marquee';
    document.body.appendChild(this.marquee);
    this.root.addEventListener('click', (event) => this.onUi(event));
    const narrow = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
    if (narrow || navigator.maxTouchPoints > 0) document.documentElement.classList.add('touch');
    this.root.addEventListener('pointerdown', (event) => this.onMinimap(event));
    this.root.addEventListener('pointermove', (event) => this.onMinimap(event));
    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('pointerup', (event) => this.onPointerUp(event));
    window.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    window.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('gesturestart', (event) => event.preventDefault());
    this.render();
  }

  async start() {
    try {
      await document.fonts.ready;
      await this.view.init();
      this.ready = true;
      this.view.start(() => this.onFrame());
      const params = new URLSearchParams(location.search);
      if (params.has('demo') || params.has('quebra')) this.startDemo(params.has('quebra'));
      else this.goto('menu');
    } catch (err) {
      this.errorText = err instanceof Error ? err.message : 'Falha ao abrir o render 3D.';
      this.screen = 'error';
      this.render();
    }
  }

  private goto(screen: Screen) {
    this.screen = screen;
    if (!this.ready) {
      this.render();
      return;
    }
    if (screen === 'menu') {
      this.view.controlled = 0;
      this.view.setTerrain(20261022);
      this.view.setMode('menu');
      this.view.setPreview(null, 0);
    } else if (screen === 'builder') {
      this.view.controlled = this.step;
      this.view.setMode('builder');
    } else if (screen === 'handoff') {
      this.view.setPreview(null, 0);
      this.view.setShowcase([]);
      this.view.setMode('menu');
    } else if (screen === 'deploy') {
      this.view.controlled = this.step;
      this.view.setMode('deploy');
      this.view.setPreview(null, this.step);
      if (this.terrain) this.view.setTerrain(this.terrain.seed);
      this.syncDeploy();
    } else if (screen === 'battle' || screen === 'result') {
      this.view.setPreview(null, 0);
      this.view.setCursorGhost(null, 0, 0, false);
      this.view.setMode('battle');
    }
    this.render();
  }

  private begin(mode: PlayMode) {
    this.stopMatch();
    this.play = mode;
    this.step = 0;
    this.focus = 'fuzileiro';
    this.seed = (Date.now() ^ ((Math.random() * 0x7fffffff) | 0)) >>> 0;
    this.terrain = generateTerrain(this.seed);
    this.armies = [cloneLoadout(PRESETS[0].counts), cloneLoadout(PRESETS[0].counts)];
    if (mode === 'ai') {
      const options = PRESETS.filter((preset) => preset.id !== 'equilibrado');
      this.armies[1] = cloneLoadout(options[this.seed % options.length].counts);
    }
    this.spawns = [null, null];
    this.placed = [[], []];
    this.autoFill = [false, false];
    this.view.selected.clear();
    this.groups.clear();
    this.goto('builder');
  }

  private startDemo(quebra = false) {
    this.stopMatch();
    this.demo = true;
    this.play = 'ai';
    this.seed = 20261022;
    this.terrain = generateTerrain(this.seed);
    this.armies = [cloneLoadout(PRESETS[0].counts), cloneLoadout(PRESETS[2].counts)];
    this.spawns = [0, 4];
    this.placed = [[], []];
    this.autoFill = [true, true];
    this.view.controlled = 0;
    this.view.selected.clear();
    this.paused = false;
    this.goto('battle');
    this.openWorker(!quebra, quebra ? 0 : 200, quebra ? [] : [1]);
    const towerA = -Math.PI / 2 + Math.PI / 8;
    const tx = Math.cos(towerA) * 15.2;
    const tz = Math.sin(towerA) * 15.2;
    if (quebra) {
      this.view.poseCamera(tx, tz, towerA + Math.PI, 0.78, 16);
      window.setTimeout(() => {
        this.worker?.postMessage({ type: 'blast', x: tx, z: tz });
        const car = this.terrain?.props.find((prop) => prop.kind === 'car');
        if (car) this.worker?.postMessage({ type: 'blast', x: car.x, z: car.z });
        const wall = this.terrain?.props.find((prop) => prop.kind === 'wall');
        if (wall) this.worker?.postMessage({ type: 'blast', x: wall.x, z: wall.z });
      }, 1600);
    } else this.view.poseCamera(1.2, -0.4, 0.95, 0.68, 34);
  }

  private stopMatch() {
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
    this.snap = null;
    this.paused = false;
    this.armed = null;
    this.demo = false;
  }

  private openWorker(openingPush: boolean, fastForward: number, aiTeams: number[]) {
    if (!this.terrain) return;
    const terrain = this.terrain;
    const specs = [
      ...buildSpecs(terrain, this.armies[0], 0, this.spawns[0] ?? 0, this.placed[0], this.autoFill[0]),
      ...buildSpecs(terrain, this.armies[1], 1, this.spawns[1] ?? 4, this.placed[1], this.autoFill[1]),
    ];
    const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<{ type: string; snapshot?: Snapshot }>) => {
      const msg = event.data;
      if ((msg.type === 'snapshot' || msg.type === 'over') && msg.snapshot) this.onSnapshot(msg.snapshot);
      if (msg.type === 'ready' && this.demo) this.view.poseCamera(1.2, -0.4, 0.95, 0.68, 34);
    };
    worker.onerror = () => {
      this.errorText = 'A simulação em segundo plano não iniciou.';
      this.goto('error');
    };
    const init: WorkerInit = {
      type: 'init',
      seed: this.seed,
      specs,
      aiTeams,
      openingPush,
      fastForward,
    };
    worker.postMessage(init);
  }

  private onSnapshot(snapshot: Snapshot) {
    this.snap = snapshot;
    this.view.pushSnapshot(snapshot);
    const now = performance.now();
    for (const event of snapshot.fx) {
      if (event.kind === 'boom' || event.kind === 'break') {
        if (now - this.lastBoom > 70) {
          this.lastBoom = now;
          this.sfx.boom(event.kind === 'boom' ? event.size : 1.3);
        }
      } else if (event.kind === 'death') this.sfx.melt();
      else if (event.kind === 'tracer') this.sfx.shot(event.shot);
      else if (event.kind === 'muzzle') this.sfx.shot(event.shot);
    }
    this.paintHud();
    if (snapshot.over && this.screen === 'battle') {
      this.worker?.postMessage({ type: 'pause', paused: true });
      this.paused = true;
      this.goto('result');
    }
  }

  private launchBattle() {
    if (this.play === 'ai') {
      const origin = this.spawns[0] ?? 0;
      this.spawns[1] = this.farthest(origin);
      this.autoFill[1] = true;
      this.placed[1] = [];
    }
    this.paused = false;
    this.armed = null;
    this.view.controlled = 0;
    this.view.selected.clear();
    this.groups.clear();
    this.goto('battle');
    this.openWorker(false, 0, this.play === 'ai' ? [1] : []);
    const spawn = this.terrain?.spawns[this.spawns[0] ?? 0];
    if (spawn) this.view.focusSpawn(spawn.index);
  }

  private farthest(index: number): number {
    const terrain = this.terrain;
    if (!terrain) return (index + 4) % 8;
    const origin = terrain.spawns[index];
    let best = 0;
    let bestD = -1;
    terrain.spawns.forEach((spawn, i) => {
      const d = Math.hypot(spawn.x - origin.x, spawn.z - origin.z);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private render() {
    const scroll = this.root.querySelector('.catalog')?.scrollTop ?? 0;
    this.root.innerHTML = this.markup();
    const catalog = this.root.querySelector('.catalog');
    if (catalog) catalog.scrollTop = scroll;
    if (!this.ready) return;
    if (this.screen === 'builder') this.view.setPreview(this.focus, this.step);
    if (this.screen === 'deploy') this.syncDeploy();
    if (this.screen === 'battle' || this.screen === 'result') {
      const mini = this.root.querySelector('#minimap');
      if (mini instanceof HTMLCanvasElement) {
        this.view.paintMinimap(mini);
        this.view.minimapDots(this.snap, mini);
      }
      this.paintHud();
    }
  }

  private markup(): string {
    if (this.screen === 'boot') return `<div class="glass boot">Preparando a mesa…</div>`;
    if (this.screen === 'error') {
      return `<div class="panel error"><h2>A mesa não abriu</h2><p>${escapeHtml(this.errorText)}</p></div>`;
    }
    if (this.screen === 'menu') return this.menuMarkup();
    if (this.screen === 'builder') return this.builderMarkup();
    if (this.screen === 'handoff') return this.handoffMarkup();
    if (this.screen === 'deploy') return this.deployMarkup();
    if (this.screen === 'battle') return this.battleMarkup();
    if (this.screen === 'result') return `${this.battleMarkup()}${this.resultMarkup()}`;
    return '';
  }

  private menuMarkup(): string {
    return `<section class="panel menu">
      <p class="eyebrow">Paris em Ruínas · 1v1</p>
      <h1>Soldadinhos</h1>
      <p class="lede">Componha o exército e segure o morro. Carros, muros e a torre quebrada caem quando o explosivo acerta. Quem morre derrete em plástico.</p>
      <div class="swatches"><i class="swatch" style="background:${TEAMS[0].plastic}"></i> Verde <i class="swatch" style="background:${TEAMS[1].plastic}"></i> Areia</div>
      <div class="actions">
        <button class="btn gold" data-act="play" data-mode="ai" type="button">Contra a IA</button>
        <button class="btn" data-act="play" data-mode="hotseat" type="button">Dois no mesmo teclado</button>
      </div>
      <p class="fine">${this.sfx.enabled ? 'Som de brinquedo ligado.' : 'Som desligado.'} Render ${escapeHtml(this.view.backend)}.</p>
      <div class="actions">
        <button class="btn ghost tiny" data-act="sfx" type="button">${this.sfx.enabled ? 'Silenciar' : 'Ligar som'}</button>
      </div>
    </section>`;
  }

  private builderMarkup(): string {
    const counts = this.armies[this.step];
    const cost = loadoutCost(counts);
    const roles = roleCounts(counts);
    const errors = validateLoadout(counts);
    const focus = BY_ID[this.focus] ?? CATALOG[0];
    const team = TEAMS[this.step];
    const presetRow = PRESETS.map((preset) => {
      const on = sameCounts(preset.counts, counts);
      return `<button class="chip${on ? ' on' : ''}" type="button" data-act="preset" data-id="${preset.id}">${preset.name}</button>`;
    }).join('');
    const catalog = ROLES.map((role) => {
      const units = CATALOG.filter((def) => def.role === role)
        .map((def) => this.unitRow(def, counts))
        .join('');
      const cap = CAPS[role];
      const must = role === 'helicopter' || role === 'jet' ? ' · exija 1' : '';
      return `<div class="role"><span>${ROLE_LABEL[role]}${must}</span><span>${roles[role]}/${cap}</span></div>${units}`;
    }).join('');
    const who = this.play === 'hotseat' ? `${team.name} escolhe` : 'Seu exército';
    return `<section class="panel builder">
      <header>
        <p class="eyebrow">${who} · ${BUDGET} fichas</p>
        <div class="budget"><b>${cost}</b><span>restam ${Math.max(0, BUDGET - cost)}</span></div>
        <div class="presets">${presetRow}</div>
      </header>
      <div class="catalog">${catalog}</div>
      <div class="card-copy"><strong>${focus.name}</strong> — ${focus.blurb}</div>
      ${this.meters(focus)}
      ${errors.length ? `<ul class="errors">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      <div class="foot">
        <button class="btn ghost tiny" type="button" data-act="menu">Menu</button>
        <button class="btn" type="button" data-act="builder-next" ${errors.length ? 'disabled' : ''}>Levar à mesa</button>
      </div>
    </section>`;
  }

  private unitRow(def: UnitDef, counts: Record<string, number>): string {
    const n = counts[def.id] ?? 0;
    const on = def.id === this.focus ? ' on' : '';
    return `<div class="unit${on}">
      <button type="button" data-act="focus" data-id="${def.id}"><span class="name">${def.name}</span><span class="meta">${def.cost} fichas · ${def.tags.join(' · ') || ROLE_LABEL[def.role]}</span></button>
      <div class="stepper">
        <button type="button" data-act="inc" data-id="${def.id}" data-dir="-1" aria-label="Menos ${def.name}">–</button>
        <b>${n}</b>
        <button type="button" data-act="inc" data-id="${def.id}" data-dir="1" aria-label="Mais ${def.name}">+</button>
      </div>
    </div>`;
  }

  private meters(def: UnitDef): string {
    const rows: [string, number, number][] = [
      ['Vida', def.hp, 390],
      ['Andar', def.speed, 18],
      ['Olho', def.vision, 26],
    ];
    if (def.weapon) {
      rows.push(['Alcance', def.weapon.range, 34], ['Dano', def.weapon.damage, 58]);
    }
    if (def.armor > 0) rows.push(['Blindagem', def.armor, 1]);
    const body = rows
      .map(([label, value, max]) => {
        const pct = Math.round(Math.max(0, Math.min(1, value / max)) * 100);
        return `<div><span>${label}</span><span class="meter"><i style="width:${pct}%"></i></span></div>`;
      })
      .join('');
    const ability = def.ability?.id === 'barrage'
      ? '<p class="card-copy">Barragem no R: três granadas no ponto marcado.</p>'
      : def.ability?.id === 'mark'
        ? '<p class="card-copy">Marca o alvo por alguns segundos para o resto do exército.</p>'
        : def.ability?.id === 'aura'
          ? '<p class="card-copy">Quem está perto sofre um pouco menos.</p>'
          : '';
    return `<div class="meters">${body}</div>${ability}`;
  }

  private handoffMarkup(): string {
    const next = this.handoff === 'builder' ? TEAMS[1].name : this.handoff === 'deploy0' ? TEAMS[0].name : TEAMS[1].name;
    const what = this.handoff === 'builder' ? 'montar o exército' : 'escolher o posto';
    return `<section class="panel handoff">
      <p class="eyebrow">Troca de mão</p>
      <h2>Passe o teclado</h2>
      <p class="lede" style="margin-inline:auto">Agora é a vez de ${next} ${what}. A escolha anterior fica coberta.</p>
      <div class="actions" style="justify-content:center">
        <button class="btn gold" type="button" data-act="handoff">Estou pronto</button>
        <button class="btn ghost" type="button" data-act="menu">Abandonar</button>
      </div>
    </section>`;
  }

  private deployMarkup(): string {
    const team = TEAMS[this.step];
    const queue = immobileQueue(this.armies[this.step]);
    const done = this.placed[this.step].length;
    const spawn = this.spawns[this.step];
    const next = queue[done];
    const nextName = next ? BY_ID[next]?.name : '';
    const ready = spawn != null && (done >= queue.length || queue.length === 0);
    const label = this.play === 'hotseat' && this.step === 0 ? 'Entregar o posto' : 'Começar batalha';
    return `<section class="panel deploy">
      <header>
        <p class="eyebrow">${team.name} desdobra</p>
        <h2>Oito postos</h2>
      </header>
      <ol>
        <li>Clique num anel numerado. O lado oposto fica para o outro.</li>
        <li>Posicione trincheiras, sacos e armas fixas dentro do posto, ou deixe a disposição automática.</li>
        <li>O morro do centro vale a mesa se alguém de infantaria ou viatura o segurar por ${CAPTURE_SECONDS}s.</li>
      </ol>
      <p class="queue">${spawn == null ? 'Nenhum posto escolhido.' : nextName ? `Posicione ${nextName} (${done + 1}/${queue.length}).` : queue.length ? 'Posições prontas.' : 'Nada fixo para cravar.'}</p>
      <div class="foot">
        <button class="btn ghost tiny" type="button" data-act="menu">Menu</button>
        <button class="btn ghost tiny" type="button" data-act="auto-deploy" ${spawn == null ? 'disabled' : ''}>Disposição automática</button>
        <button class="btn" type="button" data-act="deploy-next" ${ready ? '' : 'disabled'}>${label}</button>
      </div>
    </section>`;
  }

  private battleMarkup(): string {
    const touch = document.documentElement.classList.contains('touch');
    const tab = this.play === 'hotseat' ? (touch ? '' : ' · <kbd>Tab</kbd> troca o lado') : '';
    const hint = touch
      ? `Toque escolhe. Toque no chão manda. Um dedo olha em volta, pinça aproxima, dois dedos giram.${this.play === 'hotseat' ? ' Trocar lado no botão.' : ''}`
      : `Esquerdo seleciona, direito ordena. <kbd>A</kbd> ataque em movimento, <kbd>S</kbd> para, <kbd>R</kbd> barragem.${tab} Setas e bordas movem a câmera. Segure o morro ou elimine o plástico inimigo.`;
    const swap = this.play === 'hotseat' ? `<button class="btn tiny" type="button" data-act="swap">Trocar</button>` : '';
    return `<div class="tools">
        <button class="btn tiny glass" type="button" data-act="pause" style="background:rgba(22,18,14,.78);color:#f6f1e6">Pausa</button>
        <button class="btn ghost tiny" type="button" data-act="sfx">${this.sfx.enabled ? 'Som' : 'Mudo'}</button>
        ${swap}
        <span class="fine">${escapeHtml(this.view.backend)}</span>
      </div>
      <div class="hud-top">
        <div class="cap" id="cap"><i class="g"></i><i class="t"></i><b id="cap-label">Morro</b></div>
        <div class="score"><span id="clock">0:00</span><span id="alive"></span></div>
      </div>
      <aside class="glass sheet" id="sheet"><p class="hint">${hint}</p></aside>
      <div class="glass miniwrap"><canvas id="minimap" width="168" height="168"></canvas></div>
      <div class="touchbar">
        <button class="btn tiny" type="button" data-act="all">Todos</button>
        <button class="btn tiny" type="button" data-act="same">Iguais</button>
        <button class="btn tiny${this.boxArmed ? ' on' : ''}" type="button" data-act="box">Área</button>
        <button class="btn tiny" type="button" data-act="stop-order">Parar</button>
        <button class="btn tiny${this.armed === 'attack' ? ' on' : ''}" type="button" data-act="arm-attack">Atacar</button>
        <button class="btn tiny${this.armed === 'barrage' ? ' on' : ''}" type="button" data-act="arm-barrage">Barragem</button>
      </div>
      <div class="pause" id="paused" hidden><p>Pausa</p></div>`;
  }

  private resultMarkup(): string {
    const snap = this.snap;
    const winner = snap?.winner ?? -1;
    const alive = snap?.alive ?? [0, 0];
    let title = 'Empate';
    let lede = 'A mesa ficou vazia.';
    if (winner === 0 || winner === 1) {
      const name = TEAMS[winner].name;
      const foe = alive[winner === 0 ? 1 : 0];
      title = `${name} vence`;
      lede = foe === 0 ? `Não sobrou combatente do outro lado.` : `${name} segurou o morro central.`;
    }
    return `<section class="panel result">
      <p class="eyebrow">Fim da partida</p>
      <h2>${title}</h2>
      <p class="lede" style="margin-inline:auto">${lede}</p>
      <div class="actions" style="justify-content:center">
        <button class="btn gold" type="button" data-act="again">Outra mesa</button>
        <button class="btn ghost" type="button" data-act="menu">Menu</button>
      </div>
    </section>`;
  }

  private paintHud() {
    if (this.screen !== 'battle' && this.screen !== 'result') return;
    const snap = this.snap;
    const cap = this.root.querySelector('#cap');
    const label = this.root.querySelector('#cap-label');
    const clock = this.root.querySelector('#clock');
    const alive = this.root.querySelector('#alive');
    const paused = this.root.querySelector('#paused');
    if (snap && cap instanceof HTMLElement) {
      const g = cap.querySelector('.g');
      const t = cap.querySelector('.t');
      if (g instanceof HTMLElement) g.style.width = `${Math.round(snap.cap[0] * 100)}%`;
      if (t instanceof HTMLElement) t.style.width = `${Math.round(snap.cap[1] * 100)}%`;
    }
    if (label) {
      label.textContent = snap?.contested ? 'Disputado' : 'Morro central';
    }
    if (clock && snap) clock.textContent = formatTime(snap.seconds);
    if (alive && snap) {
      alive.textContent = `${TEAMS[0].name} ${snap.alive[0]} · ${TEAMS[1].name} ${snap.alive[1]}`;
    }
    if (paused instanceof HTMLElement) paused.hidden = !this.paused || this.screen === 'result';
    this.root.querySelector('[data-act="box"]')?.classList.toggle('on', this.boxArmed);
    this.root.querySelector('[data-act="arm-attack"]')?.classList.toggle('on', this.armed === 'attack');
    this.root.querySelector('[data-act="arm-barrage"]')?.classList.toggle('on', this.armed === 'barrage');
    const sheet = this.root.querySelector('#sheet');
    if (sheet && this.screen === 'battle') sheet.innerHTML = this.sheetMarkup();
    const primary = this.primarySelection();
    this.view.showRange(primary);
  }

  private sheetMarkup(): string {
    const ids = [...this.view.selected];
    const units = ids
      .map((id) => this.snap?.units.find((unit) => unit.id === id))
      .filter((unit): unit is UnitSnap => !!unit && unit.death < 0);
    if (!units.length) {
      const armed = this.armed === 'attack' ? ' Ataque em movimento armado.' : this.armed === 'barrage' ? ' Barragem armada: toque o alvo.' : '';
      const touch = document.documentElement.classList.contains('touch');
      const hint = touch
        ? `Toque escolhe. Toque no chão manda. Arraste para olhar, pinça para aproximar.${armed}`
        : `Esquerdo seleciona, direito ordena. A ataca em movimento, S para, R barragem.${this.play === 'hotseat' ? ' Tab troca o lado.' : ''}${armed} O morro central fecha a partida em ${CAPTURE_SECONDS}s.`;
      return `<p class="hint">${hint}</p>`;
    }
    const first = units[0];
    const def = BY_ID[first.defId];
    const own = units.filter((unit) => unit.team === this.view.controlled).length;
    const hp = Math.round((first.hp / first.hpMax) * 100);
    const extra = units.length > 1 ? ` · ${units.length} selecionados (${own} seus)` : '';
    return `<p class="eyebrow">${TEAMS[first.team].name}${extra}</p>
      <h3>${def?.name ?? 'Peça'}</h3>
      <p class="card-copy">${def?.blurb ?? ''} Vida ${hp}%.</p>
      ${def ? this.meters(def) : ''}`;
  }

  private onUi(event: MouseEvent) {
    const target = (event.target as HTMLElement | null)?.closest('[data-act]');
    if (!(target instanceof HTMLElement)) return;
    const act = target.dataset.act;
    if (act === 'play') this.begin(target.dataset.mode === 'hotseat' ? 'hotseat' : 'ai');
    else if (act === 'menu') {
      this.stopMatch();
      this.goto('menu');
    } else if (act === 'sfx') {
      this.sfx.toggle();
      this.sfx.blip();
      this.render();
    } else if (act === 'preset') this.applyPreset(target.dataset.id ?? '');
    else if (act === 'focus') {
      this.focus = target.dataset.id ?? this.focus;
      this.render();
    } else if (act === 'inc') this.adjust(target.dataset.id ?? '', Number(target.dataset.dir ?? 0));
    else if (act === 'builder-next') this.nextAfterBuilder();
    else if (act === 'handoff') this.acceptHandoff();
    else if (act === 'auto-deploy') this.autoDeploy();
    else if (act === 'deploy-next') this.nextAfterDeploy();
    else if (act === 'pause') this.togglePause();
    else if (act === 'again') this.begin(this.play);
    else if (act === 'all') this.selectGroup('all');
    else if (act === 'same') this.selectGroup('same');
    else if (act === 'box') {
      this.boxArmed = !this.boxArmed;
      this.paintHud();
    } else if (act === 'stop-order') {
      const ids = this.ownSelected();
      if (ids.length) this.send({ type: 'stop', ids });
    } else if (act === 'arm-attack') {
      this.armed = this.armed === 'attack' ? null : 'attack';
      this.paintHud();
    } else if (act === 'arm-barrage') {
      this.armed = this.armed === 'barrage' ? null : 'barrage';
      this.paintHud();
    } else if (act === 'swap' && this.play === 'hotseat' && this.screen === 'battle') {
      this.view.controlled = this.view.controlled === 0 ? 1 : 0;
      this.view.selected.clear();
      this.armed = null;
      this.paintHud();
    }
  }

  private applyPreset(id: string) {
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset || this.screen !== 'builder') return;
    this.armies[this.step] = cloneLoadout(preset.counts);
    this.focus = Object.entries(preset.counts).find(([, n]) => n > 0)?.[0] ?? 'fuzileiro';
    this.render();
  }

  private adjust(id: string, dir: number) {
    if (this.screen !== 'builder' || !dir) return;
    const def = BY_ID[id];
    if (!def) return;
    const counts = this.armies[this.step];
    this.focus = id;
    if (dir > 0 && (def.role === 'helicopter' || def.role === 'jet')) {
      for (const other of CATALOG) {
        if (other.role === def.role) counts[other.id] = other.id === id ? 1 : 0;
      }
    } else {
      const prev = counts[id] ?? 0;
      const next = Math.max(0, prev + dir);
      counts[id] = next;
      const roles = roleCounts(counts);
      if (roles[def.role] > CAPS[def.role] || loadoutCost(counts) > BUDGET) counts[id] = prev;
    }
    this.render();
  }

  private nextAfterBuilder() {
    if (validateLoadout(this.armies[this.step]).length) return;
    if (this.play === 'hotseat' && this.step === 0) {
      this.handoff = 'builder';
      this.goto('handoff');
      return;
    }
    if (this.play === 'hotseat' && this.step === 1) {
      this.handoff = 'deploy0';
      this.goto('handoff');
      return;
    }
    this.enterDeploy(0);
  }

  private acceptHandoff() {
    if (this.handoff === 'builder') {
      this.step = 1;
      this.focus = 'fuzileiro';
      this.goto('builder');
    } else if (this.handoff === 'deploy0') this.enterDeploy(0);
    else this.enterDeploy(1);
  }

  private enterDeploy(step: 0 | 1) {
    this.step = step;
    this.hoverSpawn = -1;
    this.goto('deploy');
  }

  private autoDeploy() {
    if (this.spawns[this.step] == null) return;
    this.autoFill[this.step] = true;
    this.nextAfterDeploy();
  }

  private nextAfterDeploy() {
    const queue = immobileQueue(this.armies[this.step]);
    const filled = this.autoFill[this.step] || this.placed[this.step].length >= queue.length;
    if (this.spawns[this.step] == null || !filled) return;
    if (this.play === 'hotseat' && this.step === 0) {
      this.handoff = 'deploy1';
      this.goto('handoff');
      return;
    }
    this.launchBattle();
  }

  private syncDeploy() {
    if (!this.terrain || this.screen !== 'deploy') return;
    const taken = this.step === 1 && this.spawns[0] != null ? [this.spawns[0]] : [];
    this.view.highlightSpawns(taken, this.spawns[this.step], this.hoverSpawn >= 0 ? this.hoverSpawn : null);
    const spawnIndex = this.spawns[this.step];
    if (spawnIndex == null) {
      this.view.setShowcase([]);
      this.view.setCursorGhost(null, 0, 0, false);
      return;
    }
    const specs = buildSpecs(this.terrain, this.armies[this.step], this.step, spawnIndex, this.placed[this.step], false);
    this.view.setShowcase(specsToSnaps(specs, this.terrain));
    const queue = immobileQueue(this.armies[this.step]);
    const next = queue[this.placed[this.step].length];
    if (!next) this.view.setCursorGhost(null, 0, 0, false);
  }

  private onPointerDown(event: PointerEvent) {
    if (event.button === 1 || event.altKey) return;
    if (event.button !== 0) return;
    this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.canvas.setPointerCapture?.(event.pointerId);
    if (this.fingers.size >= 2 && (this.screen === 'battle' || this.screen === 'deploy')) {
      this.gesture = 'pinch';
      this.drag = null;
      this.marquee.style.display = 'none';
      this.pinch = this.fingerSpan();
      return;
    }
    if (this.screen === 'battle' || this.screen === 'deploy') {
      this.gesture = 'none';
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        touch: event.pointerType === 'touch',
      };
    }
  }

  private onPointerMove(event: PointerEvent) {
    if (this.fingers.has(event.pointerId)) {
      this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.gesture === 'pinch' && this.fingers.size >= 2) {
      const span = this.fingerSpan();
      if (span && this.pinch && span.dist > 8) {
        let turn = span.ang - this.pinch.ang;
        if (turn > Math.PI) turn -= Math.PI * 2;
        if (turn < -Math.PI) turn += Math.PI * 2;
        this.view.addZoom(this.pinch.dist / span.dist);
        this.view.addYaw(turn);
        this.view.panPixels(this.pinch.x - span.x, this.pinch.y - span.y);
        this.pinch = span;
      }
      return;
    }
    if (this.screen === 'deploy' && this.gesture !== 'pan') this.hoverDeploy(event.clientX, event.clientY);
    if (this.screen === 'battle' && this.gesture !== 'pan') {
      const hit = this.pick(event.clientX, event.clientY, event.pointerType === 'touch' ? 28 : 16);
      this.view.hoverId = hit?.id ?? -1;
    }
    const drag = this.drag;
    if (!drag || this.fingers.size !== 1) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 12) drag.moved = true;
    const touchPan = drag.touch && drag.moved && !this.boxArmed && (this.screen === 'battle' || this.screen === 'deploy');
    if (touchPan) {
      this.gesture = 'pan';
      this.marquee.style.display = 'none';
      this.view.panPixels(dx, dy);
      return;
    }
    if (this.screen === 'battle' && drag.moved && (!drag.touch || this.boxArmed)) {
      const x = Math.min(drag.x, event.clientX);
      const y = Math.min(drag.y, event.clientY);
      this.marquee.style.display = 'block';
      this.marquee.style.left = `${x}px`;
      this.marquee.style.top = `${y}px`;
      this.marquee.style.width = `${Math.abs(event.clientX - drag.x)}px`;
      this.marquee.style.height = `${Math.abs(event.clientY - drag.y)}px`;
    }
  }

  private onPointerUp(event: PointerEvent) {
    const wasPinch = this.gesture === 'pinch';
    this.fingers.delete(event.pointerId);
    if (wasPinch) {
      if (this.fingers.size < 2) {
        this.gesture = 'none';
        this.pinch = null;
        this.drag = null;
        this.marquee.style.display = 'none';
      }
      return;
    }
    const drag = this.drag;
    this.drag = null;
    this.marquee.style.display = 'none';
    if (this.gesture === 'pan') {
      this.gesture = 'none';
      return;
    }
    if (event.button === 2 && this.screen === 'battle') {
      this.orderAt(event.clientX, event.clientY, this.armed === 'attack', event.shiftKey);
      this.armed = null;
      this.paintHud();
      return;
    }
    if (event.button !== 0) return;
    if (this.screen === 'deploy') {
      if (drag?.moved) return;
      this.deployClick(event.clientX, event.clientY);
      return;
    }
    if (this.screen !== 'battle' || !drag) return;
    const touch = drag.touch;
    if (drag.moved && (!touch || this.boxArmed)) {
      this.boxSelect(drag.x, drag.y, event.clientX, event.clientY, event.shiftKey);
      this.boxArmed = false;
      this.armed = null;
    } else if (!drag.moved && touch) {
      this.touchTap(event.clientX, event.clientY);
    } else if (this.armed === 'attack') {
      this.orderAt(event.clientX, event.clientY, true, event.shiftKey);
      this.armed = null;
    } else if (this.armed === 'barrage') {
      this.barrageAt(event.clientX, event.clientY);
      this.armed = null;
    } else if (!drag.moved) this.selectAt(event.clientX, event.clientY, event.shiftKey);
    this.paintHud();
  }

  private touchTap(x: number, y: number) {
    const hit = this.pick(x, y, 28);
    if (this.armed === 'barrage') {
      this.barrageAt(x, y);
      this.armed = null;
      return;
    }
    if (this.armed === 'attack') {
      this.orderAt(x, y, true, false);
      this.armed = null;
      return;
    }
    if (hit && hit.team !== this.view.controlled && this.ownSelected().length) {
      this.orderAt(x, y, false, false);
      return;
    }
    if (hit) {
      this.selectAt(x, y, false, 28);
      return;
    }
    if (this.ownSelected().length) this.orderAt(x, y, false, false);
    else this.view.selected.clear();
  }

  private selectGroup(mode: 'all' | 'same') {
    if (this.screen !== 'battle') return;
    const team = this.view.controlled;
    const current = this.ownSelected();
    const sample = this.snap?.units.find((unit) => unit.id === current[0]);
    this.view.selected.clear();
    for (const unit of this.visibleUnits()) {
      if (unit.team !== team) continue;
      if (mode === 'same' && sample && unit.defId !== sample.defId) continue;
      this.view.selected.add(unit.id);
    }
    this.sfx.blip();
    this.paintHud();
  }

  private fingerSpan(): { dist: number; ang: number; x: number; y: number } | null {
    const pts = [...this.fingers.values()];
    if (pts.length < 2) return null;
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    return { dist: Math.hypot(dx, dy), ang: Math.atan2(dy, dx), x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  private hoverDeploy(x: number, y: number) {
    if (!this.terrain) return;
    const ground = this.view.groundAt(x, y);
    if (!ground) return;
    const spawn = nearestSpawn(this.terrain, ground.x, ground.z, 4.8);
    const taken = this.step === 1 && this.spawns[0] != null ? this.spawns[0] : -1;
    this.hoverSpawn = spawn != null && spawn !== taken ? spawn : -1;
    this.view.highlightSpawns(
      taken >= 0 ? [taken] : [],
      this.spawns[this.step],
      this.hoverSpawn >= 0 ? this.hoverSpawn : null,
    );
    const chosen = this.spawns[this.step];
    const queue = immobileQueue(this.armies[this.step]);
    const next = queue[this.placed[this.step].length];
    if (chosen == null || !next) {
      this.view.setCursorGhost(null, 0, 0, false);
      return;
    }
    const ok = placementValid(this.terrain, chosen, ground.x, ground.z, this.placed[this.step], next);
    const heading = this.terrain.spawns[chosen].heading;
    this.view.setCursorGhost(next, ground.x, ground.z, ok, heading);
  }

  private deployClick(x: number, y: number) {
    if (!this.terrain) return;
    const ground = this.view.groundAt(x, y);
    if (!ground) return;
    const hit = nearestSpawn(this.terrain, ground.x, ground.z, 4.8);
    const taken = this.step === 1 ? this.spawns[0] : null;
    if (hit != null && hit !== taken && (this.spawns[this.step] == null || this.placed[this.step].length === 0)) {
      this.spawns[this.step] = hit;
      this.placed[this.step] = [];
      this.autoFill[this.step] = false;
      this.view.focusSpawn(hit);
      this.render();
      return;
    }
    const chosen = this.spawns[this.step];
    if (chosen == null) return;
    const queue = immobileQueue(this.armies[this.step]);
    const next = queue[this.placed[this.step].length];
    if (!next) return;
    if (!placementValid(this.terrain, chosen, ground.x, ground.z, this.placed[this.step], next)) return;
    this.placed[this.step].push({ defId: next, x: ground.x, z: ground.z });
    this.sfx.blip();
    this.render();
  }

  private selectAt(x: number, y: number, shift: boolean, slop = 16) {
    const hit = this.pick(x, y, slop);
    const now = performance.now();
    if (!hit) {
      if (!shift) this.view.selected.clear();
      return;
    }
    const own = hit.team === this.view.controlled;
    if (own && hit.id === this.lastPick.id && now - this.lastPick.at < 320) {
      this.view.selected.clear();
      for (const unit of this.visibleUnits()) {
        if (unit.team === this.view.controlled && unit.defId === hit.defId) this.view.selected.add(unit.id);
      }
    } else if (shift) {
      if (this.view.selected.has(hit.id)) this.view.selected.delete(hit.id);
      else this.view.selected.add(hit.id);
    } else {
      this.view.selected.clear();
      this.view.selected.add(hit.id);
    }
    this.lastPick = { id: hit.id, at: now };
    this.sfx.blip();
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean) {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    if (!shift) this.view.selected.clear();
    for (const unit of this.visibleUnits()) {
      if (unit.team !== this.view.controlled) continue;
      const p = this.view.project(unit.x, unit.y + 0.8, unit.z);
      if (p.behind) continue;
      if (p.sx >= minX && p.sx <= maxX && p.sy >= minY && p.sy <= maxY) this.view.selected.add(unit.id);
    }
  }

  private orderAt(x: number, y: number, attackMove: boolean, forceMove: boolean) {
    const ids = this.ownSelected();
    if (!ids.length) return;
    const hit = this.pick(x, y);
    if (hit && hit.team !== this.view.controlled) {
      this.send({ type: 'attack', ids, target: hit.id });
      return;
    }
    const ground = this.view.groundAt(x, y);
    if (!ground) return;
    if (attackMove) {
      this.send({ type: 'move', ids, x: ground.x, z: ground.z, attackMove: true });
      return;
    }
    const movers: number[] = [];
    const guns: number[] = [];
    for (const id of ids) {
      const unit = this.snap?.units.find((item) => item.id === id);
      const def = unit ? BY_ID[unit.defId] : undefined;
      if (!def) continue;
      const planted = def.immobile && !!def.weapon;
      const indirect = !!def.weapon?.indirect && !forceMove;
      if (def.role === 'jet' || planted || indirect) guns.push(id);
      else movers.push(id);
    }
    if (movers.length) this.send({ type: 'move', ids: movers, x: ground.x, z: ground.z, attackMove: false });
    if (guns.length) this.send({ type: 'ground', ids: guns, x: ground.x, z: ground.z });
  }

  private barrageAt(x: number, y: number) {
    const ids = this.ownSelected().filter((id) => {
      const unit = this.snap?.units.find((item) => item.id === id);
      return !!unit && BY_ID[unit.defId]?.ability?.id === 'barrage';
    });
    const ground = this.view.groundAt(x, y);
    if (!ids.length || !ground) return;
    this.send({ type: 'ability', ids, x: ground.x, z: ground.z });
  }

  private send(body: PlayerCommand) {
    const team = this.view.controlled;
    const tick = (this.snap?.tick ?? 0) + INPUT_DELAY_TICKS;
    const command = { ...body, tick, team, ids: [...body.ids].sort((a, b) => a - b) } as Command;
    this.worker?.postMessage({ type: 'command', command });
    this.sfx.blip();
  }

  private ownSelected(): number[] {
    const team = this.view.controlled;
    const ids: number[] = [];
    for (const id of this.view.selected) {
      const unit = this.snap?.units.find((item) => item.id === id);
      if (unit && unit.team === team && unit.death < 0) ids.push(id);
    }
    return ids;
  }

  private primarySelection(): UnitSnap | null {
    for (const id of this.view.selected) {
      const unit = this.snap?.units.find((item) => item.id === id && item.death < 0 && item.team === this.view.controlled);
      if (unit && BY_ID[unit.defId]?.weapon) return unit;
    }
    return null;
  }

  private visibleUnits(): UnitSnap[] {
    const snap = this.snap;
    if (!snap) return [];
    return snap.units.filter((unit) => {
      if (unit.death >= 0) return false;
      if (unit.team === this.view.controlled) return true;
      return this.view.controlled === 0 ? unit.spotted0 : unit.spotted1;
    });
  }

  private pick(x: number, y: number, slop = 16): UnitSnap | null {
    let best: UnitSnap | null = null;
    let bestD = slop + 20;
    for (const unit of this.visibleUnits()) {
      const def = BY_ID[unit.defId];
      const p = this.view.project(unit.x, unit.y + (def?.eye ?? 1) * 0.45, unit.z);
      if (p.behind) continue;
      const d = Math.hypot(p.sx - x, p.sy - y);
      const rad = slop + (def?.radius ?? 0.4) * 14;
      if (d < rad && d < bestD) {
        best = unit;
        bestD = d;
      }
    }
    return best;
  }

  private onKey(event: KeyboardEvent) {
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    if (this.screen === 'battle') {
      if (key === 'p' || key === ' ') {
        event.preventDefault();
        this.togglePause();
      } else if (key === 'a') {
        this.armed = this.armed === 'attack' ? null : 'attack';
        this.paintHud();
      } else if (key === 's') {
        const ids = this.ownSelected();
        if (ids.length) this.send({ type: 'stop', ids });
      } else if (key === 'r') {
        this.armed = this.armed === 'barrage' ? null : 'barrage';
        this.paintHud();
      } else if (key === 'tab' && this.play === 'hotseat') {
        event.preventDefault();
        this.view.controlled = this.view.controlled === 0 ? 1 : 0;
        this.view.selected.clear();
        this.armed = null;
        this.paintHud();
      } else if (key === 'escape') {
        this.armed = null;
        this.view.selected.clear();
        this.paintHud();
      } else if (/^[1-9]$/.test(key)) {
        const slot = Number(key);
        if (event.ctrlKey || event.metaKey) {
          this.groups.set(slot, this.ownSelected());
        } else {
          const ids = this.groups.get(slot) ?? [];
          this.view.selected.clear();
          for (const id of ids) this.view.selected.add(id);
          const units = ids
            .map((id) => this.snap?.units.find((unit) => unit.id === id && unit.death < 0))
            .filter((unit): unit is UnitSnap => !!unit);
          if (units.length) {
            const x = units.reduce((sum, unit) => sum + unit.x, 0) / units.length;
            const z = units.reduce((sum, unit) => sum + unit.z, 0) / units.length;
            this.view.focusPoint(x, z);
          }
          this.paintHud();
        }
      }
    }
  }

  private togglePause() {
    if (this.screen !== 'battle') return;
    this.paused = !this.paused;
    this.worker?.postMessage({ type: 'pause', paused: this.paused });
    this.paintHud();
  }

  private onMinimap(event: PointerEvent) {
    if (this.screen !== 'battle' && this.screen !== 'result') return;
    const canvas = event.target instanceof HTMLCanvasElement ? event.target : null;
    if (!canvas || canvas.id !== 'minimap' || !this.terrain) return;
    if (event.type === 'pointermove' && event.buttons === 0) return;
    const rect = canvas.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    this.view.focusPoint((u * 2 - 1) * this.terrain.radius, (v * 2 - 1) * this.terrain.radius);
  }

  private onFrame() {
    if (this.screen !== 'battle' && this.screen !== 'result') return;
    const mini = this.root.querySelector('#minimap');
    if (mini instanceof HTMLCanvasElement && this.snap) this.view.minimapDots(this.snap, mini);
  }
}

function specsToSnaps(specs: SpawnSpec[], terrain: Terrain): UnitSnap[] {
  return specs
    .filter((spec) => BY_ID[spec.defId]?.role !== 'jet')
    .map((spec, index) => {
      const def = BY_ID[spec.defId];
      const ground = sampleHeight(terrain, spec.x, spec.z);
      return {
        id: index,
        team: spec.team,
        defId: spec.defId,
        x: spec.x,
        y: def.flying ? Math.max(def.altitude, ground + 3.4) : ground,
        z: spec.z,
        heading: spec.heading,
        turret: spec.heading,
        hp: def.hp,
        hpMax: def.hp,
        state: def.flying ? 'fly' : 'idle',
        spotted0: true,
        spotted1: true,
        death: -1,
        garrison: false,
        ability: 0,
      };
    });
}

function nearestSpawn(terrain: Terrain, x: number, z: number, max: number): number | null {
  let best = -1;
  let bestD = max;
  terrain.spawns.forEach((spawn, index) => {
    const d = Math.hypot(spawn.x - x, spawn.z - z);
    if (d < bestD) {
      bestD = d;
      best = index;
    }
  });
  return best < 0 ? null : best;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) if ((a[id] ?? 0) !== (b[id] ?? 0)) return false;
  return true;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
