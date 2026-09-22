/** Process RSS includes the training worker; phase times include DB hydration and worker transfer. */
export class TrainingMeasurement {
  private readonly started = performance.now();
  private previous = this.started;
  private maxRss = process.memoryUsage().rss;
  private readonly phases: Record<string, number> = {};
  private readonly timer = setInterval(() => this.sample(), 100);
  public mark(phase: "read" | "fit" | "save"): void {
    const now = performance.now();
    this.phases[phase] = now - this.previous;
    this.previous = now;
    this.sample();
  }
  private sample(): void {
    this.maxRss = Math.max(this.maxRss, process.memoryUsage().rss);
  }
  public report() {
    this.sample();
    return {
      elapsedMs: performance.now() - this.started,
      phasesMs: { ...this.phases },
      maxSampledRssBytes: this.maxRss,
      rssSamplingIntervalMs: 100,
    };
  }
  public close(): void {
    clearInterval(this.timer);
  }
}
