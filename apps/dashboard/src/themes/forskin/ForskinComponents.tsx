import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { forskinAssets } from "./forskinAssets";
import { forskinCopy } from "./forskinCopy";
import { THEME_MODES, useForskinTheme, type ThemeMode } from "./forskinTheme";

const warnedAssetUrls = new Set<string>();

const frameSlices = {
  thin: "10%",
  medium: "15%",
  heavy: "19%",
  active: "12%",
  error: "12%",
} as const;

function isDevelopment(): boolean {
  return Boolean(
    (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV,
  );
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

export type ForskinAssetProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "alt"
> & {
  src: string;
  alt: string;
};

export function ForskinAsset({
  src,
  alt,
  className,
  onError,
  onLoad,
  ...props
}: ForskinAssetProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === src;

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    setFailedUrl(src);
    if (isDevelopment() && !warnedAssetUrls.has(src)) {
      warnedAssetUrls.add(src);
      console.warn(`[ForskinAsset] Kunne ikke indlæse ${src}`);
    }
    onError?.(event);
  };

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    setFailedUrl(null);
    onLoad?.(event);
  };

  return (
    <img
      {...props}
      className={joinClassNames("forskin-asset", className)}
      src={src}
      alt={alt}
      hidden={failed}
      aria-hidden={failed || undefined}
      onError={handleError}
      onLoad={handleLoad}
    />
  );
}

export function ForskinFrame({
  className,
  children,
  style,
  variant = "thin",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "thin" | "medium" | "heavy" | "active" | "error";
}) {
  const frame = forskinAssets.frames[variant];
  return (
    <div
      {...props}
      className={joinClassNames("forskin-frame", className)}
      style={
        {
          ...style,
          "--forskin-frame-image": `url("${frame}")`,
          "--forskin-frame-slice": frameSlices[variant],
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function ForskinLogo({
  className,
  alt = forskinCopy.brand,
  ...props
}: Omit<ForskinAssetProps, "src" | "alt"> & {
  alt?: string;
}) {
  return (
    <ForskinAsset
      {...props}
      className={joinClassNames("forskin-logo", className)}
      src={forskinAssets.logo}
      alt={alt}
    />
  );
}

export type ForskinPlaqueProps = HTMLAttributes<HTMLDivElement> & {
  decorative?: boolean;
  variant?: keyof typeof forskinAssets.plaques;
};

export function ForskinPlaque({
  className,
  children,
  decorative = children === undefined,
  variant = "rustedSmall",
  ...props
}: ForskinPlaqueProps) {
  return (
    <div
      {...props}
      className={joinClassNames(
        "forskin-plaque",
        decorative ? "forskin-decorative-copy" : undefined,
        className,
      )}
      aria-hidden={decorative || undefined}
    >
      <ForskinAsset
        className="forskin-plaque-art"
        src={forskinAssets.plaques[variant]}
        alt=""
        loading="lazy"
      />
      <span>{children ?? forskinCopy.decorative.plaque}</span>
    </div>
  );
}

export function ForskinOrnamentsLayer({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const { mode } = useForskinTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (mode !== "forskin-hella") return;

    const compactViewport = window.matchMedia("(max-width: 1200px)");
    const connection = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      }
    ).connection;
    const constrainedConnection =
      connection?.saveData === true ||
      connection?.effectiveType === "slow-2g" ||
      connection?.effectiveType === "2g";
    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    };
    let idleHandle: number | undefined;
    let timerHandle: number | undefined;

    const cancelPending = () => {
      if (idleHandle !== undefined) {
        idleWindow.cancelIdleCallback?.(idleHandle);
        idleHandle = undefined;
      }
      if (timerHandle !== undefined) {
        window.clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    };
    const schedule = () => {
      cancelPending();
      setReady(false);
      if (compactViewport.matches || constrainedConnection) return;
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(() => setReady(true), {
          timeout: 800,
        });
      } else {
        timerHandle = window.setTimeout(() => setReady(true), 120);
      }
    };

    schedule();
    compactViewport.addEventListener("change", schedule);
    return () => {
      compactViewport.removeEventListener("change", schedule);
      cancelPending();
    };
  }, [mode]);

  if (mode !== "forskin-hella" || !ready) return null;

  return (
    <div
      {...props}
      className={joinClassNames("forskin-ornaments forskin-ambient", className)}
      aria-hidden="true"
    >
      <ForskinAsset
        className="forskin-ambient-piece forskin-tendril-left"
        src={forskinAssets.ornaments.tendrilLeft}
        alt=""
        loading="lazy"
      />
      <ForskinAsset
        className="forskin-ambient-piece forskin-chain-corner"
        src={forskinAssets.ornaments.chainCorner}
        alt=""
        loading="lazy"
      />
      <ForskinAsset
        className="forskin-ambient-piece forskin-tendril-right"
        src={forskinAssets.ornaments.tendrilRight}
        alt=""
        loading="lazy"
      />
      <ForskinAsset
        className="forskin-ambient-piece forskin-shell-medallion"
        src={forskinAssets.ornaments.medallion}
        alt=""
        loading="lazy"
      />
      <div className="forskin-hero-emblem">
        <ForskinAsset
          className="forskin-hero-crown"
          src={forskinAssets.ornaments.crown}
          alt=""
          loading="lazy"
        />
        <span className="forskin-hero-seal">
          <ForskinLogo alt="" aria-hidden="true" />
          <strong>FGP</strong>
        </span>
        <b>
          FORHUDSGANG
          <br />
          PRODUCTIONS
        </b>
      </div>
      <ForskinAsset
        className="forskin-ambient-piece forskin-smoke-overlay"
        src={forskinAssets.textures.smoke}
        alt=""
        loading="lazy"
      />
      <ForskinAsset
        className="forskin-ambient-piece forskin-sparks-overlay"
        src={forskinAssets.textures.sparks}
        alt=""
        loading="lazy"
      />
      <div className="forskin-mug-ornament">
        <ForskinAsset src={forskinAssets.ornaments.mug} alt="" loading="lazy" />
        <span className="forskin-decorative-copy">{forskinCopy.mug}</span>
      </div>
    </div>
  );
}

export type ForskinProgressBarProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  value: number;
  max?: number;
  label?: string;
  showValue?: boolean;
};

export function ForskinProgressBar({
  value,
  max = 100,
  label = forskinCopy.progressLabel,
  showValue = false,
  className,
  style,
  ...props
}: ForskinProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value)
    ? Math.min(Math.max(value, 0), safeMax)
    : 0;
  const percentage = (safeValue / safeMax) * 100;

  return (
    <div className={joinClassNames("forskin-progress-wrap", className)}>
      {showValue && (
        <span className="forskin-progress-value">
          {Math.round(percentage)}%
        </span>
      )}
      <div
        {...props}
        className="forskin-progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
        style={{
          backgroundImage: `url("${forskinAssets.frames.progressTrack}")`,
          ...style,
        }}
      >
        <span
          style={{
            width: `${percentage}%`,
            backgroundImage: `url("${forskinAssets.frames.progressFill}")`,
          }}
        />
      </div>
    </div>
  );
}

export function ForskinThemeToggle({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const { mode, setMode } = useForskinTheme();
  return (
    <div
      {...props}
      className={joinClassNames("forskin-theme-toggle", className)}
      role="group"
      aria-label={forskinCopy.modeGroupLabel}
    >
      {THEME_MODES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={candidate === mode}
          onClick={() => setMode(candidate)}
        >
          {forskinCopy.modeLabels[candidate]}
        </button>
      ))}
    </div>
  );
}

export function ForskinQuickToggle({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { mode, setMode } = useForskinTheme();
  const currentIndex = THEME_MODES.indexOf(mode);
  const nextMode =
    THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? "default";
  const label = `Theme: ${forskinCopy.modeLabels[mode]}. Switch to ${forskinCopy.modeLabels[nextMode]}`;

  return (
    <button
      {...props}
      type="button"
      className={joinClassNames(
        "identity-action forskin-quick-toggle",
        className,
      )}
      aria-label={label}
      aria-pressed={mode !== "default"}
      title={label}
      onClick={(event) => {
        setMode(nextMode);
        props.onClick?.(event);
      }}
    >
      <ForskinAsset src={forskinAssets.miniMark} alt="" aria-hidden="true" />
      <span>Theme</span>
    </button>
  );
}

export function ForskinThemeSettings({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "children">) {
  const titleId = useId();
  const { decorativeCopy, ambientMotion, setDecorativeCopy, setAmbientMotion } =
    useForskinTheme();

  return (
    <section
      {...props}
      className={joinClassNames("forskin-theme-settings", className)}
      aria-labelledby={titleId}
    >
      <h3 id={titleId}>{forskinCopy.settingsTitle}</h3>
      <ForskinThemeToggle />
      <label>
        <input
          type="checkbox"
          checked={decorativeCopy}
          onChange={(event) => setDecorativeCopy(event.currentTarget.checked)}
        />
        <span>{forskinCopy.decorativeCopyLabel}</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={ambientMotion}
          onChange={(event) => setAmbientMotion(event.currentTarget.checked)}
        />
        <span>{forskinCopy.ambientMotionLabel}</span>
      </label>
      <ForskinThemePreview />
    </section>
  );
}

export type ForskinThemePreviewProps = Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> & {
  mode?: ThemeMode;
  title?: ReactNode;
};

export function ForskinThemePreview({
  mode,
  title = forskinCopy.previewTitle,
  className,
  ...props
}: ForskinThemePreviewProps) {
  const preferences = useForskinTheme();
  const previewMode = mode ?? preferences.mode;

  return (
    <article
      {...props}
      className={joinClassNames("forskin-preview", className)}
      data-theme={previewMode}
      data-forskin-copy={preferences.decorativeCopy ? "on" : "off"}
      data-forskin-motion={preferences.ambientMotion ? "on" : "off"}
    >
      <ForskinFrame>
        <header>
          <ForskinLogo />
          <div>
            <strong>{title}</strong>
            <span>{forskinCopy.modeLabels[previewMode]}</span>
          </div>
        </header>
        <ForskinProgressBar value={68} showValue />
        <p className="forskin-decorative-copy" aria-hidden="true">
          {forskinCopy.decorative.preview}
        </p>
      </ForskinFrame>
    </article>
  );
}
