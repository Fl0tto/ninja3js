import type { FluidFire, FluidFireParameters } from './FluidFire';
import type { GroundFlowMaterialPreset } from './GroundFlowVolume';

export interface BenchmarkSettings {
  resolution: number;
  particleCount: number;
}

export interface BenchmarkMetrics {
  fps: number;
  cpuMs: number;
  computeGpuMs?: number;
  renderGpuMs?: number;
  dispatches: number;
  memoryMb: number;
}

interface BenchmarkUICallbacks {
  onRebuild(settings: BenchmarkSettings): void;
  onPauseChange(paused: boolean): void;
  onMaterialPresetChange(preset: GroundFlowMaterialPreset): void;
}

interface RangeDefinition {
  key: keyof FluidFireParameters;
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number;
}

const simulationRanges: RangeDefinition[] = [
  { key: 'buoyancy', label: 'Buoyancy', min: 0, max: 50, step: 0.5, digits: 1 },
  { key: 'vorticity', label: 'Vorticity', min: 0, max: 40, step: 0.5, digits: 1 },
  { key: 'dissipation', label: 'Dissipation', min: 0.94, max: 1, step: 0.001, digits: 3 },
  { key: 'cooling', label: 'Cooling', min: 0.94, max: 1, step: 0.001, digits: 3 },
  { key: 'pressureIterations', label: 'Pressure steps', min: 4, max: 32, step: 1, digits: 0 },
];

const sourceRanges: RangeDefinition[] = [
  { key: 'injectionRadius', label: 'Source radius', min: 0.025, max: 0.16, step: 0.005, digits: 3 },
  { key: 'injectionDensity', label: 'Density', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'injectionTemperature', label: 'Temperature', min: 0, max: 2, step: 0.05, digits: 2 },
  { key: 'velocityStrength', label: 'Source velocity', min: 0, max: 60, step: 1, digits: 0 },
  { key: 'pointerStrength', label: 'Pointer force', min: 0, max: 3, step: 0.05, digits: 2 },
  { key: 'particleSize', label: 'Sprite size', min: 0.04, max: 0.25, step: 0.005, digits: 3 },
  { key: 'renderFraction', label: 'Render fraction', min: 0.15, max: 1, step: 0.01, digits: 2 },
  { key: 'softDepthDistance', label: 'Soft depth', min: 0.02, max: 1, step: 0.01, digits: 2 },
];

export class BenchmarkUI {
  private readonly root: HTMLElement;
  private readonly callbacks: BenchmarkUICallbacks;
  private fire: FluidFire;
  private paused = false;
  private readonly values = new Map<keyof FluidFireParameters, HTMLOutputElement>();
  private readonly inputs = new Map<keyof FluidFireParameters, HTMLInputElement>();
  private readonly metricElements: Record<string, HTMLElement>;
  private readonly resolutionSelect: HTMLSelectElement;
  private readonly particlesSelect: HTMLSelectElement;
  private readonly materialPresetSelect: HTMLSelectElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly groundVolumeToggle: HTMLInputElement;

  constructor(
    fire: FluidFire,
    settings: BenchmarkSettings,
    adapterName: string,
    callbacks: BenchmarkUICallbacks,
  ) {
    this.fire = fire;
    this.callbacks = callbacks;
    this.root = document.createElement('div');
    this.root.className = 'benchmark-ui';
    this.root.innerHTML = `
      <header class="hero">
        <p class="eyebrow"><span></span> WEBGPU COMPUTE LAB</p>
        <h1>Ground<br><em>Flow</em></h1>
        <p class="lede">A player-centred 2D flow field driving a shallow landscape volume.</p>
        <p class="gesture"><span>↗</span> Click: blast, then mist residue. Drag fog. W/A/S/D moves.</p>
      </header>

      <section class="metrics" aria-label="Live benchmark metrics">
        <div><strong data-metric="fps">—</strong><span>FPS</span></div>
        <div><strong data-metric="cpu">—</strong><span>CPU FRAME</span></div>
        <div><strong data-metric="compute">—</strong><span>GPU COMPUTE</span></div>
        <div><strong data-metric="render">—</strong><span>GPU RENDER</span></div>
        <p><span class="live-dot"></span><span data-metric="state">WARMING UP</span></p>
        <p class="adapter" title="${adapterName}">${adapterName}</p>
      </section>

      <aside class="control-panel">
        <div class="panel-heading">
          <div><span>BENCHMARK 01</span><h2>Ground flow</h2></div>
          <button type="button" data-action="pause">Pause</button>
        </div>
        <div class="select-grid">
          <label>Resolution<select data-select="resolution"></select></label>
          <label>Particles<select data-select="particles"></select></label>
          <label>Isolated material<select data-select="material-preset"></select></label>
        </div>
        <div data-controls="simulation"></div>
        <div data-controls="source"></div>
        <label class="toggle-row">
          <span><b>Ground effects</b><small>surfaces, vegetation and mist</small></span>
          <input data-toggle="ground-volume" type="checkbox"><i></i>
        </label>
        <div class="budget">
          <div><span>COMPUTE PASSES</span><strong data-metric="dispatches">—</strong></div>
          <div><span>EST. GPU DATA</span><strong data-metric="memory">—</strong></div>
        </div>
        <button class="reset" type="button" data-action="reset">Reset simulation</button>
      </aside>
    `;
    document.body.appendChild(this.root);

    this.metricElements = {
      fps: this.required('[data-metric="fps"]'),
      cpu: this.required('[data-metric="cpu"]'),
      compute: this.required('[data-metric="compute"]'),
      render: this.required('[data-metric="render"]'),
      state: this.required('[data-metric="state"]'),
      dispatches: this.required('[data-metric="dispatches"]'),
      memory: this.required('[data-metric="memory"]'),
    };

    this.resolutionSelect = this.required<HTMLSelectElement>('[data-select="resolution"]');
    this.particlesSelect = this.required<HTMLSelectElement>('[data-select="particles"]');
    this.materialPresetSelect = this.required<HTMLSelectElement>('[data-select="material-preset"]');
    this.pauseButton = this.required<HTMLButtonElement>('[data-action="pause"]');
    this.groundVolumeToggle = this.required<HTMLInputElement>('[data-toggle="ground-volume"]');

    this.populateSelect(this.resolutionSelect, [160, 256, 384, 512], settings.resolution, (value) => `${value}²`);
    this.populateSelect(
      this.particlesSelect,
      [50_000, 75_000, 100_000, 150_000],
      settings.particleCount,
      (value) => `${value / 1000}K`,
    );
    for (const preset of ['fog', 'sand', 'snow', 'grass'] as const) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = preset[0]!.toUpperCase() + preset.slice(1);
      this.materialPresetSelect.appendChild(option);
    }

    this.makeRangeGroup('SIMULATION', simulationRanges, '[data-controls="simulation"]');
    this.makeRangeGroup('FLOW + VOLUME', sourceRanges, '[data-controls="source"]');
    this.bindEvents();
  }

  setFire(fire: FluidFire): void {
    this.fire = fire;
    for (const [key, input] of this.inputs) {
      input.value = String(this.fire.parameters[key]);
      this.updateRangeOutput(key, Number(input.value));
    }
    this.groundVolumeToggle.checked = this.fire.parameters.groundVolume;
  }

  update(metrics: BenchmarkMetrics): void {
    this.metricElements.fps!.textContent = metrics.fps.toFixed(0);
    this.metricElements.cpu!.textContent = `${metrics.cpuMs.toFixed(2)} ms`;
    this.metricElements.compute!.textContent = metrics.computeGpuMs === undefined
      ? 'n/a'
      : `${metrics.computeGpuMs.toFixed(2)} ms`;
    this.metricElements.render!.textContent = metrics.renderGpuMs === undefined
      ? 'n/a'
      : `${metrics.renderGpuMs.toFixed(2)} ms`;
    this.metricElements.dispatches!.textContent = String(metrics.dispatches);
    this.metricElements.memory!.textContent = `${metrics.memoryMb.toFixed(1)} MB`;
    this.metricElements.state!.textContent = this.paused ? 'PAUSED' : 'LIVE';
  }

  private required<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }

  private populateSelect(
    select: HTMLSelectElement,
    values: number[],
    selected: number,
    label: (value: number) => string,
  ): void {
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label(value);
      option.selected = value === selected;
      select.appendChild(option);
    }
  }

  private makeRangeGroup(title: string, definitions: RangeDefinition[], selector: string): void {
    const host = this.required(selector);
    const heading = document.createElement('h3');
    heading.textContent = title;
    host.appendChild(heading);

    for (const definition of definitions) {
      const row = document.createElement('label');
      row.className = 'range-row';
      const label = document.createElement('span');
      label.textContent = definition.label;
      const output = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(definition.min);
      input.max = String(definition.max);
      input.step = String(definition.step);
      input.value = String(this.fire.parameters[definition.key]);
      input.dataset.key = definition.key;
      input.dataset.digits = String(definition.digits);
      row.append(label, output, input);
      host.appendChild(row);
      this.values.set(definition.key, output);
      this.inputs.set(definition.key, input);
      this.updateRangeOutput(definition.key, Number(input.value));
    }
  }

  private updateRangeOutput(key: keyof FluidFireParameters, value: number): void {
    const input = this.inputs.get(key);
    const output = this.values.get(key);
    if (!input || !output) return;
    output.value = value.toFixed(Number(input.dataset.digits ?? 2));
  }

  private bindEvents(): void {
    for (const [key, input] of this.inputs) {
      input.addEventListener('input', () => {
        const value = Number(input.value);
        (this.fire.parameters[key] as number | boolean) = value;
        this.updateRangeOutput(key, value);
      });
    }

    const rebuild = () => {
      this.callbacks.onRebuild({
        resolution: Number(this.resolutionSelect.value),
        particleCount: Number(this.particlesSelect.value),
      });
    };
    this.resolutionSelect.addEventListener('change', rebuild);
    this.particlesSelect.addEventListener('change', rebuild);
    this.materialPresetSelect.addEventListener('change', () => {
      this.callbacks.onMaterialPresetChange(this.materialPresetSelect.value as GroundFlowMaterialPreset);
    });
    this.required<HTMLButtonElement>('[data-action="reset"]').addEventListener('click', rebuild);

    this.pauseButton.addEventListener('click', () => {
      this.paused = !this.paused;
      this.pauseButton.textContent = this.paused ? 'Resume' : 'Pause';
      this.callbacks.onPauseChange(this.paused);
    });

    this.groundVolumeToggle.addEventListener('change', () => {
      this.fire.parameters.groundVolume = this.groundVolumeToggle.checked;
    });
  }
}
