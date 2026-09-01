export type ScannerPerformanceSample = {
  status: string;
  durationMs: number;
  httpStatus?: number | null;
  failureReason?: string | null;
};

export type AdaptiveConcurrencySnapshot = {
  enabled: boolean;
  configuredConcurrency: number;
  currentConcurrency: number;
  minimumConcurrency: number;
  totalCompleted: number;
  successful: number;
  pressureEvents: number;
  rateLimited: number;
  timeoutEvents: number;
  serverErrors: number;
  averageDurationMs: number;
  throughputPerMinute: number;
  lastAdjustmentReason: string;
  lastAdjustmentAt?: string;
};

export type ScannerRecentPerformance = {
  sampleSize: number;
  medianDurationMs: number;
  p95DurationMs: number;
  successRate: number;
};

export class AdaptiveConcurrencyController {
  private currentConcurrency: number;
  private readonly minimumConcurrency: number;
  private totalCompleted = 0;
  private successful = 0;
  private pressureEvents = 0;
  private rateLimited = 0;
  private timeoutEvents = 0;
  private serverErrors = 0;
  private totalDurationMs = 0;
  private healthyStreak = 0;
  private readonly pressureWindow: boolean[] = [];
  private readonly recentSamples: Array<{
    durationMs: number;
    succeeded: boolean;
  }> = [];
  private lastAdjustmentReason = "Running at configured concurrency";
  private lastAdjustmentAt?: string;
  private readonly startedAt: number;
  private stoppedAt?: number;

  constructor(
    private readonly configuredConcurrency: number,
    private readonly enabled = true,
    private readonly now: () => number = Date.now,
  ) {
    const boundedConfigured = Math.max(
      1,
      Math.min(32, Math.trunc(configuredConcurrency)),
    );
    // A cold worker has no evidence that the current network, DNS resolver, or
    // target mix can sustain the configured ceiling. Ramp from a bounded probe
    // instead of releasing all 32 requests at once and reacting only after a
    // timeout wave has already formed.
    this.currentConcurrency = enabled
      ? Math.min(8, boundedConfigured)
      : boundedConfigured;
    this.minimumConcurrency =
      this.currentConcurrency === 1 ? 1 : Math.min(2, this.currentConcurrency);
    this.startedAt = this.now();
  }

  allowsWorker(workerIndex: number) {
    return workerIndex < this.currentConcurrency;
  }

  record(sample: ScannerPerformanceSample) {
    const previous = this.currentConcurrency;
    const reason = String(sample.failureReason || "").toUpperCase();
    const rateLimited = sample.httpStatus === 429 || reason.includes("429");
    const timedOut =
      sample.status === "Timeout" ||
      reason.includes("TIMEOUT") ||
      reason.includes("TIMED_OUT");
    const serverError =
      (sample.httpStatus != null &&
        sample.httpStatus >= 500 &&
        sample.httpStatus <= 599) ||
      reason.includes("HTTP_5XX") ||
      /HTTP_5\d\d/.test(reason) ||
      reason.includes("SERVER_ERROR") ||
      reason.includes("SCRAPER_BUSY") ||
      reason.includes("SCRAPER_OFFLINE") ||
      reason.includes("SCRAPER_ERROR");
    const internalPressure =
      reason.includes("SCRAPER_BUSY") ||
      reason.includes("SCRAPER_OFFLINE") ||
      reason.includes("SCRAPER_TIMEOUT") ||
      reason.includes("SCRAPER_ERROR");
    const succeeded = [
      "Completed",
      "CompletedWithFallback",
      "CompletedWithWarnings",
    ].includes(sample.status);

    this.totalCompleted += 1;
    this.totalDurationMs += Math.max(0, sample.durationMs || 0);
    this.recentSamples.push({
      durationMs: Math.max(0, sample.durationMs || 0),
      succeeded,
    });
    if (this.recentSamples.length > 500) this.recentSamples.shift();
    if (succeeded) this.successful += 1;
    if (rateLimited) this.rateLimited += 1;
    if (timedOut) this.timeoutEvents += 1;
    if (serverError) this.serverErrors += 1;
    const pressured = rateLimited || timedOut || serverError;
    this.pressureWindow.push(pressured);
    if (this.pressureWindow.length > 20) this.pressureWindow.shift();

    if (!this.enabled) return false;

    if (pressured) {
      this.pressureEvents += 1;
      this.healthyStreak = 0;
      const pressureCount = this.pressureWindow.filter(Boolean).length;
      const sustainedPressure =
        this.pressureWindow.length >= 8 &&
        pressureCount / this.pressureWindow.length >= 0.5;
      if (internalPressure || sustainedPressure) {
        const reduction = Math.max(
          1,
          Math.ceil(this.currentConcurrency * 0.25),
        );
        this.adjust(
          Math.max(
            this.minimumConcurrency,
            this.currentConcurrency - reduction,
          ),
          internalPressure
            ? "Local scraper pressure; concurrency reduced immediately"
            : "Sustained remote-site pressure; concurrency reduced",
        );
        this.pressureWindow.length = 0;
      }
    } else if (succeeded) {
      this.healthyStreak += 1;
      const recoveryThreshold = Math.max(4, this.currentConcurrency);
      if (
        this.currentConcurrency < this.configuredConcurrency &&
        this.healthyStreak >= recoveryThreshold
      ) {
        this.adjust(
          this.currentConcurrency + 1,
          "Sustained healthy scans; concurrency increased",
        );
        this.healthyStreak = 0;
      }
    } else {
      this.healthyStreak = 0;
    }

    return previous !== this.currentConcurrency;
  }

  stop() {
    this.stoppedAt = this.now();
  }

  snapshot(): AdaptiveConcurrencySnapshot {
    const elapsedMs = Math.max(
      1,
      (this.stoppedAt || this.now()) - this.startedAt,
    );
    return {
      enabled: this.enabled,
      configuredConcurrency: this.configuredConcurrency,
      currentConcurrency: this.currentConcurrency,
      minimumConcurrency: this.minimumConcurrency,
      totalCompleted: this.totalCompleted,
      successful: this.successful,
      pressureEvents: this.pressureEvents,
      rateLimited: this.rateLimited,
      timeoutEvents: this.timeoutEvents,
      serverErrors: this.serverErrors,
      averageDurationMs: this.totalCompleted
        ? Math.round(this.totalDurationMs / this.totalCompleted)
        : 0,
      throughputPerMinute: Number(
        ((this.totalCompleted * 60_000) / elapsedMs).toFixed(1),
      ),
      lastAdjustmentReason: this.lastAdjustmentReason,
      lastAdjustmentAt: this.lastAdjustmentAt,
    };
  }

  recentSnapshot(): ScannerRecentPerformance {
    const durations = this.recentSamples
      .map((sample) => sample.durationMs)
      .filter((duration) => duration > 0)
      .sort((left, right) => left - right);
    const percentile = (fraction: number) =>
      durations.length
        ? durations[
            Math.min(
              durations.length - 1,
              Math.max(0, Math.ceil(durations.length * fraction) - 1),
            )
          ] || 0
        : 0;
    const successful = this.recentSamples.filter(
      (sample) => sample.succeeded,
    ).length;
    return {
      sampleSize: this.recentSamples.length,
      medianDurationMs: percentile(0.5),
      p95DurationMs: percentile(0.95),
      successRate: this.recentSamples.length
        ? Number(((successful / this.recentSamples.length) * 100).toFixed(1))
        : 0,
    };
  }

  private adjust(next: number, reason: string) {
    const bounded = Math.max(
      this.minimumConcurrency,
      Math.min(this.configuredConcurrency, Math.trunc(next)),
    );
    if (bounded === this.currentConcurrency) return;
    this.currentConcurrency = bounded;
    this.lastAdjustmentReason = reason;
    this.lastAdjustmentAt = new Date(this.now()).toISOString();
  }
}
